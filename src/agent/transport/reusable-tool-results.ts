import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { isReadOnlyTool } from "../../tools/parallel-execution.js";
import type { AgentTool, ToolCall, ToolResultMessage } from "../types.js";
import { stableStringify } from "./stable-stringify.js";
import {
	type ObserveToolExecutionPlan,
	type PlatformToolExecutionBridge,
	type ToolExecutionBridgePlan,
	buildObservedResultMetadata,
	getDefaultPlatformToolExecutionBridge,
} from "./tool-execution-bridge.js";
import type {
	PendingExecution,
	ToolExecutionOutcome,
} from "./tool-update-queue.js";

const REUSABLE_TOOL_RESULT_GIT_SNAPSHOT_TIMEOUT_MS = 5_000;

export type ReusableToolResultEntry = {
	message: ToolResultMessage;
};

export type ReusableToolResultCacheGeneration = {
	value: number;
};

function hashReusableToolResultSnapshot(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function readGitSnapshotBuffer(cwd: string, args: string[]): Buffer {
	return execFileSync("git", args, {
		cwd,
		stdio: ["ignore", "pipe", "ignore"],
		timeout: REUSABLE_TOOL_RESULT_GIT_SNAPSHOT_TIMEOUT_MS,
	});
}

function readGitSnapshotPart(cwd: string, args: string[]): string {
	return readGitSnapshotBuffer(cwd, args).toString("utf8").trim();
}

function hashGitSnapshotPart(cwd: string, args: string[]): string {
	return hashReusableToolResultSnapshot(readGitSnapshotBuffer(cwd, args));
}

function hashUntrackedGitFiles(root: string): string {
	const files = readGitSnapshotBuffer(root, [
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
	])
		.toString("utf8")
		.split("\0")
		.filter(Boolean)
		.sort();
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file);
		hash.update("\0");
		hash.update(readFileSync(resolvePath(root, file)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

function hasDirtyGitSubmodules(root: string): boolean {
	try {
		return (
			readGitSnapshotPart(root, [
				"submodule",
				"foreach",
				"--recursive",
				"--quiet",
				"git status --porcelain=v1 --untracked-files=all",
			]).length > 0
		);
	} catch {
		return true;
	}
}

export function computeReusableToolResultSnapshot(
	cwd: string,
): string | undefined {
	try {
		const root = readGitSnapshotPart(cwd, ["rev-parse", "--show-toplevel"]);
		const head = readGitSnapshotPart(cwd, ["rev-parse", "--verify", "HEAD"]);
		const status = readGitSnapshotPart(root, [
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
		]);
		if (hasDirtyGitSubmodules(root)) {
			return undefined;
		}
		const unstagedDiff = hashGitSnapshotPart(root, [
			"diff",
			"--no-ext-diff",
			"--binary",
		]);
		const stagedDiff = hashGitSnapshotPart(root, [
			"diff",
			"--cached",
			"--no-ext-diff",
			"--binary",
		]);
		const untracked = hashUntrackedGitFiles(root);
		return `git:${hashReusableToolResultSnapshot(
			`${root}\n${head}\n${status}\n${unstagedDiff}\n${stagedDiff}\n${untracked}`,
		)}`;
	} catch {
		return undefined;
	}
}

const GIT_SNAPSHOT_REUSABLE_TOOL_NAMES = new Set([
	"read",
	"ls",
	"list",
	"glob",
	"find",
	"grep",
	"search",
	"parallel_ripgrep",
	"diff",
	"status",
]);

const REPO_PATH_ARGUMENTS_BY_TOOL = new Map<string, string[]>([
	["read", ["path", "file_path"]],
	["ls", ["path", "dir", "directory"]],
	["list", ["path", "dir", "directory"]],
	["glob", ["path", "cwd", "root", "glob"]],
	["find", ["path", "cwd", "root", "glob"]],
	["grep", ["path", "paths", "glob"]],
	["search", ["path", "paths", "glob"]],
	["parallel_ripgrep", ["path", "paths", "glob"]],
	["diff", ["path", "paths", "cwd"]],
	["status", ["path", "paths", "cwd"]],
]);

const GIT_SCOPED_REUSABLE_TOOL_RESULT_KEY_PREFIX = "git:";
const RUN_SCOPED_REUSABLE_TOOL_RESULT_KEY_PREFIX = "run:";
// Keep network-backed READ_ONLY_TOOLS out of reusable caches even if metadata is absent.
const NETWORK_BACKED_REUSABLE_TOOL_DENYLIST = new Set(["extract_document"]);

const REQUIRED_REPO_PATH_ARGUMENT_TOOLS = new Set(["read", "ls", "list"]);

function collectStringValues(value: unknown): string[] {
	if (typeof value === "string") {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.flatMap((item) => collectStringValues(item));
	}
	return [];
}

function isRepoRelativePathArgument(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return false;
	}
	if (
		trimmed.startsWith("/") ||
		trimmed.startsWith("~") ||
		trimmed.startsWith("\\\\") ||
		/^[A-Za-z]:[\\/]/.test(trimmed)
	) {
		return false;
	}
	return !trimmed.split(/[\\/]+/).includes("..");
}

function isGitIgnoredRepoPath(cwd: string, repoPath: string): boolean {
	try {
		readGitSnapshotPart(cwd, ["check-ignore", "--quiet", "--", repoPath]);
		return true;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"status" in error &&
			error.status === 1
		) {
			return false;
		}
		return true;
	}
}

function isToolCallIncludingIgnoredPaths(toolCall: ToolCall): boolean {
	const toolName = toolCall.name.toLowerCase();
	const args = toolCall.arguments;
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return false;
	}
	const record = args as Record<string, unknown>;
	if (toolName === "status") {
		return record.includeIgnored === true || record.include_ignored === true;
	}
	if (toolName === "search" || toolName === "parallel_ripgrep") {
		return record.useGitIgnore === false || record.use_git_ignore === false;
	}
	return false;
}

function hasRepoScopedReusableArguments(
	toolCall: ToolCall,
	cwd: string,
): boolean {
	const toolName = toolCall.name.toLowerCase();
	if (isToolCallIncludingIgnoredPaths(toolCall)) {
		return false;
	}
	const argumentNames = REPO_PATH_ARGUMENTS_BY_TOOL.get(toolName) ?? [];
	if (argumentNames.length === 0) {
		return true;
	}
	const args = toolCall.arguments;
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return !REQUIRED_REPO_PATH_ARGUMENT_TOOLS.has(toolName);
	}
	const pathValues = argumentNames.flatMap((name) =>
		collectStringValues((args as Record<string, unknown>)[name]),
	);
	if (
		pathValues.length === 0 &&
		REQUIRED_REPO_PATH_ARGUMENT_TOOLS.has(toolName)
	) {
		return false;
	}
	return pathValues.every(
		(pathValue) =>
			isRepoRelativePathArgument(pathValue) &&
			!isGitIgnoredRepoPath(cwd, pathValue),
	);
}

function isGitSnapshotReusableToolCall(
	tool: AgentTool,
	toolCall: ToolCall,
	cwd: string,
): boolean {
	if (
		tool.source !== undefined ||
		tool.annotations?.openWorldHint === true ||
		tool.executionLocation === "client"
	) {
		return false;
	}
	if (!GIT_SNAPSHOT_REUSABLE_TOOL_NAMES.has(tool.name.toLowerCase())) {
		return false;
	}
	if (!isReadOnlyTool(tool.name, tool.annotations, tool.source)) {
		return false;
	}
	return hasRepoScopedReusableArguments(toolCall, cwd);
}

export type ToolDefinitionLookup = ReadonlyMap<string, AgentTool> | AgentTool[];

export type ToolMetadataCache = {
	readonly definitions: ReadonlyMap<string, AgentTool>;
	readonly reusableToolResultCwd: string;
	lookupCount: number;
	get(toolName: string): AgentTool | undefined;
};

const reusableToolDefinitionIdentities = new WeakMap<object, number>();
let reusableToolDefinitionIdentityCounter = 0;

function getReusableToolDefinitionIdentity(value: object): number {
	const existing = reusableToolDefinitionIdentities.get(value);
	if (existing !== undefined) {
		return existing;
	}
	reusableToolDefinitionIdentityCounter += 1;
	reusableToolDefinitionIdentities.set(
		value,
		reusableToolDefinitionIdentityCounter,
	);
	return reusableToolDefinitionIdentityCounter;
}

function getReusableToolFunctionIdentity(value: unknown): number | undefined {
	return typeof value === "function"
		? getReusableToolDefinitionIdentity(value)
		: undefined;
}

export function getReusableToolRegistrySignature(
	tools: readonly AgentTool[],
): string {
	return stableStringify(
		tools.map((tool) => ({
			allowedCallers: tool.allowedCallers,
			annotations: tool.annotations,
			deferApiDefinition: tool.deferApiDefinition,
			description: tool.description,
			executeIdentity: getReusableToolFunctionIdentity(tool.execute),
			executionLocation: tool.executionLocation,
			getActivityDescriptionIdentity: getReusableToolFunctionIdentity(
				tool.getActivityDescription,
			),
			getDisplayNameIdentity: getReusableToolFunctionIdentity(
				tool.getDisplayName,
			),
			getToolUseSummaryIdentity: getReusableToolFunctionIdentity(
				tool.getToolUseSummary,
			),
			inputExamples: tool.inputExamples,
			label: tool.label,
			maxRetries: tool.maxRetries,
			name: tool.name,
			parameters: tool.parameters,
			retryDelayMs: tool.retryDelayMs,
			shouldRetryIdentity: getReusableToolFunctionIdentity(tool.shouldRetry),
			source: tool.source,
			toolIdentity: getReusableToolDefinitionIdentity(tool),
			toolType: tool.toolType,
		})),
	);
}

export function createToolMetadataCache(
	tools: AgentTool[],
	reusableToolResultCwd = process.cwd(),
): ToolMetadataCache {
	const definitions = new Map(tools.map((tool) => [tool.name, tool]));
	return {
		definitions,
		reusableToolResultCwd,
		lookupCount: 0,
		get(toolName: string): AgentTool | undefined {
			this.lookupCount += 1;
			return definitions.get(toolName);
		},
	};
}

function getToolDefinition(
	lookup: ToolDefinitionLookup | ToolMetadataCache,
	toolName: string,
): AgentTool | undefined {
	if ("get" in lookup && !Array.isArray(lookup)) {
		return lookup.get(toolName);
	}
	return lookup.find((candidate) => candidate.name === toolName);
}

export function getReusableToolResultCacheKey(
	toolCall: ToolCall,
	tools: ToolDefinitionLookup | ToolMetadataCache,
): string | undefined {
	const tool = getToolDefinition(tools, toolCall.name);
	const cwd =
		"reusableToolResultCwd" in tools
			? tools.reusableToolResultCwd
			: process.cwd();
	if (!tool || tool.annotations?.destructiveHint === true) {
		return undefined;
	}
	if (!isReadOnlyTool(tool.name, tool.annotations, tool.source)) {
		return undefined;
	}
	const toolName = tool.name.toLowerCase();
	const cacheKey = `${toolCall.name}:${stableStringify(toolCall.arguments)}`;
	if (NETWORK_BACKED_REUSABLE_TOOL_DENYLIST.has(toolName)) {
		return undefined;
	}
	if (isGitSnapshotReusableToolCall(tool, toolCall, cwd)) {
		return `${GIT_SCOPED_REUSABLE_TOOL_RESULT_KEY_PREFIX}${cacheKey}`;
	}
	if (
		tool.source !== undefined ||
		GIT_SNAPSHOT_REUSABLE_TOOL_NAMES.has(toolName) ||
		tool.annotations?.openWorldHint === true ||
		tool.executionLocation === "client"
	) {
		return undefined;
	}
	return `${RUN_SCOPED_REUSABLE_TOOL_RESULT_KEY_PREFIX}${cacheKey}`;
}

function isReadOnlyToolCallForCacheInvalidation(
	toolCall: ToolCall,
	tools: ToolDefinitionLookup | ToolMetadataCache,
): boolean {
	const tool = getToolDefinition(tools, toolCall.name);
	return tool
		? isReadOnlyTool(tool.name, tool.annotations, tool.source)
		: false;
}

function cloneToolResultForCache(
	message: ToolResultMessage,
): ToolResultMessage {
	return {
		...message,
		content: message.content.map((item) => ({ ...item })),
	};
}

export function cloneToolOutcomeForCall(
	outcome: ToolExecutionOutcome,
	toolCall: ToolCall,
	timestamp: number,
): ToolExecutionOutcome {
	return {
		message: {
			...outcome.message,
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: outcome.message.content.map((item) => ({ ...item })),
			timestamp,
		},
		isError: outcome.isError,
	};
}

export function resolvePlatformToolExecutionBridge(
	option: PlatformToolExecutionBridge | false | undefined,
): PlatformToolExecutionBridge | undefined {
	if (option === false) {
		return undefined;
	}
	return option ?? getDefaultPlatformToolExecutionBridge();
}

export async function recordReusableToolExecutionBridgeOutput({
	bridge,
	plan,
	outcome,
	durationMs,
	signal,
}: {
	bridge?: PlatformToolExecutionBridge;
	plan?: ToolExecutionBridgePlan;
	outcome: ToolExecutionOutcome;
	durationMs: number;
	signal?: AbortSignal;
}): Promise<ToolExecutionOutcome> {
	if (!bridge || !plan) {
		return outcome;
	}
	const observed =
		plan.kind === "observe"
			? await bridge.recordObservation(
					plan as ObserveToolExecutionPlan,
					outcome.message,
					signal,
				)
			: undefined;
	const governedOutput =
		plan.kind === "governed"
			? await bridge.recordGovernedOutput(
					plan,
					outcome.message,
					durationMs,
					signal,
				)
			: undefined;
	return {
		...outcome,
		...buildObservedResultMetadata(plan, observed ?? governedOutput),
	};
}

export function hasReusableToolResultState(
	cacheKey: string,
	cache: Map<string, ReusableToolResultEntry>,
	pending: Map<string, Promise<ToolExecutionOutcome>>,
	policyCheckedKeys: Set<string>,
	pendingSafetyChecks: Map<string, number>,
): boolean {
	return (
		cache.has(cacheKey) ||
		pending.has(cacheKey) ||
		policyCheckedKeys.has(cacheKey) ||
		(pendingSafetyChecks.get(cacheKey) ?? 0) > 0
	);
}

export function incrementPendingReusableToolSafetyCheck(
	cacheKey: string | undefined,
	pendingSafetyChecks: Map<string, number>,
): void {
	if (!cacheKey) {
		return;
	}
	pendingSafetyChecks.set(
		cacheKey,
		(pendingSafetyChecks.get(cacheKey) ?? 0) + 1,
	);
}

export function decrementPendingReusableToolSafetyCheck(
	cacheKey: string | undefined,
	pendingSafetyChecks: Map<string, number>,
): void {
	if (!cacheKey) {
		return;
	}
	const nextCount = (pendingSafetyChecks.get(cacheKey) ?? 0) - 1;
	if (nextCount <= 0) {
		pendingSafetyChecks.delete(cacheKey);
		return;
	}
	pendingSafetyChecks.set(cacheKey, nextCount);
}

export function clearReusableToolResultState(
	cache: Map<string, ReusableToolResultEntry>,
	pending: Map<string, Promise<ToolExecutionOutcome>>,
	policyCheckedKeys: Set<string>,
	pendingSafetyChecks: Map<string, number>,
	cacheGeneration: ReusableToolResultCacheGeneration,
): void {
	cache.clear();
	pending.clear();
	policyCheckedKeys.clear();
	pendingSafetyChecks.clear();
	cacheGeneration.value += 1;
}

export function clearRunScopedReusableToolResultState(
	cache: Map<string, ReusableToolResultEntry>,
	pending: Map<string, Promise<ToolExecutionOutcome>>,
	policyCheckedKeys: Set<string>,
	pendingSafetyChecks: Map<string, number>,
	cacheGeneration: ReusableToolResultCacheGeneration,
): void {
	let cleared = false;
	for (const key of cache.keys()) {
		if (key.startsWith(RUN_SCOPED_REUSABLE_TOOL_RESULT_KEY_PREFIX)) {
			cache.delete(key);
			cleared = true;
		}
	}
	for (const key of pending.keys()) {
		if (key.startsWith(RUN_SCOPED_REUSABLE_TOOL_RESULT_KEY_PREFIX)) {
			pending.delete(key);
			cleared = true;
		}
	}
	for (const key of policyCheckedKeys) {
		if (key.startsWith(RUN_SCOPED_REUSABLE_TOOL_RESULT_KEY_PREFIX)) {
			policyCheckedKeys.delete(key);
			cleared = true;
		}
	}
	for (const key of pendingSafetyChecks.keys()) {
		if (key.startsWith(RUN_SCOPED_REUSABLE_TOOL_RESULT_KEY_PREFIX)) {
			pendingSafetyChecks.delete(key);
			cleared = true;
		}
	}
	if (cleared) {
		cacheGeneration.value += 1;
	}
}

export function invalidateReusableToolResultsAfterMutation(
	toolCall: ToolCall,
	tools: ToolDefinitionLookup | ToolMetadataCache,
	cache: Map<string, ReusableToolResultEntry>,
	pending: Map<string, Promise<ToolExecutionOutcome>>,
	policyCheckedKeys: Set<string>,
	pendingSafetyChecks: Map<string, number>,
	cacheGeneration: ReusableToolResultCacheGeneration,
): void {
	if (isReadOnlyToolCallForCacheInvalidation(toolCall, tools)) {
		return;
	}
	clearReusableToolResultState(
		cache,
		pending,
		policyCheckedKeys,
		pendingSafetyChecks,
		cacheGeneration,
	);
}

export function hasPendingMutatingToolExecution(
	pendingExecutions: readonly PendingExecution[],
	tools: ToolDefinitionLookup | ToolMetadataCache,
): boolean {
	return pendingExecutions.some(
		(execution) =>
			!isReadOnlyToolCallForCacheInvalidation(execution.toolCall, tools),
	);
}

export function trackReusableToolResult(
	cacheKey: string,
	executionPromise: Promise<ToolExecutionOutcome>,
	cache: Map<string, ReusableToolResultEntry>,
	pending: Map<string, Promise<ToolExecutionOutcome>>,
	policyCheckedKeys?: Set<string>,
	cacheGeneration?: ReusableToolResultCacheGeneration,
): Promise<ToolExecutionOutcome> {
	const trackedGeneration = cacheGeneration?.value;
	const trackedPromise = executionPromise
		.then((outcome) => {
			if (
				!outcome.isError &&
				outcome.message.isError !== true &&
				(cacheGeneration === undefined ||
					cacheGeneration.value === trackedGeneration)
			) {
				cache.set(cacheKey, {
					message: cloneToolResultForCache(outcome.message),
				});
			} else {
				policyCheckedKeys?.delete(cacheKey);
			}
			return outcome;
		})
		.catch((error) => {
			policyCheckedKeys?.delete(cacheKey);
			throw error;
		})
		.finally(() => {
			if (pending.get(cacheKey) === trackedPromise) {
				pending.delete(cacheKey);
			}
		});
	pending.set(cacheKey, trackedPromise);
	return trackedPromise;
}
