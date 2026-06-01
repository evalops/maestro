import crypto from "node:crypto";
import { constants } from "node:fs";
import {
	access,
	mkdir,
	readFile,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { Type } from "@sinclair/typebox";
import {
	captureDiagnosticBaseline,
	collectDiagnosticDelta,
} from "../lsp/diagnostic-deltas.js";
import {
	type DiagnosticDeltaToolSummary,
	buildDiagnosticDeltaToolSummary,
	formatDiagnosticDeltaForToolOutput,
} from "../lsp/diagnostic-repair.js";
import { assertTeamMemoryContentSafe } from "../memory/team-memory.js";
import {
	requirePlanCheck,
	runValidatorsOnSuccess,
} from "../safety/safe-mode.js";
import type { ValidatorRunResult } from "../safety/safe-mode.js";
import type { Sandbox } from "../sandbox/types.js";
import {
	type ApplyPatchDocument,
	type ApplyPatchHunk,
	parseApplyPatch,
} from "./apply-patch-parser.js";
import { generateDiffString } from "./diff-utils.js";
import { ToolError, createTool, expandUserPath } from "./tool-dsl.js";

type LineEnding = "\n" | "\r\n" | "\r";

type NormalizedDocument = {
	original: string;
	lines: string[];
	hadFinalNewline: boolean;
	bom: string;
	lineEnding: LineEnding;
};

type PlannedFileChange = {
	path: string;
	absolutePath: string;
	previousContent: string | null;
	nextContent: string | null;
	operation: "add" | "update" | "delete";
	hunksApplied: number;
	diff?: string;
};

type StagedFileState = {
	path: string;
	absolutePath: string;
	exists: boolean;
	currentContent?: string | null;
};

type DiagnosticBaseline = Awaited<ReturnType<typeof captureDiagnosticBaseline>>;

type ApplyPatchPlan = {
	filesModified: string[];
	filesCreated: string[];
	filesDeleted: string[];
	hunksApplied: number;
	hunksFailed: number;
	conflictDetails?: string[];
	changes: PlannedFileChange[];
};

const applyPatchSchema = Type.Object({
	patch: Type.String({
		description:
			"OpenAI apply_patch block from *** Begin Patch to *** End Patch",
		minLength: 1,
	}),
	dryRun: Type.Optional(
		Type.Boolean({
			description: "Preview the patch without writing changes",
			default: false,
		}),
	),
});

export type ApplyPatchToolDetails = {
	filesModified: string[];
	filesCreated: string[];
	filesDeleted: string[];
	hunksApplied: number;
	hunksFailed: number;
	conflictDetails?: string[];
	diffs?: Record<string, string>;
	validators?: ValidatorRunResult[];
	diagnosticDelta?: DiagnosticDeltaToolSummary;
	diagnosticDeltas?: DiagnosticDeltaToolSummary[];
	editGrammar: "apply_patch";
	mode?: "sandbox";
};

class ApplyPatchConflictError extends ToolError {
	constructor(message: string, details: ApplyPatchToolDetails) {
		super(message, "APPLY_PATCH_CONFLICT", details);
	}
}

export const applyPatchTool = createTool<
	typeof applyPatchSchema,
	ApplyPatchToolDetails
>({
	name: "apply_patch",
	label: "apply_patch",
	description: `Apply an OpenAI/Codex apply_patch block directly.

Parameters:
- patch: Patch text using *** Begin Patch / *** End Patch with Add, Update, or Delete File operations.
- dryRun: Preview only (default: false).

Use this when a Codex-family model emits its native apply_patch grammar. Use edit for targeted find-and-replace edits.`,
	schema: applyPatchSchema,
	shouldRetry: (error) => error instanceof ApplyPatchConflictError,
	async run({ patch, dryRun = false }, { signal, respond, sandbox }) {
		requirePlanCheck("apply_patch");
		const throwIfAborted = () => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
		};

		const document = parseApplyPatch(patch);
		const plan = sandbox
			? await planSandboxPatch(document, sandbox)
			: await planFilesystemPatch(document);
		const details = buildDetails(plan, sandbox ? "sandbox" : undefined);

		if (plan.hunksFailed > 0) {
			throw new ApplyPatchConflictError(
				`apply_patch failed: ${plan.hunksFailed} hunk(s) could not be applied. Re-read the affected file(s), re-author the patch with fresh context, and retry.`,
				details,
			);
		}

		throwIfAborted();
		let postWriteOutput = "";
		if (!dryRun) {
			if (sandbox) {
				await writeSandboxChanges(plan, sandbox);
			} else {
				const baselines = await captureWriteBaselines(plan);
				throwIfAborted();
				try {
					await writeFilesystemChanges(plan, throwIfAborted);
					const postWriteDetails = await collectPostWriteDetails(
						plan,
						baselines,
						throwIfAborted,
					);
					Object.assign(details, postWriteDetails);
					if (postWriteDetails.diagnosticDelta) {
						postWriteOutput = formatDiagnosticDeltaForToolOutput(
							postWriteDetails.diagnosticDelta,
						);
					}
				} catch (error) {
					await rollbackFilesystemChanges(plan);
					throw error;
				}
			}
		}

		const changedFileCount = countChangedFiles(plan);
		return respond
			.text(
				[
					dryRun
						? `Dry run: apply_patch would update ${changedFileCount} file(s) with ${plan.hunksApplied} hunk(s).`
						: `Applied patch to ${changedFileCount} file(s) with ${plan.hunksApplied} hunk(s).`,
					postWriteOutput,
				]
					.filter(Boolean)
					.join("\n"),
			)
			.detail(details);
	},
});

async function planFilesystemPatch(
	document: ApplyPatchDocument,
): Promise<ApplyPatchPlan> {
	const plan = emptyPlan();
	const stagedFiles = new Map<string, StagedFileState>();
	const getState = async (path: string): Promise<StagedFileState> => {
		const absolutePath = resolvePath(expandUserPath(path));
		const cached = stagedFiles.get(absolutePath);
		if (cached) {
			return cached;
		}
		const exists = await fileExists(absolutePath);
		const state = {
			path,
			absolutePath,
			exists,
			currentContent: exists ? undefined : null,
		};
		stagedFiles.set(absolutePath, state);
		return state;
	};

	for (const operation of document.operations) {
		const state = await getState(operation.path);
		const { absolutePath } = state;
		if (operation.type === "add") {
			if (state.exists) {
				throw new Error(`File already exists: ${operation.path}`);
			}
			const nextContent = serializeLines(operation.lines, true);
			assertTeamMemoryContentSafe(absolutePath, nextContent);
			addPlannedChange(plan, {
				path: state.path,
				absolutePath,
				previousContent: null,
				nextContent,
				operation: "add",
				hunksApplied: 1,
				diff: generateDiffString("", nextContent),
			});
			state.exists = true;
			state.currentContent = nextContent;
		} else if (operation.type === "delete") {
			const previousContent = await readFilesystemStateContent(
				state,
				operation.path,
			);
			addPlannedChange(plan, {
				path: state.path,
				absolutePath,
				previousContent,
				nextContent: null,
				operation: "delete",
				hunksApplied: 1,
				diff: generateDiffString(previousContent, ""),
			});
			state.exists = false;
			state.currentContent = null;
		} else {
			const previousContent = await readFilesystemStateContent(
				state,
				operation.path,
			);
			const applied =
				operation.hunks.length > 0
					? applyUpdateHunks(previousContent, operation.hunks)
					: { content: previousContent, hunksApplied: 0, conflicts: [] };
			if (applied.conflicts.length > 0) {
				recordConflicts(plan, operation.path, applied.conflicts);
				continue;
			}
			const nextContent = applied.content;
			if (operation.moveTo) {
				const destinationState = await getState(operation.moveTo);
				if (destinationState.exists) {
					throw new Error(`File already exists: ${operation.moveTo}`);
				}
				assertTeamMemoryContentSafe(destinationState.absolutePath, nextContent);
				addPlannedChange(plan, {
					path: state.path,
					absolutePath,
					previousContent,
					nextContent: null,
					operation: "delete",
					hunksApplied: 0,
					diff: generateDiffString(previousContent, ""),
				});
				addPlannedChange(plan, {
					path: destinationState.path,
					absolutePath: destinationState.absolutePath,
					previousContent: null,
					nextContent,
					operation: "add",
					hunksApplied: applied.hunksApplied,
					diff: generateDiffString("", nextContent),
				});
				state.exists = false;
				state.currentContent = null;
				destinationState.exists = true;
				destinationState.currentContent = nextContent;
				continue;
			}
			assertTeamMemoryContentSafe(absolutePath, nextContent);
			addPlannedChange(plan, {
				path: state.path,
				absolutePath,
				previousContent,
				nextContent,
				operation: "update",
				hunksApplied: applied.hunksApplied,
				diff: generateDiffString(previousContent, nextContent),
			});
			state.exists = true;
			state.currentContent = nextContent;
		}
	}
	return plan;
}

async function planSandboxPatch(
	document: ApplyPatchDocument,
	sandbox: Sandbox,
): Promise<ApplyPatchPlan> {
	const plan = emptyPlan();
	const stagedFiles = new Map<string, StagedFileState>();
	const getState = async (path: string): Promise<StagedFileState> => {
		const absolutePath = resolvePath(expandUserPath(path));
		const cacheKey = normalizeSandboxPathKey(path);
		const cached = stagedFiles.get(cacheKey);
		if (cached) {
			return cached;
		}
		const exists = await sandbox.exists(path);
		const state = {
			path,
			absolutePath,
			exists,
			currentContent: exists ? undefined : null,
		};
		stagedFiles.set(cacheKey, state);
		return state;
	};

	for (const operation of document.operations) {
		const state = await getState(operation.path);
		const { absolutePath } = state;
		if (operation.type === "add") {
			if (state.exists) {
				throw new Error(`File already exists: ${operation.path}`);
			}
			const nextContent = serializeLines(operation.lines, true);
			assertTeamMemoryContentSafe(absolutePath, nextContent);
			addPlannedChange(plan, {
				path: state.path,
				absolutePath,
				previousContent: null,
				nextContent,
				operation: "add",
				hunksApplied: 1,
				diff: generateDiffString("", nextContent),
			});
			state.exists = true;
			state.currentContent = nextContent;
		} else if (operation.type === "delete") {
			const previousContent = await readSandboxStateContent(
				state,
				operation.path,
				sandbox,
				"in sandbox",
			);
			addPlannedChange(plan, {
				path: state.path,
				absolutePath,
				previousContent,
				nextContent: null,
				operation: "delete",
				hunksApplied: 1,
				diff: generateDiffString(previousContent, ""),
			});
			state.exists = false;
			state.currentContent = null;
		} else {
			const previousContent = await readSandboxStateContent(
				state,
				operation.path,
				sandbox,
				"in sandbox",
			);
			const applied =
				operation.hunks.length > 0
					? applyUpdateHunks(previousContent, operation.hunks)
					: { content: previousContent, hunksApplied: 0, conflicts: [] };
			if (applied.conflicts.length > 0) {
				recordConflicts(plan, operation.path, applied.conflicts);
				continue;
			}
			const nextContent = applied.content;
			if (operation.moveTo) {
				const destinationState = await getState(operation.moveTo);
				if (destinationState.exists) {
					throw new Error(
						`File already exists in sandbox: ${operation.moveTo}`,
					);
				}
				assertTeamMemoryContentSafe(destinationState.absolutePath, nextContent);
				addPlannedChange(plan, {
					path: state.path,
					absolutePath,
					previousContent,
					nextContent: null,
					operation: "delete",
					hunksApplied: 0,
					diff: generateDiffString(previousContent, ""),
				});
				addPlannedChange(plan, {
					path: destinationState.path,
					absolutePath: destinationState.absolutePath,
					previousContent: null,
					nextContent,
					operation: "add",
					hunksApplied: applied.hunksApplied,
					diff: generateDiffString("", nextContent),
				});
				state.exists = false;
				state.currentContent = null;
				destinationState.exists = true;
				destinationState.currentContent = nextContent;
				continue;
			}
			assertTeamMemoryContentSafe(absolutePath, nextContent);
			addPlannedChange(plan, {
				path: state.path,
				absolutePath,
				previousContent,
				nextContent,
				operation: "update",
				hunksApplied: applied.hunksApplied,
				diff: generateDiffString(previousContent, nextContent),
			});
			state.exists = true;
			state.currentContent = nextContent;
		}
	}
	return plan;
}

function applyUpdateHunks(
	previousContent: string,
	hunks: ApplyPatchHunk[],
): { content: string; hunksApplied: number; conflicts: string[] } {
	const document = normalizeDocument(previousContent);
	let lines = [...document.lines];
	let finalNewline = document.hadFinalNewline;
	const conflicts: string[] = [];
	let hunksApplied = 0;
	for (const [index, hunk] of hunks.entries()) {
		if (hunk.oldLines.length === 0) {
			lines = [...lines, ...hunk.newLines];
			finalNewline = resolveHunkFinalNewline(finalNewline, hunk, lines.length);
			hunksApplied++;
			continue;
		}
		const matches = findLineSequence(lines, hunk.oldLines).filter(
			(start) =>
				!hunk.oldMustEndAtEOF || start + hunk.oldLines.length === lines.length,
		);
		if (matches.length === 0) {
			conflicts.push(`hunk ${index + 1}: context not found`);
			continue;
		}
		if (matches.length > 1) {
			conflicts.push(
				`hunk ${index + 1}: context matched ${matches.length} times`,
			);
			continue;
		}
		const start = matches[0] ?? 0;
		lines = [
			...lines.slice(0, start),
			...hunk.newLines,
			...lines.slice(start + hunk.oldLines.length),
		];
		finalNewline = resolveHunkFinalNewline(finalNewline, hunk, lines.length);
		hunksApplied++;
	}
	return {
		content: restoreDocumentContent(lines, document, finalNewline),
		hunksApplied,
		conflicts,
	};
}

function resolveHunkFinalNewline(
	currentFinalNewline: boolean,
	hunk: ApplyPatchHunk,
	resultLineCount: number,
): boolean {
	if (hunk.newNoFinalNewline === true) {
		return false;
	}
	if (hunk.oldNoFinalNewline === true) {
		return resultLineCount > 0;
	}
	return currentFinalNewline;
}

function findLineSequence(lines: string[], needle: string[]): number[] {
	const matches: number[] = [];
	if (needle.length === 0 || needle.length > lines.length) {
		return matches;
	}
	for (let index = 0; index <= lines.length - needle.length; index++) {
		let matched = true;
		for (let offset = 0; offset < needle.length; offset++) {
			if (lines[index + offset] !== needle[offset]) {
				matched = false;
				break;
			}
		}
		if (matched) {
			matches.push(index);
		}
	}
	return matches;
}

async function writeFilesystemChanges(
	plan: ApplyPatchPlan,
	throwIfAborted: () => void,
): Promise<void> {
	for (const change of plan.changes) {
		throwIfAborted();
		if (change.nextContent === null) {
			await rm(change.absolutePath, { force: true });
			continue;
		}
		await mkdir(dirname(change.absolutePath), { recursive: true });
		await writeFileAtomically(change.absolutePath, change.nextContent);
	}
}

async function writeSandboxChanges(
	plan: ApplyPatchPlan,
	sandbox: Sandbox,
): Promise<void> {
	validateSandboxRollbackSupport(plan, sandbox);
	try {
		for (const change of plan.changes) {
			if (change.nextContent === null) {
				if (!sandbox.delete) {
					throw new Error("Sandbox does not support deleting files");
				}
				await sandbox.delete(change.path, false);
			} else {
				await sandbox.writeFile(change.path, change.nextContent);
			}
		}
	} catch (error) {
		await rollbackSandboxChanges(plan, sandbox);
		throw error;
	}
}

function validateSandboxRollbackSupport(
	plan: ApplyPatchPlan,
	sandbox: Sandbox,
): void {
	const needsDeleteForApplyOrRollback = plan.changes.some(
		(change) => change.nextContent === null || change.previousContent === null,
	);
	if (needsDeleteForApplyOrRollback && !sandbox.delete) {
		throw new Error(
			"Sandbox does not support deleting files, so apply_patch cannot safely apply add/delete operations",
		);
	}
}

async function rollbackSandboxChanges(
	plan: ApplyPatchPlan,
	sandbox: Sandbox,
): Promise<void> {
	for (const change of [...plan.changes].reverse()) {
		try {
			if (change.previousContent === null) {
				await sandbox.delete?.(change.path, false);
				continue;
			}
			await sandbox.writeFile(change.path, change.previousContent);
		} catch {}
	}
}

async function captureWriteBaselines(
	plan: ApplyPatchPlan,
): Promise<Map<string, DiagnosticBaseline>> {
	const baselines = new Map<string, DiagnosticBaseline>();
	for (const change of plan.changes) {
		if (change.nextContent === null) {
			continue;
		}
		baselines.set(
			change.absolutePath,
			await captureDiagnosticBaseline(change.absolutePath),
		);
	}
	return baselines;
}

async function collectPostWriteDetails(
	plan: ApplyPatchPlan,
	baselines: Map<string, DiagnosticBaseline>,
	throwIfAborted: () => void,
): Promise<
	Pick<
		ApplyPatchToolDetails,
		"validators" | "diagnosticDelta" | "diagnosticDeltas"
	>
> {
	const writePaths = plan.changes
		.filter((change) => change.nextContent !== null)
		.map((change) => change.absolutePath);
	if (writePaths.length === 0) {
		return {};
	}
	throwIfAborted();
	const deltaResults = await Promise.all(
		writePaths.map((writePath) =>
			collectDiagnosticDelta(baselines.get(writePath)!),
		),
	);
	const deltas = deltaResults.map((result, index) => {
		const writePath = writePaths[index] ?? "";
		return buildDiagnosticDeltaToolSummary({
			file: writePath,
			displayPath:
				plan.changes.find((change) => change.absolutePath === writePath)
					?.path ?? writePath,
			result,
		});
	});
	const validatorDiagnostics = Object.fromEntries(
		deltaResults.flatMap((result) =>
			Object.entries(result.validatorDiagnostics),
		),
	);
	const validatorSummaries = await runValidatorsOnSuccess(
		writePaths,
		validatorDiagnostics,
	);
	return {
		validators: validatorSummaries,
		diagnosticDelta: deltas[0],
		diagnosticDeltas: deltas,
	};
}

async function rollbackFilesystemChanges(plan: ApplyPatchPlan): Promise<void> {
	for (const change of [...plan.changes].reverse()) {
		try {
			if (change.previousContent === null) {
				await rm(change.absolutePath, { force: true });
				continue;
			}
			await mkdir(dirname(change.absolutePath), { recursive: true });
			await writeFileAtomically(change.absolutePath, change.previousContent);
		} catch {}
	}
}

async function writeFileAtomically(
	filePath: string,
	contents: string,
): Promise<void> {
	const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
	await writeFile(tempPath, contents, "utf-8");
	try {
		await rename(tempPath, filePath);
	} catch (error) {
		await unlink(tempPath).catch(() => {});
		throw error;
	}
}

async function readExistingFile(
	absolutePath: string,
	displayPath: string,
): Promise<string> {
	try {
		await access(absolutePath, constants.R_OK | constants.W_OK);
		return await readFile(absolutePath, "utf-8");
	} catch {
		throw new Error(
			`File not readable/writable: ${displayPath}. Use read/list to verify the path and permissions.`,
		);
	}
}

async function fileExists(absolutePath: string): Promise<boolean> {
	try {
		await access(absolutePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function normalizeSandboxPathKey(path: string): string {
	const isAbsolute = path.startsWith("/");
	const parts = path.split("/").reduce<string[]>((segments, segment) => {
		if (segment === "" || segment === ".") {
			return segments;
		}
		if (segment === "..") {
			if (segments.length > 0 && segments.at(-1) !== "..") {
				segments.pop();
			} else if (!isAbsolute) {
				segments.push(segment);
			}
			return segments;
		}
		segments.push(segment);
		return segments;
	}, []);
	const normalized = parts.join("/");
	return isAbsolute ? `/${normalized}` : normalized;
}

async function readFilesystemStateContent(
	state: StagedFileState,
	displayPath: string,
): Promise<string> {
	const currentContent = requireLoadedStateContent(state, displayPath);
	if (currentContent !== undefined) {
		return currentContent;
	}
	const content = await readExistingFile(state.absolutePath, displayPath);
	state.currentContent = content;
	return content;
}

async function readSandboxStateContent(
	state: StagedFileState,
	displayPath: string,
	sandbox: Sandbox,
	location = "",
): Promise<string> {
	const currentContent = requireLoadedStateContent(
		state,
		displayPath,
		location,
	);
	if (currentContent !== undefined) {
		return currentContent;
	}
	const content = await sandbox.readFile(displayPath);
	state.currentContent = content;
	return content;
}

function requireLoadedStateContent(
	state: StagedFileState,
	displayPath: string,
	location = "",
): string | undefined {
	const locationSuffix = location ? ` ${location}` : "";
	if (state.currentContent !== undefined) {
		if (state.currentContent !== null) {
			return state.currentContent;
		}
		throw new Error(`File not found${locationSuffix}: ${displayPath}`);
	}
	if (state.exists) {
		return undefined;
	}
	throw new Error(`File not found${locationSuffix}: ${displayPath}`);
}

function emptyPlan(): ApplyPatchPlan {
	return {
		filesModified: [],
		filesCreated: [],
		filesDeleted: [],
		hunksApplied: 0,
		hunksFailed: 0,
		changes: [],
	};
}

function addPlannedChange(
	plan: ApplyPatchPlan,
	change: PlannedFileChange,
): void {
	plan.changes.push(change);
	plan.hunksApplied += change.hunksApplied;
	if (change.operation === "add") {
		pushUnique(plan.filesCreated, change.path);
	} else if (change.operation === "delete") {
		pushUnique(plan.filesDeleted, change.path);
	} else {
		pushUnique(plan.filesModified, change.path);
	}
}

function pushUnique(values: string[], value: string): void {
	if (!values.includes(value)) {
		values.push(value);
	}
}

function recordConflicts(
	plan: ApplyPatchPlan,
	path: string,
	conflicts: string[],
): void {
	plan.hunksFailed += conflicts.length;
	plan.conflictDetails ??= [];
	for (const conflict of conflicts) {
		plan.conflictDetails.push(`${path}: ${conflict}`);
	}
}

function buildDetails(
	plan: ApplyPatchPlan,
	mode?: "sandbox",
): ApplyPatchToolDetails {
	return {
		filesModified: plan.filesModified,
		filesCreated: plan.filesCreated,
		filesDeleted: plan.filesDeleted,
		hunksApplied: plan.hunksApplied,
		hunksFailed: plan.hunksFailed,
		conflictDetails: plan.conflictDetails,
		diffs: buildDiffDetails(plan),
		editGrammar: "apply_patch",
		mode,
	};
}

function buildDiffDetails(plan: ApplyPatchPlan): Record<string, string> {
	const diffs: Record<string, string> = {};
	for (const change of plan.changes) {
		if (change.diff === undefined) {
			continue;
		}
		const existing = diffs[change.path];
		diffs[change.path] = existing ? `${existing}\n${change.diff}` : change.diff;
	}
	return diffs;
}

function countChangedFiles(plan: ApplyPatchPlan): number {
	return new Set([
		...plan.filesCreated,
		...plan.filesModified,
		...plan.filesDeleted,
	]).size;
}

function detectLineEnding(text: string): LineEnding {
	if (text.includes("\r\n")) return "\r\n";
	if (text.includes("\r")) return "\r";
	return "\n";
}

function normalizeDocument(content: string): NormalizedDocument {
	const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
	const withoutBom = bom ? content.slice(1) : content;
	const lineEnding = detectLineEnding(withoutBom);
	const normalized = withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const hadFinalNewline = normalized.endsWith("\n");
	const trimmed = hadFinalNewline ? normalized.slice(0, -1) : normalized;
	const lines = trimmed.length === 0 ? [] : trimmed.split("\n");
	return { original: content, lines, hadFinalNewline, bom, lineEnding };
}

function restoreDocumentContent(
	lines: string[],
	document: NormalizedDocument,
	finalNewline = document.hadFinalNewline,
): string {
	return `${document.bom}${serializeLines(lines, finalNewline).replace(/\n/g, document.lineEnding)}`;
}

function serializeLines(lines: string[], finalNewline: boolean): string {
	if (lines.length === 0) {
		return finalNewline ? "\n" : "";
	}
	return `${lines.join("\n")}${finalNewline ? "\n" : ""}`;
}
