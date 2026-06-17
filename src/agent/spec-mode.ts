/**
 * Spec Mode Persistence System
 *
 * Spec Mode is a planning/research role for the agent, distinct from plan-mode.
 * Where plan-mode is a guardrail ("don't edit until I approve"), spec-mode is
 * a role: the agent produces a reviewable specification document, optionally
 * using a different model and reasoning effort, persisted to disk so it can
 * be handed off to an implementation phase (or to a different agent/human).
 *
 * ## Layout
 *
 * ```
 * ~/.maestro/spec-state.json       # Tracks the currently active spec globally
 * project/.maestro/specs/<slug>/   # One directory per spec
 *   ├── spec.md                    # The spec body (markdown)
 *   ├── references/                # (optional) raw research material
 *   └── decisions.md               # (optional) alternatives + rationale
 * ```
 *
 * ## Lifecycle
 *
 *   pending -> approved -> (handoff to implementation)
 *           \-> archived
 *
 * `enterSpecMode` creates a pending spec. `approveSpecMode` flips it to
 * approved (the spec body is now durable acceptance criteria). `exitSpecMode`
 * archives without approving.
 *
 * ## What this module is and isn't
 *
 * This module owns persistence and state transitions only. Tool locking,
 * model override at the request layer, and the `/spec` slash command live in
 * follow-up PRs that consume the primitives defined here.
 *
 * ## Environment Variables
 *
 * - `MAESTRO_SPEC_DIR`: Override the project-local specs directory.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	unlinkSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { PATHS } from "../config/constants.js";
import { writeTextFileAtomic } from "../utils/fs.js";
import { createLogger } from "../utils/logger.js";
import { resolveEnvPath } from "../utils/path-expansion.js";

const logger = createLogger("spec-mode");

const STATE_FILE_VERSION = 1;

/** Lifecycle states for a tracked spec. */
export type SpecModeStatus = "pending" | "approved" | "archived";

/**
 * Persistent state for the currently tracked spec.
 *
 * Only one spec is "active" at a time (status === "pending" | "approved").
 * Archived specs remain on disk for reference.
 */
export interface SpecModeState {
	/** Schema version for forward-compatible migrations. */
	version: number;
	/** Lifecycle status. */
	status: SpecModeStatus;
	/** Stable directory-safe identifier. */
	slug: string;
	/** Absolute path to the spec directory. */
	specDir: string;
	/** Absolute path to spec.md inside specDir. */
	specFilePath: string;
	/** Session that owns the spec (for multi-session correlation). */
	sessionId?: string;
	/** Git branch at spec creation. */
	gitBranch?: string;
	/** Git commit SHA at spec creation. */
	gitCommitSha?: string;
	/**
	 * Model the user configured for spec work — recorded so reviewers can see
	 * which model authored the spec. Set at enterSpecMode.
	 */
	modelId?: string;
	/** Reasoning effort recorded alongside modelId. */
	reasoningEffort?: string;
	/** ISO 8601 timestamp at first creation. */
	createdAt: string;
	/** ISO 8601 timestamp of the most recent state change. */
	updatedAt: string;
	/** ISO 8601 timestamp at approval. Absent until approved. */
	approvedAt?: string;
	/** Human-readable name. */
	name?: string;
}

export interface SpecModeConfig {
	/** Project-local specs directory (one subdirectory per spec). */
	specsDir: string;
	/** User-global state file path. */
	stateFile: string;
}

/** Lightweight spec summary for listing/UI. */
export interface SpecSummary {
	slug: string;
	specDir: string;
	specFilePath: string;
	status: SpecModeStatus;
	name?: string;
	updatedAt: string;
}

const DEFAULT_SPECS_SUBDIR = ".maestro/specs";

/**
 * Resolve spec-mode paths from environment, falling back to project-local
 * defaults. The state file is always user-global so the active spec is
 * tracked the same way plan mode tracks the active plan.
 */
export function getSpecModeConfig(): SpecModeConfig {
	const specsDir =
		resolveEnvPath(process.env.MAESTRO_SPEC_DIR) ??
		join(process.cwd(), DEFAULT_SPECS_SUBDIR);
	const stateFile = join(PATHS.MAESTRO_HOME, "spec-state.json");
	return { specsDir, stateFile };
}

function ensureSpecsDir(config: SpecModeConfig): void {
	if (!existsSync(config.specsDir)) {
		mkdirSync(config.specsDir, { recursive: true });
	}
}

/**
 * Derive a filesystem-safe slug from a human-readable name. Falls back to a
 * timestamp-based identifier when no name is provided. Slugs are always
 * unique enough to avoid collisions between concurrent specs.
 */
export function generateSpecSlug(name?: string): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	if (!name) {
		return `spec-${timestamp}`;
	}
	const sanitized = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 50);
	if (!sanitized) {
		return `spec-${timestamp}`;
	}
	return `${sanitized}-${timestamp}`;
}

export function loadSpecModeState(
	config: SpecModeConfig = getSpecModeConfig(),
): SpecModeState | null {
	try {
		if (!existsSync(config.stateFile)) {
			return null;
		}
		const raw = readFileSync(config.stateFile, "utf-8");
		const parsed = JSON.parse(raw) as SpecModeState;
		return parsed;
	} catch (err) {
		logger.warn("Failed to load spec mode state", {
			reason: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

export function saveSpecModeState(
	state: SpecModeState,
	config: SpecModeConfig = getSpecModeConfig(),
): boolean {
	try {
		const dir = dirname(config.stateFile);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeTextFileAtomic(config.stateFile, JSON.stringify(state, null, 2));
		logger.info("Spec mode state saved", {
			slug: state.slug,
			status: state.status,
		});
		return true;
	} catch (err) {
		logger.error(
			"Failed to save spec mode state",
			err instanceof Error ? err : new Error(String(err)),
		);
		return false;
	}
}

function isValidSpecSlug(slug: string): boolean {
	return Boolean(slug) && slug !== "." && slug !== ".." && !/[\\/]/.test(slug);
}

/**
 * Rewrite the top-of-file heading + lifecycle metadata so a reused spec.md
 * reflects the newly tracked state without overwriting the authored body.
 */
function rewriteSpecMarkdownPreamble(
	body: string,
	state: Pick<
		SpecModeState,
		"name" | "status" | "createdAt" | "modelId" | "approvedAt"
	>,
): string {
	const heading = state.name ? `# Spec: ${state.name}` : "# Spec";
	const metadataLines = [
		`Status: ${state.status}`,
		`Created: ${state.createdAt}`,
		state.modelId ? `Model: ${state.modelId}` : null,
		state.approvedAt ? `Approved: ${state.approvedAt}` : null,
	].filter((line): line is string => line !== null);
	const lines = body.split("\n");
	let startIndex = 0;
	if (lines[0]?.startsWith("#")) {
		startIndex = 1;
	}
	while (lines[startIndex] === "") {
		startIndex += 1;
	}
	while (
		/^(Status|Created|Model|Approved):[^\n]*$/.test(lines[startIndex] ?? "")
	) {
		startIndex += 1;
	}
	while (lines[startIndex] === "") {
		startIndex += 1;
	}
	// Match the trailing-newline shape of the source body so callers don't
	// see drift on resumes that shouldn't have changed anything (e.g. the
	// fresh skeleton writer emits an extra trailing blank line).
	const bodyTrailingNewlines = body.match(/(\n*)$/)?.[1] ?? "";
	return [heading, "", ...metadataLines, "", ...lines.slice(startIndex)]
		.join("\n")
		.replace(/\n+$/, bodyTrailingNewlines || "\n");
}

function parseSpecMarkdownPreamble(
	body: string,
): Partial<
	Pick<
		SpecModeState,
		"name" | "status" | "createdAt" | "modelId" | "approvedAt"
	>
> {
	const parsed: Partial<
		Pick<
			SpecModeState,
			"name" | "status" | "createdAt" | "modelId" | "approvedAt"
		>
	> = {};
	const lines = body.split("\n");
	const headingMatch = lines[0]?.match(/^# Spec(?::\s*(.+))?$/);
	if (headingMatch) {
		parsed.name = headingMatch[1] || undefined;
	}
	let index = 1;
	while (lines[index] === "") {
		index += 1;
	}
	while (index < lines.length) {
		const metadataMatch = lines[index]?.match(
			/^(Status|Created|Model|Approved):\s*(.*)$/,
		);
		if (!metadataMatch) {
			break;
		}
		const [, label, rawValue] = metadataMatch;
		const value = (rawValue ?? "").trim();
		switch (label) {
			case "Status":
				if (
					value === "pending" ||
					value === "approved" ||
					value === "archived"
				) {
					parsed.status = value;
				}
				break;
			case "Created":
				if (value) {
					parsed.createdAt = value;
				}
				break;
			case "Model":
				if (value) {
					parsed.modelId = value;
				}
				break;
			case "Approved":
				if (value) {
					parsed.approvedAt = value;
				}
				break;
		}
		index += 1;
	}
	return parsed;
}

function syncSpecMarkdownPreamble(
	specFilePath: string,
	state: Pick<
		SpecModeState,
		"name" | "status" | "createdAt" | "modelId" | "approvedAt"
	>,
): boolean {
	if (!existsSync(specFilePath)) {
		return false;
	}
	let body: string;
	try {
		body = readFileSync(specFilePath, "utf-8");
	} catch (err) {
		logger.warn("Failed to read spec file during preamble sync", {
			reason: err instanceof Error ? err.message : String(err),
			specFilePath,
		});
		return false;
	}
	const rewritten = rewriteSpecMarkdownPreamble(body, state);
	if (rewritten === body) {
		return true;
	}
	try {
		writeTextFileAtomic(specFilePath, rewritten);
		return true;
	} catch (err) {
		logger.warn("Failed to update spec preamble during transition", {
			reason: err instanceof Error ? err.message : String(err),
			specFilePath,
		});
		return false;
	}
}

/**
 * Roll back a spec.md edit after a downstream save failure.
 *
 * `previousBody` is the body to restore. `existedBefore` records
 * whether the file was on disk before this call ran: when true, a
 * null `previousBody` means "we tried to read it but the read failed,
 * so keep the file intact" — never unlink an existing file the
 * current call did not create. When `existedBefore` is false and
 * `previousBody` is null, the current call created the file and we
 * unlink it.
 */
function rollbackSpecMarkdownTransition(
	specFilePath: string,
	previousBody: string | null,
	existedBefore: boolean,
): boolean {
	try {
		if (previousBody === null) {
			if (!existedBefore) {
				if (existsSync(specFilePath)) {
					unlinkSync(specFilePath);
				}
			}
			return true;
		}
		writeTextFileAtomic(specFilePath, previousBody);
		return true;
	} catch (err) {
		// A failed rollback is more serious than a failed state save:
		// the markdown is now mid-transition and state never persisted.
		// Surface a distinct error class so callers can decide whether
		// to bail loudly. The original throw at the call site still
		// fires, but the caller now knows the file is in an
		// inconsistent shape.
		logger.error(
			`Failed to roll back spec markdown after state save failure for ${specFilePath}`,
			err instanceof Error ? err : new Error(String(err)),
		);
		return false;
	}
}

function readSpecMarkdownStatus(
	specFilePath: string,
): SpecModeState["status"] | null {
	if (!existsSync(specFilePath)) {
		return null;
	}
	try {
		// Use the structured preamble parser so a body line like
		// "Status: archived means done" (acceptance criteria, examples,
		// quoted error text) never trips a false positive. The previous
		// regex match against `/m` would catch any line, blocking
		// slug-based tamper recovery on otherwise-legitimate specs.
		const parsed = parseSpecMarkdownPreamble(
			readFileSync(specFilePath, "utf-8"),
		);
		return parsed.status ?? null;
	} catch (err) {
		logger.warn("Failed to read spec file while checking archived status", {
			reason: err instanceof Error ? err.message : String(err),
			specFilePath,
		});
		return null;
	}
}

function shouldResumeExistingSpec(
	existing: SpecModeState,
	slug: string | undefined,
	config: SpecModeConfig,
): boolean {
	return (
		existing.status !== "archived" &&
		(slug === undefined || slug === existing.slug) &&
		isStateSpecPathSafe(existing, config)
	);
}

function getCanonicalSpecPaths(
	state: Pick<SpecModeState, "slug">,
	config: SpecModeConfig,
): { specDir: string; specFilePath: string } | null {
	if (!isValidSpecSlug(state.slug)) {
		return null;
	}
	const specDir = join(config.specsDir, state.slug);
	const specFilePath = join(specDir, "spec.md");
	if (
		!isPathWithinDirectory(specDir, config.specsDir) ||
		!isPathWithinDirectory(specFilePath, config.specsDir)
	) {
		return null;
	}
	return { specDir, specFilePath };
}

/**
 * Reject state entries whose tracked paths escape the configured specs
 * directory or disagree with the slug's canonical spec layout. The state file
 * lives outside the project tree and may be tampered with or stale from
 * another machine; resuming or reading from such a path would let arbitrary
 * file locations leak through `readCurrentSpec`/`getCurrentSpecPath`/status
 * sync helpers.
 */
function isStateSpecPathSafe(
	state: SpecModeState,
	config: SpecModeConfig,
): boolean {
	const canonicalPaths = getCanonicalSpecPaths(state, config);
	if (!canonicalPaths) {
		logger.warn("Tracked spec slug cannot resolve to a canonical spec path", {
			slug: state.slug,
		});
		return false;
	}
	if (!isPathWithinDirectory(state.specDir, config.specsDir)) {
		logger.warn("Tracked spec dir escapes specs directory; ignoring", {
			slug: state.slug,
			specDir: state.specDir,
		});
		return false;
	}
	if (!isPathWithinDirectory(state.specFilePath, config.specsDir)) {
		logger.warn("Tracked spec file escapes specs directory; ignoring", {
			slug: state.slug,
			specFilePath: state.specFilePath,
		});
		return false;
	}
	if (
		resolve(state.specDir) !== resolve(canonicalPaths.specDir) ||
		resolve(state.specFilePath) !== resolve(canonicalPaths.specFilePath)
	) {
		logger.warn("Tracked spec paths do not match the slug's canonical layout", {
			slug: state.slug,
			specDir: state.specDir,
			specFilePath: state.specFilePath,
			canonicalSpecDir: canonicalPaths.specDir,
			canonicalSpecFilePath: canonicalPaths.specFilePath,
		});
		return false;
	}
	return true;
}

function getCanonicalSpecFilePath(
	state: Pick<SpecModeState, "slug">,
	config: SpecModeConfig,
): string | null {
	const canonicalPaths = getCanonicalSpecPaths(state, config);
	return canonicalPaths?.specFilePath ?? null;
}

function getSpecFilePathForLifecycleSync(
	state: SpecModeState,
	config: SpecModeConfig,
): string | null {
	if (isStateSpecPathSafe(state, config)) {
		return state.specFilePath;
	}
	const canonicalPath = getCanonicalSpecFilePath(state, config);
	if (!canonicalPath) return null;
	// Bugbot's "stale state archives wrong spec" concern: when
	// spec-state.json carries a slug from another project (because
	// MAESTRO_SPEC_DIR moved or the state file was copied between
	// repos), the canonical resolution falls back to *this* repo's
	// `specsDir/<slug>/spec.md`, which may belong to an unrelated
	// local spec that just happens to share the slug. Detect that by
	// reading the existing preamble — if its `Created` doesn't match
	// our tracked spec's, the on-disk file isn't ours and we must not
	// overwrite its status line.
	if (!isOnDiskSpecOurs(canonicalPath, state)) {
		logger.warn(
			"Refusing to sync lifecycle status onto unrelated on-disk spec",
			{
				slug: state.slug,
				canonicalPath,
				trackedCreatedAt: state.createdAt,
			},
		);
		return null;
	}
	return canonicalPath;
}

/**
 * Best-effort check that the spec.md at `specFilePath` was authored
 * by the same tracked entry as `state`. Reads only the preamble; if
 * the file doesn't exist yet (e.g. first lifecycle sync after a
 * slug-based takeover), treat it as ours so the sync can create it.
 */
function isOnDiskSpecOurs(specFilePath: string, state: SpecModeState): boolean {
	if (!existsSync(specFilePath)) return true;
	const body = tryReadSpecMarkdown(specFilePath, "lifecycle sync ownership");
	// A read error means we can't authenticate the on-disk file, but
	// we also can't prove it's NOT ours. Fail open so transient
	// permission errors / racy reads don't lock the user out of a
	// legitimate recovery; cross-project collisions still get caught
	// at the next layer (the `existsSync && !canReuseArchivedSpecFile`
	// throw in `enterSpecMode`) when no slug-matched tracked spec is
	// known. The case Bugbot worries about (mismatched createdAt with
	// a successful read) IS still caught below.
	if (body === null) return true;
	const parsed = parseSpecMarkdownPreamble(body);
	// `Created` is the strongest stable identifier we have on disk:
	// slug is in the path (so collisions are exactly the case we're
	// trying to catch), and Status / Approved / Model can all drift
	// with normal lifecycle changes. A missing `Created` line means
	// the file isn't a maestro-managed spec at all — refuse.
	if (!parsed.createdAt) return false;
	return parsed.createdAt === state.createdAt;
}

function loadSafeActiveSpecState(
	config: SpecModeConfig = getSpecModeConfig(),
): SpecModeState | null {
	const state = loadSpecModeState(config);
	if (!state || state.status === "archived") {
		return null;
	}
	if (!isStateSpecPathSafe(state, config)) {
		return null;
	}
	return state;
}

function loadTrustedSpecModeState(
	config: SpecModeConfig = getSpecModeConfig(),
): SpecModeState | null {
	const state = loadSpecModeState(config);
	if (!state) {
		return null;
	}
	return isStateSpecPathSafe(state, config) ? state : null;
}

/**
 * Rewrite the leading `Status: <value>` line in spec.md so the rendered
 * document matches state-tracked lifecycle. Best-effort: missing file or
 * unparseable body falls through without crashing the caller.
 */
function syncSpecMarkdownStatus(
	specFilePath: string,
	status: SpecModeStatus,
	extraLine?: { label: string; value: string },
): void {
	if (!existsSync(specFilePath)) {
		return;
	}
	let body: string;
	try {
		body = readFileSync(specFilePath, "utf-8");
	} catch (err) {
		logger.warn("Failed to read spec file during status sync", {
			reason: err instanceof Error ? err.message : String(err),
			specFilePath,
		});
		return;
	}
	// Operate on the structured preamble window only. Without this
	// scope, regex against the whole body would rewrite the first
	// `Status:` or `Approved:` line anywhere — including acceptance
	// criteria like "Status: archived means done" — and leave the
	// preamble out of sync with state.
	const split = splitPreamble(body);
	const statusLine = `Status: ${status}`;
	const statusPattern = /^Status:[^\n]*$/m;
	let preamble = split.preamble;
	if (statusPattern.test(preamble)) {
		preamble = preamble.replace(statusPattern, statusLine);
	} else {
		preamble = preamble.replace(/^(#[^\n]*\n)/, `$1\n${statusLine}\n`);
	}
	if (extraLine) {
		const extra = `${extraLine.label}: ${extraLine.value}`;
		const pattern = new RegExp(`^${extraLine.label}:[^\\n]*$`, "m");
		preamble = pattern.test(preamble)
			? preamble.replace(pattern, extra)
			: preamble.replace(statusLine, `${statusLine}\n${extra}`);
	}
	const rewritten = preamble + split.rest;
	if (rewritten === body) {
		return;
	}
	try {
		writeTextFileAtomic(specFilePath, rewritten);
	} catch (err) {
		logger.warn("Failed to update spec status during transition", {
			reason: err instanceof Error ? err.message : String(err),
			specFilePath,
		});
	}
}

/**
 * Split `body` into a leading preamble (heading + metadata lines)
 * and the rest. The preamble parser already knows where the metadata
 * ends; we use the same shape so the status sync, the approval line
 * rewrite, and the archive sync all operate on the same window.
 */
function splitPreamble(body: string): { preamble: string; rest: string } {
	const lines = body.split("\n");
	let index = 0;
	// Optional H1 heading.
	if (lines[index]?.startsWith("#")) {
		index += 1;
	}
	// Blank lines before metadata.
	while (lines[index] === "") {
		index += 1;
	}
	// Metadata block: `Status:` / `Created:` / `Model:` / `Approved:`.
	while (/^(Status|Created|Model|Approved):[^\n]*$/.test(lines[index] ?? "")) {
		index += 1;
	}
	// Include the trailing blank line that separates preamble from the
	// rest of the body, when present, so the rewrite doesn't collapse
	// it on rewrite.
	if (lines[index] === "") {
		index += 1;
	}
	const preamble = lines.slice(0, index).join("\n");
	const rest = lines.slice(index).join("\n");
	// `join` drops the separator after the last element, so we need
	// to add back the `\n` between preamble and rest when both are
	// non-empty.
	if (preamble.length > 0 && rest.length > 0) {
		return { preamble: `${preamble}\n`, rest };
	}
	return { preamble, rest };
}

function tryReadSpecMarkdown(
	specFilePath: string,
	context: "disk recovery" | "archived spec reuse" | "lifecycle sync ownership",
): string | null {
	try {
		return readFileSync(specFilePath, "utf-8");
	} catch (err) {
		logger.warn(`Failed to read spec file during ${context}`, {
			reason: err instanceof Error ? err.message : String(err),
			specFilePath,
		});
		return null;
	}
}

/**
 * Enter spec mode with a new spec, or resume the current pending spec.
 *
 * If a pending spec already exists and no explicit slug is given, the
 * existing spec is resumed (updatedAt bumped). To force a new spec while
 * one is pending, pass an explicit `slug` or archive the previous spec
 * first via `exitSpecMode`.
 */
export function enterSpecMode(options: {
	sessionId?: string;
	gitBranch?: string;
	gitCommitSha?: string;
	name?: string;
	slug?: string;
	modelId?: string;
	reasoningEffort?: string;
	config?: SpecModeConfig;
}): SpecModeState {
	const config = options.config ?? getSpecModeConfig();
	const now = new Date().toISOString();
	const currentState = loadSpecModeState(config);
	// `previousTrackedSpec` drives the late "archive previous on entry" step
	// below. We clear it in branches where we've already archived the prior
	// state ourselves so the late step doesn't fire twice (and, critically,
	// doesn't re-archive a spec.md path that the new spec just rewrote with
	// Status: pending).
	let previousTrackedSpec = currentState;
	let missingTrackedSpecState: SpecModeState | null = null;
	// Detect "approved spec with missing spec.md" BEFORE the resume
	// guard. Without this, a caller passing a *different* explicit slug
	// would skip both the resume branch and the missing-file branch and
	// the approved record would be silently overwritten.
	const currentStateIsRecoverableMissing =
		currentState !== null &&
		currentState.status !== "archived" &&
		isStateSpecPathSafe(currentState, config) &&
		!existsSync(currentState.specFilePath);
	if (
		currentState &&
		shouldResumeExistingSpec(currentState, options.slug, config)
	) {
		// If state claims an active spec but the file vanished (crash after
		// state save, manual delete, etc.), the markdown sync helpers would
		// no-op and status helpers would keep reporting pending/approved
		// while readCurrentSpec returns null. Detect the disagreement and
		// fall back to creating a fresh spec without finalizing any lifecycle
		// change until the replacement is durable.
		if (!existsSync(currentState.specFilePath)) {
			// Don't eagerly write `status: "archived"` to `spec-state.json`
			// here — if anything below throws (slug collision, save
			// failure) the state would stay archived even though the
			// caller never received a successful handoff to a new spec.
			// Instead, fall through to the create-new path; when it
			// succeeds, `saveSpecModeState(state, config)` further down
			// will overwrite the state in one atomic step. When it fails,
			// the state is unchanged from when the user called us, so the
			// next run sees the same "active spec with missing spec.md"
			// situation and can recover normally.
			logger.warn(
				"Detected spec.md missing on resume; will overwrite state when the replacement spec is durable",
				{
					slug: currentState.slug,
					specFilePath: currentState.specFilePath,
				},
			);
			missingTrackedSpecState = currentState;
			// The previous tracked spec no longer has a backing spec.md; skip
			// the late re-archive step that would otherwise stomp on the fresh
			// new spec we're about to create.
			previousTrackedSpec = null;
		} else {
			const resumedState: SpecModeState = {
				...currentState,
				updatedAt: now,
			};
			if (options.sessionId) {
				resumedState.sessionId = options.sessionId;
			}
			if (options.gitBranch) {
				resumedState.gitBranch = options.gitBranch;
			}
			if (options.gitCommitSha) {
				resumedState.gitCommitSha = options.gitCommitSha;
			}
			// Approved specs are durable acceptance criteria, so reviewer
			// attribution (modelId + reasoningEffort) recorded at original
			// entry must not be silently overwritten by a later resume —
			// the same guard already applies to `name`. Only honor the
			// caller's modelId / reasoningEffort when the spec is still
			// pending.
			if (currentState.status === "pending") {
				if (options.modelId) {
					resumedState.modelId = options.modelId;
				}
				if (options.reasoningEffort) {
					resumedState.reasoningEffort = options.reasoningEffort;
				}
				if (options.name && options.name !== currentState.name) {
					resumedState.name = options.name;
				}
			}
			if (!saveSpecModeState(resumedState, config)) {
				throw new Error(
					`Failed to persist spec mode state on resume for slug "${resumedState.slug}"`,
				);
			}
			// Reconcile the full spec.md preamble (heading, Status, Created,
			// Model, Approved) with the tracked lifecycle only after the state
			// transition is durable on disk.
			if (isStateSpecPathSafe(resumedState, config)) {
				syncSpecMarkdownPreamble(resumedState.specFilePath, resumedState);
			}
			logger.info("Resumed existing spec", {
				slug: resumedState.slug,
				status: resumedState.status,
			});
			return resumedState;
		}
	}

	ensureSpecsDir(config);
	// When the caller doesn't specify a slug but the state machine is
	// recovering from a missing spec.md on a previously *approved*
	// tracked spec, reuse that slug. Approved specs are durable
	// acceptance criteria — silently letting a parameterless resume
	// synthesize a fresh timestamped slug would drop the approval the
	// user committed to. Pending specs aren't durable in the same way;
	// they get a fresh slug so the user can start over cleanly without
	// inheriting a half-written body.
	const recoverableApprovedSlug =
		missingTrackedSpecState?.status === "approved"
			? missingTrackedSpecState.slug
			: undefined;
	// Refuse to silently drop an approved spec when the caller asks
	// for a *different* explicit slug. The late archive step can't
	// rewrite Status: archived on a missing file, so the approved
	// record would disappear without leaving a trace. Force the
	// caller to either recover (drop the explicit slug, or pass the
	// approved one) or exit the approved spec first. Covers both the
	// case where the resume branch detected the missing file
	// (missingTrackedSpecState) and the case where the resume guard
	// rejected the slug mismatch and we never entered that branch
	// (currentStateIsRecoverableMissing).
	const approvedMissingSlug =
		missingTrackedSpecState?.status === "approved"
			? missingTrackedSpecState.slug
			: currentStateIsRecoverableMissing &&
					currentState !== null &&
					currentState.status === "approved"
				? currentState.slug
				: undefined;
	if (
		approvedMissingSlug !== undefined &&
		options.slug !== undefined &&
		options.slug !== approvedMissingSlug
	) {
		throw new Error(
			`Cannot start spec "${options.slug}" while approved spec "${approvedMissingSlug}" has a missing spec.md. Call enterSpecMode() with no slug (or with slug="${approvedMissingSlug}") to recover it, or run exitSpecMode() first to archive it.`,
		);
	}
	const slug =
		options.slug ?? recoverableApprovedSlug ?? generateSpecSlug(options.name);
	if (!isValidSpecSlug(slug)) {
		throw new Error(`Invalid spec slug: ${slug}`);
	}
	const specDir = join(config.specsDir, slug);
	if (!isPathWithinDirectory(specDir, config.specsDir)) {
		throw new Error(`Spec slug escapes specs directory: ${slug}`);
	}
	if (!existsSync(specDir)) {
		mkdirSync(specDir, { recursive: true });
	}
	const specFilePath = join(specDir, "spec.md");
	const specFileExists = existsSync(specFilePath);
	// Also allow takeover when the global state file is tampered/escaped
	// (isStateSpecPathSafe rejected resume) but the slug the caller asked
	// for still points to a real spec.md under the configured specs dir.
	// Without this, slug-based recovery would be blocked while only an
	// unrelated new name would let the user proceed.
	const stateIsUntrustworthy =
		previousTrackedSpec !== null &&
		!isStateSpecPathSafe(previousTrackedSpec, config);
	const existingSpecMarkdownStatus = readSpecMarkdownStatus(specFilePath);
	const archivedSpecFile = existingSpecMarkdownStatus === "archived";
	const unsafeTrackedSpecForSlugRecovery =
		stateIsUntrustworthy && previousTrackedSpec?.slug === slug
			? previousTrackedSpec
			: null;
	let shouldRecoverExistingSpecFromDisk =
		stateIsUntrustworthy &&
		specFileExists &&
		!archivedSpecFile &&
		// Disk-based recovery from an untrusted state file requires a
		// slug-matched tracked spec we can authenticate the on-disk file
		// against. Without one, an unrelated existing spec.md at the
		// requested slug would otherwise get rewritten (the collision
		// throw at line ~990 is bypassed when this flag is true). We
		// still defer the actual ownership check until after the recovery
		// read so unreadable-but-legitimate specs can fall back to the
		// tracked metadata instead of being downgraded to a collision.
		unsafeTrackedSpecForSlugRecovery !== null;
	const recoveredTrackedSpecState =
		missingTrackedSpecState?.slug === slug ? missingTrackedSpecState : null;
	const recoveredFallbackStatus: SpecModeState["status"] =
		existingSpecMarkdownStatus === "approved" ||
		(previousTrackedSpec?.slug === slug &&
			previousTrackedSpec.status === "approved")
			? "approved"
			: "pending";
	let previousSpecBody: string | null = null;
	// Wrap the recovery read defensively: other helpers in this module
	// degrade gracefully on read errors. If the file disappeared after
	// `specFileExists` succeeded, or the user revoked read permission
	// mid-operation, throwing here would prevent the new spec from
	// being created at all even though the safe-fallback path still
	// works.
	const recoveredSpecMetadata = shouldRecoverExistingSpecFromDisk
		? (() => {
				previousSpecBody = tryReadSpecMarkdown(specFilePath, "disk recovery");
				return previousSpecBody !== null
					? (() => {
							const parsed = parseSpecMarkdownPreamble(previousSpecBody);
							if (
								unsafeTrackedSpecForSlugRecovery !== null &&
								parsed.createdAt === unsafeTrackedSpecForSlugRecovery.createdAt
							) {
								return parsed;
							}
							shouldRecoverExistingSpecFromDisk = false;
							return {};
						})()
					: previousTrackedSpec?.slug === slug
						? {
								status: recoveredFallbackStatus,
								name: previousTrackedSpec.name,
								createdAt: previousTrackedSpec.createdAt,
								modelId: previousTrackedSpec.modelId,
								approvedAt: previousTrackedSpec.approvedAt,
							}
						: {};
			})()
		: recoveredTrackedSpecState
			? {
					status: recoveredTrackedSpecState.status,
					name: recoveredTrackedSpecState.name,
					createdAt: recoveredTrackedSpecState.createdAt,
					modelId: recoveredTrackedSpecState.modelId,
					approvedAt: recoveredTrackedSpecState.approvedAt,
				}
			: {};
	const trackedRecoveryState =
		shouldRecoverExistingSpecFromDisk && previousTrackedSpec?.slug === slug
			? previousTrackedSpec
			: recoveredTrackedSpecState;
	const recoveredStatus =
		recoveredSpecMetadata.status === "approved" ||
		trackedRecoveryState?.status === "approved"
			? "approved"
			: (recoveredSpecMetadata.status ?? "pending");
	// Approved/superseded recovery shouldn't reach for options.name —
	// approved attribution is durable — but the preamble may have a
	// generic `# Spec` heading that produces an undefined parsed
	// name. Fall back through every state source so an approved
	// spec doesn't lose its recorded name just because the heading
	// was minimal. Pending status still lets caller options win.
	const recoveredName =
		recoveredStatus === "pending"
			? (options.name ??
				recoveredSpecMetadata.name ??
				trackedRecoveryState?.name ??
				previousTrackedSpec?.name)
			: (recoveredSpecMetadata.name ??
				trackedRecoveryState?.name ??
				previousTrackedSpec?.name);
	const recoveredApprovedAt =
		recoveredStatus === "approved"
			? (recoveredSpecMetadata.approvedAt ?? trackedRecoveryState?.approvedAt)
			: undefined;
	// Re-entering an archived slug is a fresh start, not a recovery,
	// so don't inherit modelId/reasoningEffort from the archived
	// previous tracked state. Only fall back to tracked state when the
	// recovery target is still active (pending/approved).
	const recoveredTrackedAttributionState =
		trackedRecoveryState && trackedRecoveryState.status !== "archived"
			? trackedRecoveryState
			: previousTrackedSpec && previousTrackedSpec.status !== "archived"
				? previousTrackedSpec
				: null;
	const recoveredModelId =
		recoveredStatus === "pending"
			? (options.modelId ??
				recoveredSpecMetadata.modelId ??
				recoveredTrackedAttributionState?.modelId)
			: (recoveredSpecMetadata.modelId ??
				recoveredTrackedAttributionState?.modelId);
	const recoveredReasoningEffort =
		recoveredStatus === "pending"
			? (options.reasoningEffort ??
				recoveredTrackedAttributionState?.reasoningEffort)
			: recoveredTrackedAttributionState?.reasoningEffort;

	const state: SpecModeState = {
		version: STATE_FILE_VERSION,
		status: recoveredStatus,
		slug,
		specDir,
		specFilePath,
		sessionId: options.sessionId,
		gitBranch: options.gitBranch,
		gitCommitSha: options.gitCommitSha,
		// Match the resume path: pending specs may refresh attribution from
		// the caller, but approved specs keep the original reviewer record.
		// When the on-disk preamble omits `Model:`, fall back to the tracked
		// state we already trust for lifecycle recovery.
		modelId: recoveredModelId,
		// `reasoningEffort` isn't part of the spec.md preamble, so recovery
		// must come from tracked state. Pending specs can still refresh it
		// from caller options; approved specs stay pinned to their recorded
		// attribution just like the resume path.
		reasoningEffort: recoveredReasoningEffort,
		createdAt: recoveredSpecMetadata.createdAt ?? now,
		updatedAt: now,
		approvedAt: recoveredApprovedAt,
		name: recoveredName,
	};
	const canReuseArchivedSpecFile =
		// Only reuse disk specs when we can still prove ownership via tracked
		// state or an on-disk archived marker. A different active tracked spec
		// alone is not enough: an unrelated maestro-shaped `spec.md` at this
		// slug must still surface the collision instead of being rewritten.
		(previousTrackedSpec?.status === "archived" &&
			previousTrackedSpec.slug === slug) ||
		archivedSpecFile ||
		shouldRecoverExistingSpecFromDisk;

	// Detect on-disk collision BEFORE touching state, so a refusal here
	// doesn't leave orphan state pointing at a spec.md we never owned.
	if (existsSync(specFilePath) && !canReuseArchivedSpecFile) {
		throw new Error(
			`Spec slug "${slug}" already has a spec.md on disk; pick a unique slug or remove the existing spec directory first`,
		);
	}

	if (!specFileExists) {
		const heading = state.name ? `# Spec: ${state.name}` : "# Spec";
		previousSpecBody = null;
		const initial = [
			heading,
			"",
			`Status: ${state.status}`,
			`Created: ${state.createdAt}`,
			state.modelId ? `Model: ${state.modelId}` : null,
			state.approvedAt ? `Approved: ${state.approvedAt}` : null,
			"",
			"## Problem",
			"",
			"_Describe the problem this spec solves._",
			"",
			"## Approach",
			"",
			"_Outline the chosen approach. Note alternatives considered._",
			"",
			"## Acceptance criteria",
			"",
			"_Each criterion should be independently verifiable._",
			"",
			"## Out of scope",
			"",
			"",
		]
			.filter((line) => line !== null)
			.join("\n");
		writeTextFileAtomic(specFilePath, initial);
	} else if (canReuseArchivedSpecFile) {
		previousSpecBody ??= tryReadSpecMarkdown(
			specFilePath,
			"archived spec reuse",
		);
		if (previousSpecBody !== null) {
			const rewritten = rewriteSpecMarkdownPreamble(previousSpecBody, state);
			if (rewritten !== previousSpecBody) {
				writeTextFileAtomic(specFilePath, rewritten);
			}
		}
	}

	// Persist state only after spec.md is ready. If the global state write
	// fails, roll back the markdown change so callers never observe the new
	// slug without a matching spec.md on disk.
	if (!saveSpecModeState(state, config)) {
		const rolledBack = rollbackSpecMarkdownTransition(
			specFilePath,
			previousSpecBody,
			specFileExists,
		);
		if (!rolledBack) {
			throw new Error(
				`Failed to persist spec mode state for slug "${slug}" AND failed to roll back spec.md; manual cleanup may be required at ${specFilePath}`,
			);
		}
		throw new Error(`Failed to persist spec mode state for slug "${slug}"`);
	}
	// Best-effort heal the full preamble after save as well: recovery can
	// fall back to tracked metadata when a reuse read fails, and we still
	// want spec.md to reflect the durable state once it exists on disk.
	if (isStateSpecPathSafe(state, config)) {
		syncSpecMarkdownPreamble(state.specFilePath, state);
	}

	// Only archive the previous active spec after the replacement spec exists on
	// disk and the replacement is durable in the global state file. This keeps
	// the active state intact if starting the new tracked spec fails mid-write.
	if (previousTrackedSpec && previousTrackedSpec.status !== "archived") {
		const previousSlug = previousTrackedSpec.slug;
		const previousSpecFilePath = getSpecFilePathForLifecycleSync(
			previousTrackedSpec,
			config,
		);
		if (previousSpecFilePath && previousSpecFilePath !== specFilePath) {
			syncSpecMarkdownStatus(previousSpecFilePath, "archived");
		}
		logger.info("Archived previous spec before starting a new one", {
			previousSlug,
		});
	}

	logger.info("Entered spec mode", { slug, name: options.name });
	return state;
}

/**
 * Approve the currently pending spec. Transitions status to "approved" and
 * stamps approvedAt. Approved specs remain durable acceptance criteria and
 * can be loaded into implementation context.
 */
export function approveSpecMode(
	config: SpecModeConfig = getSpecModeConfig(),
): SpecModeState | null {
	const state = loadTrustedSpecModeState(config);
	if (!state) {
		return null;
	}
	if (state.status !== "pending") {
		logger.warn("approveSpecMode called on non-pending spec", {
			slug: state.slug,
			status: state.status,
		});
		return state;
	}
	// Refuse to approve a spec whose backing file vanished. Otherwise
	// `spec-state.json` would flip to approved while `readCurrentSpec`
	// returns null — `/spec list` and `isSpecModeApproved` would
	// disagree about whether the durable acceptance criteria exist.
	if (!existsSync(state.specFilePath)) {
		throw new Error(
			`Cannot approve spec "${state.slug}": spec.md is missing at ${state.specFilePath}`,
		);
	}
	const now = new Date().toISOString();
	const nextState: SpecModeState = {
		...state,
		status: "approved",
		approvedAt: now,
		updatedAt: now,
	};
	if (!saveSpecModeState(nextState, config)) {
		throw new Error(
			`Failed to persist spec mode state during approval for slug "${state.slug}"`,
		);
	}
	if (isStateSpecPathSafe(nextState, config)) {
		syncSpecMarkdownStatus(nextState.specFilePath, "approved", {
			label: "Approved",
			value: now,
		});
	}
	logger.info("Spec approved", { slug: nextState.slug });
	return nextState;
}

/**
 * Archive the currently tracked spec without approving it. The spec file
 * remains on disk for reference but the state machine no longer treats it
 * as active.
 */
export function exitSpecMode(
	config: SpecModeConfig = getSpecModeConfig(),
): SpecModeState | null {
	const state = loadSpecModeState(config);
	if (!state) {
		return null;
	}
	if (state.status === "archived") {
		return state;
	}
	const nextState: SpecModeState = {
		...state,
		status: "archived",
		updatedAt: new Date().toISOString(),
	};
	if (!saveSpecModeState(nextState, config)) {
		throw new Error(
			`Failed to persist spec mode state during exit for slug "${state.slug}"`,
		);
	}
	const trackedSpecFilePath = getSpecFilePathForLifecycleSync(
		nextState,
		config,
	);
	if (trackedSpecFilePath) {
		syncSpecMarkdownStatus(trackedSpecFilePath, "archived");
	}
	logger.info("Exited spec mode", { slug: nextState.slug });
	return nextState;
}

/** True when a spec is tracked and not archived (pending or approved). */
export function isSpecModeActive(
	config: SpecModeConfig = getSpecModeConfig(),
): boolean {
	return loadSafeActiveSpecState(config) !== null;
}

/** True only when the tracked spec is still being authored. */
export function isSpecModePending(
	config: SpecModeConfig = getSpecModeConfig(),
): boolean {
	return loadSafeActiveSpecState(config)?.status === "pending";
}

/** True when the tracked spec has been approved (durable acceptance). */
export function isSpecModeApproved(
	config: SpecModeConfig = getSpecModeConfig(),
): boolean {
	return loadSafeActiveSpecState(config)?.status === "approved";
}

/** Spec file path when one is tracked and not archived, else null. */
export function getCurrentSpecPath(
	config: SpecModeConfig = getSpecModeConfig(),
): string | null {
	const state = loadSafeActiveSpecState(config);
	if (!state) {
		return null;
	}
	return state.specFilePath;
}

/**
 * Read the current spec file content. Returns null if no spec is tracked,
 * if the spec is archived, or if the file is missing.
 */
export function readCurrentSpec(
	config: SpecModeConfig = getSpecModeConfig(),
): string | null {
	const filePath = getCurrentSpecPath(config);
	if (!filePath || !existsSync(filePath)) {
		return null;
	}
	try {
		return readFileSync(filePath, "utf-8");
	} catch (err) {
		logger.warn("Failed to read spec file", {
			reason: err instanceof Error ? err.message : String(err),
			filePath,
		});
		return null;
	}
}

function isPathWithinDirectory(
	filePath: string,
	directoryPath: string,
): boolean {
	const normalizedDir = `${resolve(directoryPath)}${sep}`;
	const normalizedFile = resolve(filePath);
	return normalizedFile.startsWith(normalizedDir);
}

/**
 * List specs persisted under the configured specs directory. The currently
 * tracked spec (if any) is annotated with its lifecycle status; specs only
 * present on disk are reported as "archived".
 */
export function listSpecs(
	config: SpecModeConfig = getSpecModeConfig(),
): SpecSummary[] {
	const current = loadTrustedSpecModeState(config);
	const currentSummary = current
		? {
				slug: current.slug,
				specDir: current.specDir,
				specFilePath: current.specFilePath,
				status: current.status,
				name: current.name,
				updatedAt: current.updatedAt,
			}
		: null;
	if (!existsSync(config.specsDir)) {
		// The specs directory is gone but the state machine may still
		// report an active tracked spec. Synthesize a summary from the
		// state record so `/spec list` agrees with `isSpecModeActive`
		// instead of silently returning empty.
		return currentSummary ? [currentSummary] : [];
	}
	const summaries: SpecSummary[] = [];
	let entries: string[];
	try {
		entries = readdirSync(config.specsDir);
	} catch (err) {
		// The path exists but cannot be enumerated (permission denied, race, or
		// it's a file rather than a directory). Surface the tracked spec
		// when there is one — otherwise return empty.
		logger.warn("Failed to enumerate specs directory", {
			reason: err instanceof Error ? err.message : String(err),
			specsDir: config.specsDir,
		});
		return currentSummary ? [currentSummary] : [];
	}
	for (const entry of entries) {
		// Reject path-shaped names and symlinks whose resolved target leaves
		// the specs directory. A directory entry like ".." or a symlinked
		// child can otherwise surface specDir/specFilePath outside the
		// configured tree to callers walking the summaries.
		if (!isValidSpecSlug(entry)) {
			continue;
		}
		const specDir = join(config.specsDir, entry);
		const specFilePath = join(specDir, "spec.md");
		if (
			!isPathWithinDirectory(specDir, config.specsDir) ||
			!isPathWithinDirectory(specFilePath, config.specsDir)
		) {
			continue;
		}
		let diskUpdatedAt: string;
		try {
			const specDirStat = lstatSync(specDir);
			const specFileStat = lstatSync(specFilePath);
			if (!specDirStat.isDirectory() || !specFileStat.isFile()) {
				continue;
			}
			diskUpdatedAt = specFileStat.mtime.toISOString();
		} catch {
			continue;
		}
		const tracked = current && current.slug === entry;
		summaries.push({
			slug: entry,
			specDir,
			specFilePath,
			status: tracked ? current.status : "archived",
			name: tracked ? current.name : undefined,
			updatedAt: tracked ? current.updatedAt : diskUpdatedAt,
		});
	}
	// If the globally tracked spec wasn't visited above (its spec.md is
	// missing, unreadable, or its directory got deleted), synthesize a
	// summary from the state record. Otherwise callers see "no active
	// spec" while the state machine still reports one — exactly the
	// dropped-state confusion the lifecycle helpers exist to avoid.
	if (
		currentSummary &&
		!summaries.some((s) => s.slug === currentSummary.slug)
	) {
		summaries.push(currentSummary);
	}
	summaries.sort((a, b) => {
		// The tracked active spec always sorts to the top so it's easy to find.
		const aActive = a.status !== "archived";
		const bActive = b.status !== "archived";
		if (aActive !== bActive) {
			return aActive ? -1 : 1;
		}
		if (a.updatedAt === b.updatedAt) {
			return a.slug < b.slug ? -1 : 1;
		}
		return a.updatedAt < b.updatedAt ? 1 : -1;
	});
	return summaries;
}
