/**
 * Validation Contract Primitive
 *
 * A validation contract is the per-task definition of done: an exhaustive
 * list of behavioral assertions, organized by surface and area, with
 * cross-area flows for interactions. Each assertion has a stable id and
 * a lifecycle status.
 *
 * The coverage gate is the pre-execution check: every assertion id in the
 * contract must be claimed by exactly one feature's `fulfills` array.
 * Orphans (unclaimed assertions) and duplicates (multiple claims of the
 * same id), duplicate assertion ids inside the contract itself, and
 * unknown ids in feature claims (referring to assertions that don't
 * exist in the contract) all fail the gate.
 *
 * ## Layout
 *
 * ```
 * project/.maestro/contracts/<slug>/
 *   ├── contract.json     # authoritative ValidationContract
 *   ├── contract.md       # human-readable rendering (read-only mirror)
 *   └── state.json        # assertion id -> AssertionStatus
 * ```
 *
 * ## What this module is and isn't
 *
 * Types, coverage gate, serialization, and JSON-backed storage. The
 * `/contract` slash command, the reviewer subagent that proposes
 * additions, and the PR-body integration ride in follow-up PRs that
 * consume these primitives.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { writeTextFileAtomic } from "../utils/fs.js";
import { createLogger } from "../utils/logger.js";
import { resolveEnvPath } from "../utils/path-expansion.js";

const logger = createLogger("validation-contract");

const CONTRACT_FILE_VERSION = 1;

/** Per-assertion lifecycle. */
export type AssertionStatus = "pending" | "in-progress" | "passed" | "failed";

/** A single testable behavioral claim. */
export interface Assertion {
	/** Stable identifier, unique within the contract. */
	id: string;
	/** Human-readable claim ("Logged-in user sees the dashboard"). */
	description: string;
	/** Lifecycle status. */
	status: AssertionStatus;
	/** Optional evidence the status is what it claims (link, log, test name). */
	evidence?: string;
	/** Free-form reviewer notes. */
	notes?: string;
}

/** A grouped set of assertions within a single surface. */
export interface ContractArea {
	name: string;
	assertions: Assertion[];
}

/** A flow whose assertions span multiple areas (e.g. login → dashboard). */
export interface CrossAreaFlow {
	name: string;
	assertions: Assertion[];
}

/** The authoritative contract document. */
export interface ValidationContract {
	/** Schema version for forward-compatible migrations. */
	version: number;
	/** Stable contract identifier. */
	id: string;
	/** Surface this contract describes ("ui" | "cli" | "api" | "headless" | etc). */
	surface: string;
	/** Optional human-readable title. */
	title?: string;
	/** Area-grouped assertions. */
	areas: ContractArea[];
	/** Cross-area flow assertions. */
	crossAreaFlows: CrossAreaFlow[];
	/** ISO 8601 creation timestamp. */
	createdAt: string;
	/** ISO 8601 last update. */
	updatedAt: string;
}

/** A feature's claim on contract assertions. */
export interface FeatureClaim {
	/** Feature identifier (matches features.json). */
	id: string;
	/** Assertion ids this feature commits to satisfying. */
	fulfills: string[];
}

/** Result of running the coverage gate over a contract + feature claims. */
export interface CoverageReport {
	/** True only when every assertion is claimed exactly once with no unknowns. */
	ok: boolean;
	/** Assertion ids in the contract not claimed by any feature. */
	orphans: string[];
	/** Assertion ids duplicated in the contract or claimed more than once. */
	duplicates: string[];
	/** Assertion ids referenced by features but absent from the contract. */
	unknownAssertions: string[];
}

export interface ContractStorageConfig {
	/** Project-local directory holding one subdirectory per contract. */
	contractsDir: string;
}

const DEFAULT_CONTRACTS_SUBDIR = ".maestro/contracts";

/**
 * Resolve the per-project contracts directory. MAESTRO_CONTRACT_DIR
 * overrides the default for tests and unusual layouts.
 */
export function getContractStorageConfig(): ContractStorageConfig {
	const contractsDir =
		resolveEnvPath(process.env.MAESTRO_CONTRACT_DIR) ??
		join(process.cwd(), DEFAULT_CONTRACTS_SUBDIR);
	return { contractsDir };
}

/**
 * Return every assertion id in the contract, in document order. Used by
 * the coverage gate and by any caller that needs to enumerate assertions
 * without walking the nested structure manually.
 */
export function listAssertionIds(contract: ValidationContract): string[] {
	const ids: string[] = [];
	for (const area of contract.areas) {
		for (const assertion of area.assertions) {
			ids.push(assertion.id);
		}
	}
	for (const flow of contract.crossAreaFlows) {
		for (const assertion of flow.assertions) {
			ids.push(assertion.id);
		}
	}
	return ids;
}

/**
 * Run the coverage gate. Returns `ok: true` only when every assertion in
 * the contract is claimed by exactly one feature and no claim references
 * a non-existent assertion.
 *
 * Use the report.orphans / report.duplicates / report.unknownAssertions
 * fields to render an actionable error message; the gate intentionally
 * does not throw so callers can format the output for their context (CLI,
 * UI, PR comment).
 */
export function checkCoverage(
	contract: ValidationContract,
	claims: FeatureClaim[],
): CoverageReport {
	const contractIdCounts = new Map<string, number>();
	for (const id of listAssertionIds(contract)) {
		contractIdCounts.set(id, (contractIdCounts.get(id) ?? 0) + 1);
	}
	const contractIds = new Set(contractIdCounts.keys());
	const claimCounts = new Map<string, number>();
	const unknownSet = new Set<string>();

	for (const claim of claims) {
		for (const assertionId of claim.fulfills) {
			claimCounts.set(assertionId, (claimCounts.get(assertionId) ?? 0) + 1);
			if (!contractIds.has(assertionId)) {
				unknownSet.add(assertionId);
			}
		}
	}

	const orphans: string[] = [];
	const duplicateSet = new Set<string>();
	for (const [id, contractCount] of contractIdCounts) {
		const count = claimCounts.get(id) ?? 0;
		if (count === 0) {
			orphans.push(id);
		}
		if (contractCount > 1 || count > 1) {
			duplicateSet.add(id);
		}
	}

	const unknownAssertions = Array.from(unknownSet).sort();
	const duplicates = Array.from(duplicateSet).sort();
	orphans.sort();

	return {
		ok:
			orphans.length === 0 &&
			duplicates.length === 0 &&
			unknownAssertions.length === 0,
		orphans,
		duplicates,
		unknownAssertions,
	};
}

/**
 * Build a contract with every assertion reset to `pending`. Useful when
 * cloning a template or starting a fresh run with the same structure.
 */
export function initializeContractState(
	contract: ValidationContract,
): ValidationContract {
	const stamped: ValidationContract = {
		...contract,
		areas: contract.areas.map((area) => ({
			...area,
			assertions: area.assertions.map((assertion) => ({
				...assertion,
				status: "pending",
				evidence: undefined,
				notes: undefined,
			})),
		})),
		crossAreaFlows: contract.crossAreaFlows.map((flow) => ({
			...flow,
			assertions: flow.assertions.map((assertion) => ({
				...assertion,
				status: "pending",
				evidence: undefined,
				notes: undefined,
			})),
		})),
		updatedAt: new Date().toISOString(),
	};
	return stamped;
}

/**
 * Update a single assertion's status. Returns a new contract; the input
 * is not mutated. Throws when the assertion id is not found, on the same
 * principle as the coverage gate's `unknownAssertions`: unknown ids
 * indicate caller bugs and silent no-ops would mask them.
 */
export function setAssertionStatus(
	contract: ValidationContract,
	assertionId: string,
	status: AssertionStatus,
	options: { evidence?: string; notes?: string } = {},
): ValidationContract {
	let found = false;
	const updateAssertion = (a: Assertion): Assertion => {
		if (a.id !== assertionId) {
			return a;
		}
		found = true;
		return {
			...a,
			status,
			evidence: options.evidence ?? a.evidence,
			notes: options.notes ?? a.notes,
		};
	};

	const next: ValidationContract = {
		...contract,
		areas: contract.areas.map((area) => ({
			...area,
			assertions: area.assertions.map(updateAssertion),
		})),
		crossAreaFlows: contract.crossAreaFlows.map((flow) => ({
			...flow,
			assertions: flow.assertions.map(updateAssertion),
		})),
		updatedAt: new Date().toISOString(),
	};

	if (!found) {
		throw new Error(
			`Assertion id "${assertionId}" not found in contract "${contract.id}"`,
		);
	}
	return next;
}

/**
 * Render a contract as human-readable markdown. The rendered form is a
 * one-way mirror — callers that need to round-trip should use the JSON
 * representation; markdown parse is intentionally out of scope.
 */
export function renderContractMarkdown(contract: ValidationContract): string {
	const lines: string[] = [];
	const title = contract.title ?? contract.id;
	lines.push(`# ${title}`);
	lines.push("");
	lines.push(`- **Surface:** \`${contract.surface}\``);
	lines.push(`- **Contract id:** \`${contract.id}\``);
	lines.push(`- **Updated:** ${contract.updatedAt}`);
	lines.push("");
	lines.push("## Coverage status");
	lines.push("");
	const counts = countByStatus(contract);
	lines.push(
		`- pending: ${counts.pending} | in-progress: ${counts["in-progress"]} | passed: ${counts.passed} | failed: ${counts.failed}`,
	);
	lines.push("");

	for (const area of contract.areas) {
		lines.push(`## Area: ${area.name}`);
		lines.push("");
		for (const assertion of area.assertions) {
			lines.push(formatAssertion(assertion));
		}
		lines.push("");
	}

	if (contract.crossAreaFlows.length > 0) {
		lines.push("## Cross-area flows");
		lines.push("");
		for (const flow of contract.crossAreaFlows) {
			lines.push(`### ${flow.name}`);
			lines.push("");
			for (const assertion of flow.assertions) {
				lines.push(formatAssertion(assertion));
			}
			lines.push("");
		}
	}

	return lines.join("\n").trimEnd().concat("\n");
}

function formatAssertion(assertion: Assertion): string {
	const statusMarker: Record<AssertionStatus, string> = {
		pending: "[ ]",
		"in-progress": "[~]",
		passed: "[x]",
		failed: "[!]",
	};
	const marker = statusMarker[assertion.status];
	const evidence = assertion.evidence
		? ` _(evidence: ${assertion.evidence})_`
		: "";
	return `- ${marker} \`${assertion.id}\` — ${assertion.description}${evidence}`;
}

function countByStatus(
	contract: ValidationContract,
): Record<AssertionStatus, number> {
	const counts: Record<AssertionStatus, number> = {
		pending: 0,
		"in-progress": 0,
		passed: 0,
		failed: 0,
	};
	const walk = (assertions: Assertion[]): void => {
		for (const a of assertions) {
			counts[a.status] += 1;
		}
	};
	for (const area of contract.areas) {
		walk(area.assertions);
	}
	for (const flow of contract.crossAreaFlows) {
		walk(flow.assertions);
	}
	return counts;
}

function isPathWithinDirectory(
	filePath: string,
	directoryPath: string,
): boolean {
	const normalizedDir = `${resolvePathThroughExistingParents(directoryPath)}${sep}`;
	const normalizedFile = resolvePathThroughExistingParents(filePath);
	return normalizedFile.startsWith(normalizedDir);
}

function resolvePathThroughExistingParents(filePath: string): string {
	const resolvedPath = resolve(filePath);
	let current = resolvedPath;
	const suffix: string[] = [];

	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) {
			return resolvedPath;
		}
		suffix.push(basename(current));
		current = parent;
	}

	const realBase = realpathSync(current);
	return suffix.length === 0
		? realBase
		: resolve(realBase, ...suffix.reverse());
}

function contractDirFor(slug: string, config: ContractStorageConfig): string {
	const target = join(config.contractsDir, slug);
	if (!isPathWithinDirectory(target, config.contractsDir)) {
		throw new Error(`Refusing to use unsafe contract slug: ${slug}`);
	}
	return target;
}

/**
 * Persist a contract to disk: writes both the authoritative JSON and the
 * mirrored markdown rendering under `<contractsDir>/<slug>/`.
 */
export function saveContract(
	slug: string,
	contract: ValidationContract,
	config: ContractStorageConfig = getContractStorageConfig(),
): { contractDir: string; jsonPath: string; markdownPath: string } {
	const contractDir = contractDirFor(slug, config);
	if (!existsSync(contractDir)) {
		mkdirSync(contractDir, { recursive: true });
	}
	const jsonPath = join(contractDir, "contract.json");
	const markdownPath = join(contractDir, "contract.md");
	writeTextFileAtomic(jsonPath, `${JSON.stringify(contract, null, 2)}\n`);
	writeTextFileAtomic(markdownPath, renderContractMarkdown(contract));
	logger.info("Saved validation contract", {
		slug,
		contractId: contract.id,
		assertionCount: listAssertionIds(contract).length,
	});
	return { contractDir, jsonPath, markdownPath };
}

/**
 * Load a contract by slug. Returns null when the directory or JSON file
 * does not exist; reads and parse errors are logged and surfaced as null
 * so callers can fall back to creating a fresh contract.
 */
export function loadContract(
	slug: string,
	config: ContractStorageConfig = getContractStorageConfig(),
): ValidationContract | null {
	const jsonPath = join(contractDirFor(slug, config), "contract.json");
	if (!existsSync(jsonPath)) {
		return null;
	}
	try {
		const raw = readFileSync(jsonPath, "utf-8");
		return JSON.parse(raw) as ValidationContract;
	} catch (err) {
		logger.warn("Failed to load contract", {
			slug,
			reason: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * List slugs present under the configured contracts directory. The result
 * is sorted alphabetically so callers can rely on a stable display order.
 */
export function listContractSlugs(
	config: ContractStorageConfig = getContractStorageConfig(),
): string[] {
	if (!existsSync(config.contractsDir)) {
		return [];
	}
	const slugs: string[] = [];
	for (const entry of readdirSync(config.contractsDir, {
		withFileTypes: true,
	})) {
		if (!entry.isDirectory()) {
			continue;
		}
		let contractDir: string;
		try {
			contractDir = contractDirFor(entry.name, config);
		} catch (err) {
			logger.warn("Skipping unsafe contract slug during list", {
				slug: entry.name,
				reason: err instanceof Error ? err.message : String(err),
			});
			continue;
		}
		const jsonPath = join(contractDir, "contract.json");
		if (existsSync(jsonPath)) {
			slugs.push(entry.name);
		}
	}
	slugs.sort();
	return slugs;
}

/**
 * Construct a fresh, empty contract with the given id and surface. Useful
 * as a seed before the agent fills in areas and assertions.
 */
export function createEmptyContract(options: {
	id: string;
	surface: string;
	title?: string;
}): ValidationContract {
	const now = new Date().toISOString();
	return {
		version: CONTRACT_FILE_VERSION,
		id: options.id,
		surface: options.surface,
		title: options.title,
		areas: [],
		crossAreaFlows: [],
		createdAt: now,
		updatedAt: now,
	};
}

/** Locate the on-disk path for a contract slug. */
export function getContractPaths(
	slug: string,
	config: ContractStorageConfig = getContractStorageConfig(),
): { contractDir: string; jsonPath: string; markdownPath: string } {
	const contractDir = contractDirFor(slug, config);
	return {
		contractDir,
		jsonPath: join(contractDir, "contract.json"),
		markdownPath: join(contractDir, "contract.md"),
	};
}
