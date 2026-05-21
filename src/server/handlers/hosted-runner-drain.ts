import { execFile } from "node:child_process";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
	CODEX_SUBAGENT_TOOL_PREFIX,
	CODEX_SUBAGENT_WORK_GRAPH_SCHEMA,
	HEADLESS_PROTOCOL_VERSION,
	type HeadlessCodexSubagentContinuityEdge,
	activeCodexSubagentStatus,
	buildCodexSubagentContinuityEdges,
	codexSubagentEdgeKey,
	codexSubagentOperation,
	codexSubagentStatusIsTerminal,
	createHeadlessRuntimeState,
	stringArray,
} from "../../cli/headless-protocol.js";
import type { HostedRunnerContext, WebServerContext } from "../app-context.js";
import type { HeadlessRuntimeSnapshot } from "../headless-runtime-service.js";
import { markHostedRunnerLeaseDraining } from "../hosted-runner-lease.js";
import { ApiError, readJsonBody, sendJson } from "../server-utils.js";

const execFileAsync = promisify(execFile);

export const HOSTED_RUNNER_DRAIN_PATH =
	"/.well-known/evalops/remote-runner/drain";

export const HOSTED_RUNNER_DRAIN_PROTOCOL_VERSION =
	"evalops.remote-runner.drain.v1";

export const HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION =
	"evalops.remote-runner.snapshot-manifest.v1";

export const HOSTED_RUNNER_RETENTION_POLICY_VERSION =
	"evalops.remote-runner.retention.v1";

export const HOSTED_RUNNER_WORK_CONTINUITY_VERSION =
	"evalops.remote-runner.work-continuity.v1";

export const HOSTED_RUNNER_PLATFORM_EVIDENCE_VERSION =
	"evalops.remote-runner.platform-evidence.v1";

export enum HostedRunnerDrainStatusValue {
	Drained = "drained",
	Interrupted = "interrupted",
}

export enum HostedRunnerRuntimeFlushStatusValue {
	Completed = "completed",
	Failed = "failed",
	Skipped = "skipped",
}

export enum HostedRunnerWorkspaceExportPathTypeValue {
	File = "file",
	Directory = "directory",
	Other = "other",
}

export enum HostedRunnerWorkspaceExportModeValue {
	LocalPathContract = "local_path_contract",
}

export enum HostedRunnerDrainReasonValue {
	KubernetesPreStop = "kubernetes_prestop",
	ProcessShutdown = "process_shutdown",
}

export enum HostedRunnerDrainRequestedByValue {
	KubernetesPreStop = "kubernetes_prestop",
	MaestroWebServer = "maestro_web_server",
}

export type HostedRunnerDrainStatus = HostedRunnerDrainStatusValue;
export type HostedRunnerRuntimeFlushStatus =
	HostedRunnerRuntimeFlushStatusValue;
export type HostedRunnerWorkspaceExportPathType =
	HostedRunnerWorkspaceExportPathTypeValue;
export type HostedRunnerWorkspaceExportMode =
	HostedRunnerWorkspaceExportModeValue;
export type HostedRunnerDrainReason = HostedRunnerDrainReasonValue | string;
export type HostedRunnerDrainRequestedBy =
	| HostedRunnerDrainRequestedByValue
	| string;

export interface HostedRunnerRetentionPolicy {
	policy_version: typeof HOSTED_RUNNER_RETENTION_POLICY_VERSION;
	managed_by: "platform";
	visibility: {
		control_plane_metadata: "operator";
		workspace_export: "tenant";
		runtime_snapshot: "internal";
		runtime_logs: "operator";
	};
	redaction: {
		required_before_external_persistence: Array<
			"runtime_snapshot" | "runtime_logs"
		>;
		forbidden_plaintext: Array<
			| "provider_credentials"
			| "tool_secrets"
			| "attach_tokens"
			| "artifact_access_tokens"
			| "raw_environment"
		>;
	};
}

export interface HostedRunnerDrainInput {
	reason?: HostedRunnerDrainReason;
	requestedBy?: HostedRunnerDrainRequestedBy;
	exportPaths?: string[];
}

export interface HostedRunnerRuntimeDrainResult {
	sessionId: string;
	sessionFile?: string;
	protocolVersion?: string;
	cursor?: number;
	snapshot?: HeadlessRuntimeSnapshot;
	recordPlatformDrain?: (
		input: HostedRunnerPlatformDrainRecordInput,
	) => Promise<void>;
}

class HostedRunnerRuntimeDrainError extends Error {
	readonly sessionId: string;
	readonly sessionFile?: string;
	readonly protocolVersion?: string;
	readonly cursor?: number;
	readonly snapshot?: HeadlessRuntimeSnapshot;
	readonly recordPlatformDrain?: (
		input: HostedRunnerPlatformDrainRecordInput,
	) => Promise<void>;

	constructor(message: string, runtime: HostedRunnerRuntimeDrainResult) {
		super(message);
		this.name = "HostedRunnerRuntimeDrainError";
		this.sessionId = runtime.sessionId;
		this.sessionFile = runtime.sessionFile;
		this.protocolVersion = runtime.protocolVersion;
		this.cursor = runtime.cursor;
		this.snapshot = runtime.snapshot;
		this.recordPlatformDrain = runtime.recordPlatformDrain;
	}
}

export interface HostedRunnerWorkspaceExportPath {
	input: string;
	path: string;
	relative_path: string;
	type: HostedRunnerWorkspaceExportPathType;
}

export interface HostedRunnerSnapshotManifest {
	protocol_version: typeof HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION;
	runner_session_id: string;
	workspace_id?: string;
	agent_run_id?: string;
	maestro_session_id: string;
	reason?: string;
	requested_by?: string;
	created_at: string;
	workspace_root: string;
	runtime: {
		flush_status: HostedRunnerRuntimeFlushStatus;
		error?: string;
		session_id: string;
		session_file?: string;
		protocol_version?: string;
		cursor?: number;
	};
	workspace_export: {
		mode: HostedRunnerWorkspaceExportMode;
		paths: HostedRunnerWorkspaceExportPath[];
	};
	work_continuity: HostedRunnerWorkContinuity;
	platform_evidence: HostedRunnerPlatformEvidence;
	snapshot: HeadlessRuntimeSnapshot;
	retention_policy: HostedRunnerRetentionPolicy;
	git?: {
		commit?: string;
		branch?: string;
		dirty?: boolean;
	};
}

export interface HostedRunnerWorkContinuity {
	protocol_version: typeof HOSTED_RUNNER_WORK_CONTINUITY_VERSION;
	codex_subagent_schema_version: typeof CODEX_SUBAGENT_WORK_GRAPH_SCHEMA;
	active_tool_count: number;
	tracked_tool_count: number;
	pending_request_count: number;
	codex_subagent_tool_call_ids: string[];
	codex_subagent_child_run_ids: string[];
	codex_subagent_thread_ids: string[];
	codex_subagent_edges?: HeadlessCodexSubagentContinuityEdge[];
}

export interface HostedRunnerPlatformEvidence {
	protocol_version: typeof HOSTED_RUNNER_PLATFORM_EVIDENCE_VERSION;
	event_type: "hosted_runner_drain_manifest_recorded";
	runner_session_id: string;
	workspace_id?: string;
	agent_run_id?: string;
	maestro_session_id: string;
	status: HostedRunnerDrainStatus;
	runtime_flush_status: HostedRunnerRuntimeFlushStatus;
	manifest_path: string;
	manifest_protocol_version: typeof HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION;
	created_at: string;
	reason?: string;
	requested_by?: string;
	work_continuity: {
		protocol_version: typeof HOSTED_RUNNER_WORK_CONTINUITY_VERSION;
		codex_subagent_schema_version: typeof CODEX_SUBAGENT_WORK_GRAPH_SCHEMA;
		active_tool_count: number;
		tracked_tool_count: number;
		pending_request_count: number;
		codex_subagent_tool_call_count: number;
		codex_subagent_child_run_count: number;
		codex_subagent_thread_count: number;
		codex_subagent_edge_count: number;
		codex_subagent_tool_call_ids: string[];
		codex_subagent_child_run_ids: string[];
		codex_subagent_thread_ids: string[];
		codex_subagent_edges?: HeadlessCodexSubagentContinuityEdge[];
	};
	retention: {
		policy_version: typeof HOSTED_RUNNER_RETENTION_POLICY_VERSION;
		control_plane_metadata_visibility: "operator";
		runtime_snapshot_visibility: "internal";
		redaction_required_before_external_persistence: Array<
			"runtime_snapshot" | "runtime_logs"
		>;
	};
	evidence_refs: string[];
}

export interface HostedRunnerPlatformDrainRecordInput {
	status: HostedRunnerDrainStatus;
	reason?: string;
	requestedBy?: string;
	flushStatus: HostedRunnerRuntimeFlushStatus;
	manifestPath: string;
	platformEvidence: HostedRunnerPlatformEvidence;
	errorMessage?: string;
}

export interface HostedRunnerDrainResult {
	status: HostedRunnerDrainStatus;
	runner_session_id: string;
	reason?: string;
	requested_by?: string;
	manifest_path: string;
	manifest: HostedRunnerSnapshotManifest;
}

export interface DrainHostedRunnerOptions {
	hostedRunner?: HostedRunnerContext;
	drainRuntime?: (
		sessionId: string,
		terminal: HostedRunnerRuntimeTerminalInput,
	) => Promise<HostedRunnerRuntimeDrainResult | null>;
	now?: () => Date;
}

interface HostedRunnerDrainRuntimeContext {
	hostedRunner?: HostedRunnerContext;
	headlessRuntimeService: Pick<
		WebServerContext["headlessRuntimeService"],
		"getRuntimeBySessionId"
	>;
}

export interface DrainHostedRunnerForShutdownOptions {
	now?: () => Date;
	reason?: HostedRunnerDrainReason;
	requestedBy?: HostedRunnerDrainRequestedBy;
}

interface HostedRunnerRuntimeTerminalInput {
	reason?: HostedRunnerDrainReason;
	requestedBy?: HostedRunnerDrainRequestedBy;
	manifestPath?: string;
}

function getString(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new ApiError(400, `${field} must be a string`);
	}
	const trimmed = value.trim();
	return trimmed || undefined;
}

function getStringArray(value: unknown, field: string): string[] | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new ApiError(400, `${field} must be an array of strings`);
	}
	const strings = value.map((entry, index) => {
		if (typeof entry !== "string" || !entry.trim()) {
			throw new ApiError(400, `${field}[${index}] must be a non-empty string`);
		}
		if (entry.includes("\0")) {
			throw new ApiError(400, `${field}[${index}] contains a null byte`);
		}
		return entry.trim();
	});
	return strings.length ? strings : undefined;
}

export function parseHostedRunnerDrainInput(
	body: unknown,
): HostedRunnerDrainInput {
	if (body === undefined || body === null) {
		return {};
	}
	if (typeof body !== "object" || Array.isArray(body)) {
		throw new ApiError(400, "Drain payload must be a JSON object");
	}
	const record = body as Record<string, unknown>;
	return {
		reason:
			getString(record.reason, "reason") ??
			getString(record.stop_reason, "stop_reason"),
		requestedBy:
			getString(record.requested_by, "requested_by") ??
			getString(record.requestedBy, "requestedBy"),
		exportPaths:
			getStringArray(record.export_paths, "export_paths") ??
			getStringArray(record.exportPaths, "exportPaths"),
	};
}

function isWithinPath(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeManifestFileName(
	runnerSessionId: string,
	requestedAt: string,
): string {
	const safeSession = runnerSessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
	const safeTimestamp = requestedAt.replace(/[^A-Za-z0-9_.-]/g, "_");
	return `${safeSession}-${safeTimestamp}.json`;
}

async function resolveWorkspaceRoot(
	hostedRunner: HostedRunnerContext,
): Promise<string> {
	try {
		const workspaceRoot = await realpath(hostedRunner.workspaceRoot);
		const stats = await stat(workspaceRoot);
		if (!stats.isDirectory()) {
			throw new ApiError(
				503,
				"Hosted runner workspace root is not a directory",
			);
		}
		return workspaceRoot;
	} catch (error) {
		if (error instanceof ApiError) {
			throw error;
		}
		throw new ApiError(
			503,
			`Hosted runner workspace root is unavailable: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

async function resolveWorkspaceExportPaths(
	workspaceRoot: string,
	exportPaths: readonly string[] | undefined,
): Promise<HostedRunnerWorkspaceExportPath[]> {
	const requested = exportPaths?.length ? exportPaths : ["."];
	const paths: HostedRunnerWorkspaceExportPath[] = [];
	for (const input of requested) {
		const logicalPath = isAbsolute(input)
			? resolve(input)
			: resolve(workspaceRoot, input);
		let realPath: string;
		try {
			realPath = await realpath(logicalPath);
		} catch (error) {
			throw new ApiError(
				400,
				`Export path is unavailable: ${input} (${
					error instanceof Error ? error.message : String(error)
				})`,
			);
		}
		if (!isWithinPath(workspaceRoot, realPath)) {
			throw new ApiError(
				400,
				`Export path escapes hosted runner workspace root: ${input}`,
			);
		}
		const pathStat = await stat(realPath);
		paths.push({
			input,
			path: realPath,
			relative_path: relative(workspaceRoot, realPath) || ".",
			type: pathStat.isDirectory()
				? HostedRunnerWorkspaceExportPathTypeValue.Directory
				: pathStat.isFile()
					? HostedRunnerWorkspaceExportPathTypeValue.File
					: HostedRunnerWorkspaceExportPathTypeValue.Other,
		});
	}
	return paths;
}

async function gitOutput(
	workspaceRoot: string,
	args: readonly string[],
): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["-C", workspaceRoot, ...args],
			{
				encoding: "utf8",
				timeout: 1000,
			},
		);
		const output = stdout.trim();
		return output || undefined;
	} catch {
		return undefined;
	}
}

async function collectGitState(
	workspaceRoot: string,
): Promise<HostedRunnerSnapshotManifest["git"] | undefined> {
	const [commit, branch, status] = await Promise.all([
		gitOutput(workspaceRoot, ["rev-parse", "HEAD"]),
		gitOutput(workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
		gitOutput(workspaceRoot, ["status", "--porcelain"]),
	]);
	if (!commit && !branch && status === undefined) {
		return undefined;
	}
	return {
		...(commit ? { commit } : {}),
		...(branch && branch !== "HEAD" ? { branch } : {}),
		dirty: Boolean(status),
	};
}

function buildHostedRunnerSnapshot(
	sessionId: string,
	workspaceRoot: string,
	runtime: HostedRunnerSnapshotManifest["runtime"],
): HeadlessRuntimeSnapshot {
	const state = createHeadlessRuntimeState();
	state.protocol_version =
		runtime.protocol_version ?? HEADLESS_PROTOCOL_VERSION;
	state.session_id = sessionId;
	state.cwd = workspaceRoot;
	state.provider = "typescript";
	state.model = "typescript-hosted-runner";
	state.is_ready =
		runtime.flush_status === HostedRunnerRuntimeFlushStatusValue.Completed;
	state.last_status =
		runtime.flush_status === HostedRunnerRuntimeFlushStatusValue.Completed
			? "Drained"
			: runtime.flush_status === HostedRunnerRuntimeFlushStatusValue.Failed
				? "Drain interrupted before runtime flush completed"
				: "Drain skipped: no runtime activity was available";
	if (runtime.error) {
		state.last_error = runtime.error;
		state.last_error_type = "protocol";
	}
	return {
		protocolVersion: runtime.protocol_version ?? HEADLESS_PROTOCOL_VERSION,
		session_id: sessionId,
		cursor: runtime.cursor ?? 0,
		last_init: null,
		state,
	};
}

function buildHostedRunnerRetentionPolicy(): HostedRunnerRetentionPolicy {
	return {
		policy_version: HOSTED_RUNNER_RETENTION_POLICY_VERSION,
		managed_by: "platform",
		visibility: {
			control_plane_metadata: "operator",
			workspace_export: "tenant",
			runtime_snapshot: "internal",
			runtime_logs: "operator",
		},
		redaction: {
			required_before_external_persistence: [
				"runtime_snapshot",
				"runtime_logs",
			],
			forbidden_plaintext: [
				"provider_credentials",
				"tool_secrets",
				"attach_tokens",
				"artifact_access_tokens",
				"raw_environment",
			],
		},
	};
}

function buildHostedRunnerPlatformEvidence(input: {
	hostedRunner: HostedRunnerContext;
	status: HostedRunnerDrainStatus;
	maestroSessionId: string;
	createdAt: string;
	manifestPath: string;
	runtime: HostedRunnerSnapshotManifest["runtime"];
	workContinuity: HostedRunnerWorkContinuity;
	retentionPolicy: HostedRunnerRetentionPolicy;
	reason?: string;
	requestedBy?: string;
}): HostedRunnerPlatformEvidence {
	const edges = input.workContinuity.codex_subagent_edges ?? [];
	return {
		protocol_version: HOSTED_RUNNER_PLATFORM_EVIDENCE_VERSION,
		event_type: "hosted_runner_drain_manifest_recorded",
		runner_session_id: input.hostedRunner.runnerSessionId,
		...(input.hostedRunner.workspaceId
			? { workspace_id: input.hostedRunner.workspaceId }
			: {}),
		...(input.hostedRunner.agentRunId
			? { agent_run_id: input.hostedRunner.agentRunId }
			: {}),
		maestro_session_id: input.maestroSessionId,
		status: input.status,
		runtime_flush_status: input.runtime.flush_status,
		manifest_path: input.manifestPath,
		manifest_protocol_version: HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION,
		created_at: input.createdAt,
		...(input.reason ? { reason: input.reason } : {}),
		...(input.requestedBy ? { requested_by: input.requestedBy } : {}),
		work_continuity: {
			protocol_version: input.workContinuity.protocol_version,
			codex_subagent_schema_version:
				input.workContinuity.codex_subagent_schema_version,
			active_tool_count: input.workContinuity.active_tool_count,
			tracked_tool_count: input.workContinuity.tracked_tool_count,
			pending_request_count: input.workContinuity.pending_request_count,
			codex_subagent_tool_call_count:
				input.workContinuity.codex_subagent_tool_call_ids.length,
			codex_subagent_child_run_count:
				input.workContinuity.codex_subagent_child_run_ids.length,
			codex_subagent_thread_count:
				input.workContinuity.codex_subagent_thread_ids.length,
			codex_subagent_edge_count: edges.length,
			codex_subagent_tool_call_ids:
				input.workContinuity.codex_subagent_tool_call_ids,
			codex_subagent_child_run_ids:
				input.workContinuity.codex_subagent_child_run_ids,
			codex_subagent_thread_ids: input.workContinuity.codex_subagent_thread_ids,
			...(edges.length > 0 ? { codex_subagent_edges: edges } : {}),
		},
		retention: {
			policy_version: input.retentionPolicy.policy_version,
			control_plane_metadata_visibility:
				input.retentionPolicy.visibility.control_plane_metadata,
			runtime_snapshot_visibility:
				input.retentionPolicy.visibility.runtime_snapshot,
			redaction_required_before_external_persistence:
				input.retentionPolicy.redaction.required_before_external_persistence,
		},
		evidence_refs: [
			`remote-runner://sessions/${input.hostedRunner.runnerSessionId}/drain#manifest`,
			`maestro://headless/sessions/${input.maestroSessionId}#drain`,
			...(input.hostedRunner.agentRunId
				? [`platform-agent-run:${input.hostedRunner.agentRunId}`]
				: []),
		],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function collectCodexSubagentEdgesFromSource(
	source: {
		call_id: string;
		tool_execution_id?: string;
		tool: string;
		args?: unknown;
	},
	edges: Map<string, HeadlessCodexSubagentContinuityEdge>,
): void {
	const operation = codexSubagentOperation(source.tool);
	if (!operation) {
		return;
	}
	const status = activeCodexSubagentStatus(operation);
	for (const edge of buildCodexSubagentContinuityEdges({
		call_id: source.call_id,
		tool_execution_id: source.tool_execution_id,
		tool: source.tool,
		args: source.args,
		status,
	})) {
		edges.set(codexSubagentEdgeKey(edge), edge);
	}
}

function collectCodexWorkArgs(
	args: unknown,
	childRunIds: Set<string>,
	threadIds: Set<string>,
	includeLooseArgs = false,
): boolean {
	if (!isRecord(args)) {
		return false;
	}
	const graph = args.codexWorkGraph ?? args.codex_work_graph;
	const hasCodexGraph =
		isRecord(graph) &&
		(graph.schemaVersion === CODEX_SUBAGENT_WORK_GRAPH_SCHEMA ||
			graph.schema_version === CODEX_SUBAGENT_WORK_GRAPH_SCHEMA);
	if (!includeLooseArgs && !hasCodexGraph) {
		return false;
	}
	for (const childRunId of stringArray(
		args.childRunIds ?? args.child_run_ids,
	)) {
		childRunIds.add(childRunId);
	}
	for (const threadId of stringArray(
		args.receiverThreadIds ?? args.receiver_thread_ids,
	)) {
		threadIds.add(threadId);
	}
	if (isRecord(graph)) {
		const graphChildRuns = graph.childRuns ?? graph.child_runs;
		for (const childRun of Array.isArray(graphChildRuns)
			? graphChildRuns
			: []) {
			if (!isRecord(childRun)) {
				continue;
			}
			const childRunId = childRun.childRunId ?? childRun.child_run_id;
			if (typeof childRunId === "string" && childRunId) {
				childRunIds.add(childRunId);
			}
			const threadId = childRun.threadId ?? childRun.thread_id;
			if (typeof threadId === "string" && threadId) {
				threadIds.add(threadId);
			}
		}
	}
	return includeLooseArgs || hasCodexGraph;
}

function collectHostedRunnerWorkContinuity(
	snapshot: HeadlessRuntimeSnapshot,
): HostedRunnerWorkContinuity {
	const state = snapshot.state;
	const codexToolCallIds = new Set<string>();
	const childRunIds = new Set<string>();
	const threadIds = new Set<string>();
	const codexSubagentEdges = new Map<
		string,
		HeadlessCodexSubagentContinuityEdge
	>();
	for (const edge of state.codex_subagent_edges ?? []) {
		codexSubagentEdges.set(codexSubagentEdgeKey(edge), edge);
		if (edge.spawn_tool_call_id) {
			codexToolCallIds.add(edge.spawn_tool_call_id);
		}
		if (edge.wait_tool_call_id) {
			codexToolCallIds.add(edge.wait_tool_call_id);
		}
		if (edge.child_run_id) {
			childRunIds.add(edge.child_run_id);
		}
		if (edge.thread_id) {
			threadIds.add(edge.thread_id);
		}
	}
	const trackedSources = [
		...state.tracked_tools,
		...state.pending_approvals,
		...state.pending_client_tools,
		...state.pending_mcp_elicitations,
		...state.pending_user_inputs,
		...state.pending_tool_retries,
	];
	const codexTrackedSourceCallIds = new Set<string>();
	for (const source of trackedSources) {
		const tool = source.tool;
		const isCodexSubagentTool = tool.startsWith(CODEX_SUBAGENT_TOOL_PREFIX);
		const hasCodexWorkArgs = collectCodexWorkArgs(
			source.args,
			childRunIds,
			threadIds,
			isCodexSubagentTool,
		);
		if (isCodexSubagentTool || hasCodexWorkArgs) {
			codexTrackedSourceCallIds.add(source.call_id);
			codexToolCallIds.add(source.call_id);
			collectCodexSubagentEdgesFromSource(source, codexSubagentEdges);
		}
	}
	for (const activeTool of state.active_tools) {
		if (activeTool.tool.startsWith(CODEX_SUBAGENT_TOOL_PREFIX)) {
			const hasTrackedSource = codexToolCallIds.has(activeTool.call_id);
			codexToolCallIds.add(activeTool.call_id);
			if (!hasTrackedSource) {
				collectCodexSubagentEdgesFromSource(
					{ call_id: activeTool.call_id, tool: activeTool.tool },
					codexSubagentEdges,
				);
			}
		}
	}
	const sortedEdges = [...codexSubagentEdges.values()].sort((left, right) =>
		codexSubagentEdgeKey(left).localeCompare(codexSubagentEdgeKey(right)),
	);
	const activeCodexSubagentEdgeCount = sortedEdges.filter(
		(edge) => !codexSubagentStatusIsTerminal(edge.status),
	).length;
	const nonCodexActiveToolCount = state.active_tools.filter(
		(tool) => !tool.tool.startsWith(CODEX_SUBAGENT_TOOL_PREFIX),
	).length;
	const nonCodexTrackedToolCount = state.tracked_tools.filter(
		(tool) => !codexTrackedSourceCallIds.has(tool.call_id),
	).length;
	const trackedCodexSubagentCount = Math.max(
		codexToolCallIds.size,
		sortedEdges.length,
	);
	return {
		protocol_version: HOSTED_RUNNER_WORK_CONTINUITY_VERSION,
		codex_subagent_schema_version: CODEX_SUBAGENT_WORK_GRAPH_SCHEMA,
		active_tool_count:
			sortedEdges.length > 0
				? nonCodexActiveToolCount + activeCodexSubagentEdgeCount
				: state.active_tools.length,
		tracked_tool_count:
			sortedEdges.length > 0
				? nonCodexTrackedToolCount + trackedCodexSubagentCount
				: state.tracked_tools.length,
		pending_request_count:
			state.pending_approvals.length +
			state.pending_client_tools.length +
			state.pending_mcp_elicitations.length +
			state.pending_user_inputs.length +
			state.pending_tool_retries.length,
		codex_subagent_tool_call_ids: [...codexToolCallIds].sort(),
		codex_subagent_child_run_ids: [...childRunIds].sort(),
		codex_subagent_thread_ids: [...threadIds].sort(),
		...(sortedEdges.length > 0 ? { codex_subagent_edges: sortedEdges } : {}),
	};
}

export async function drainHostedRunner(
	input: HostedRunnerDrainInput,
	options: DrainHostedRunnerOptions,
): Promise<HostedRunnerDrainResult | null> {
	const hostedRunner = options.hostedRunner;
	if (!hostedRunner?.enabled || !hostedRunner.runnerSessionId) {
		return null;
	}

	const requestedAtDate = options.now?.() ?? new Date();
	markHostedRunnerLeaseDraining(hostedRunner, requestedAtDate);
	const requestedAt = requestedAtDate.toISOString();
	const workspaceRoot = await resolveWorkspaceRoot(hostedRunner);
	const snapshotRoot = resolve(
		workspaceRoot,
		hostedRunner.snapshotRoot ?? ".maestro/runner-snapshots",
	);
	await mkdir(snapshotRoot, { recursive: true });
	const snapshotPath = join(
		snapshotRoot,
		safeManifestFileName(hostedRunner.runnerSessionId, requestedAt),
	);
	const exportPaths = await resolveWorkspaceExportPaths(
		workspaceRoot,
		input.exportPaths,
	);
	const activeSessionId =
		hostedRunner.activeMaestroSessionId ??
		hostedRunner.configuredMaestroSessionId;
	const maestroSessionId = activeSessionId ?? hostedRunner.runnerSessionId;

	let status: HostedRunnerDrainStatus = HostedRunnerDrainStatusValue.Drained;
	let runtime: HostedRunnerSnapshotManifest["runtime"] = {
		flush_status: HostedRunnerRuntimeFlushStatusValue.Skipped,
		session_id: maestroSessionId,
	};
	let runtimeSnapshot: HeadlessRuntimeSnapshot | undefined;
	let recordPlatformDrain:
		| ((input: HostedRunnerPlatformDrainRecordInput) => Promise<void>)
		| undefined;

	if (activeSessionId && options.drainRuntime) {
		try {
			const runtimeResult = await options.drainRuntime(activeSessionId, {
				reason: input.reason,
				requestedBy: input.requestedBy,
				manifestPath: snapshotPath,
			});
			const runtimeProtocolVersion =
				runtimeResult?.protocolVersion ??
				runtimeResult?.snapshot?.protocolVersion;
			const runtimeCursor =
				runtimeResult?.cursor ?? runtimeResult?.snapshot?.cursor;
			runtime = runtimeResult
				? {
						flush_status: HostedRunnerRuntimeFlushStatusValue.Completed,
						session_id: runtimeResult.sessionId,
						...(runtimeResult.sessionFile
							? { session_file: runtimeResult.sessionFile }
							: {}),
						...(runtimeProtocolVersion
							? { protocol_version: runtimeProtocolVersion }
							: {}),
						...(runtimeCursor !== undefined ? { cursor: runtimeCursor } : {}),
					}
				: {
						flush_status: HostedRunnerRuntimeFlushStatusValue.Skipped,
						session_id: activeSessionId,
					};
			runtimeSnapshot = runtimeResult?.snapshot;
			recordPlatformDrain = runtimeResult?.recordPlatformDrain;
		} catch (error) {
			status = HostedRunnerDrainStatusValue.Interrupted;
			const interruptedRuntime =
				error instanceof HostedRunnerRuntimeDrainError ? error : undefined;
			runtimeSnapshot = interruptedRuntime?.snapshot;
			recordPlatformDrain = interruptedRuntime?.recordPlatformDrain;
			runtime = {
				flush_status: HostedRunnerRuntimeFlushStatusValue.Failed,
				session_id: interruptedRuntime?.sessionId ?? activeSessionId,
				...(interruptedRuntime?.sessionFile
					? { session_file: interruptedRuntime.sessionFile }
					: {}),
				...(interruptedRuntime?.protocolVersion
					? { protocol_version: interruptedRuntime.protocolVersion }
					: {}),
				...(interruptedRuntime?.cursor !== undefined
					? { cursor: interruptedRuntime.cursor }
					: {}),
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	const git = await collectGitState(workspaceRoot);
	const snapshot =
		runtimeSnapshot ??
		buildHostedRunnerSnapshot(maestroSessionId, workspaceRoot, runtime);
	const workContinuity = collectHostedRunnerWorkContinuity(snapshot);
	const retentionPolicy = buildHostedRunnerRetentionPolicy();
	const platformEvidence = buildHostedRunnerPlatformEvidence({
		hostedRunner,
		status,
		maestroSessionId,
		createdAt: requestedAt,
		manifestPath: snapshotPath,
		runtime,
		workContinuity,
		retentionPolicy,
		reason: input.reason,
		requestedBy: input.requestedBy,
	});
	const manifest: HostedRunnerSnapshotManifest = {
		protocol_version: HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION,
		runner_session_id: hostedRunner.runnerSessionId,
		...(hostedRunner.workspaceId
			? { workspace_id: hostedRunner.workspaceId }
			: {}),
		...(hostedRunner.agentRunId
			? { agent_run_id: hostedRunner.agentRunId }
			: {}),
		maestro_session_id: maestroSessionId,
		...(input.reason ? { reason: input.reason } : {}),
		...(input.requestedBy ? { requested_by: input.requestedBy } : {}),
		created_at: requestedAt,
		workspace_root: workspaceRoot,
		runtime,
		workspace_export: {
			mode: HostedRunnerWorkspaceExportModeValue.LocalPathContract,
			paths: exportPaths,
		},
		work_continuity: workContinuity,
		platform_evidence: platformEvidence,
		snapshot,
		retention_policy: retentionPolicy,
		...(git ? { git } : {}),
	};

	try {
		await writeFile(
			snapshotPath,
			`${JSON.stringify(manifest, null, 2)}\n`,
			"utf8",
		);
		hostedRunner.lastDrain = {
			status,
			manifestPath: snapshotPath,
			drainedAt: requestedAt,
			...(input.reason ? { reason: input.reason } : {}),
			...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
		};
	} catch (error) {
		const errorMessage = `Hosted runner drain manifest persistence failed: ${
			error instanceof Error ? error.message : String(error)
		}`;
		await recordPlatformDrain?.({
			status: HostedRunnerDrainStatusValue.Interrupted,
			reason: input.reason,
			requestedBy: input.requestedBy,
			flushStatus: runtime.flush_status,
			manifestPath: snapshotPath,
			platformEvidence: buildHostedRunnerPlatformEvidence({
				hostedRunner,
				status: HostedRunnerDrainStatusValue.Interrupted,
				maestroSessionId,
				createdAt: requestedAt,
				manifestPath: snapshotPath,
				runtime,
				workContinuity,
				retentionPolicy,
				reason: input.reason,
				requestedBy: input.requestedBy,
			}),
			errorMessage,
		});
		throw error;
	}
	await recordPlatformDrain?.({
		status,
		reason: input.reason,
		requestedBy: input.requestedBy,
		flushStatus: runtime.flush_status,
		manifestPath: snapshotPath,
		platformEvidence,
		errorMessage: runtime.error,
	});

	return {
		status,
		runner_session_id: hostedRunner.runnerSessionId,
		...(input.reason ? { reason: input.reason } : {}),
		...(input.requestedBy ? { requested_by: input.requestedBy } : {}),
		manifest_path: snapshotPath,
		manifest,
	};
}

async function drainActiveRuntime(
	context: HostedRunnerDrainRuntimeContext,
	sessionId: string,
	_terminal: HostedRunnerRuntimeTerminalInput,
): Promise<HostedRunnerRuntimeDrainResult | null> {
	const runtime =
		context.headlessRuntimeService.getRuntimeBySessionId(sessionId);
	if (!runtime) {
		return null;
	}
	const snapshot = runtime.getSnapshot();
	const sessionFile = runtime.getSessionFile();
	const recordPlatformDrain = async (
		input: HostedRunnerPlatformDrainRecordInput,
	) => {
		await runtime.recordHostedAgentRuntimeDrain({
			status: input.status,
			reason: input.reason,
			requestedBy: input.requestedBy,
			flushStatus: input.flushStatus,
			manifestPath: input.manifestPath,
			platformEvidence: input.platformEvidence,
			errorMessage: input.errorMessage
				? `Hosted runner drain failed: ${input.errorMessage}`
				: undefined,
		});
	};
	try {
		await runtime.dispose();
	} catch (error) {
		throw new HostedRunnerRuntimeDrainError(
			error instanceof Error ? error.message : String(error),
			{
				sessionId: snapshot.session_id,
				sessionFile,
				protocolVersion: snapshot.protocolVersion,
				cursor: snapshot.cursor,
				snapshot,
				recordPlatformDrain,
			},
		);
	}
	return {
		sessionId: snapshot.session_id,
		sessionFile,
		protocolVersion: snapshot.protocolVersion,
		cursor: snapshot.cursor,
		snapshot,
		recordPlatformDrain,
	};
}

export async function drainHostedRunnerForShutdown(
	context: HostedRunnerDrainRuntimeContext,
	options: DrainHostedRunnerForShutdownOptions = {},
): Promise<HostedRunnerDrainResult | null> {
	return drainHostedRunner(
		{
			reason: options.reason ?? HostedRunnerDrainReasonValue.ProcessShutdown,
			requestedBy:
				options.requestedBy ??
				HostedRunnerDrainRequestedByValue.MaestroWebServer,
		},
		{
			hostedRunner: context.hostedRunner,
			drainRuntime: (sessionId, terminal) =>
				drainActiveRuntime(context, sessionId, terminal),
			now: options.now,
		},
	);
}

export async function handleHostedRunnerDrain(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
): Promise<void> {
	res.setHeader("Cache-Control", "no-store");
	const body = await readJsonBody<Record<string, unknown>>(req, 64_000);
	const input = parseHostedRunnerDrainInput(body);
	const result = await drainHostedRunner(input, {
		hostedRunner: context.hostedRunner,
		drainRuntime: (sessionId, terminal) =>
			drainActiveRuntime(context, sessionId, terminal),
	});

	if (!result) {
		sendJson(
			res,
			404,
			{
				error: "hosted runner drain unavailable",
			},
			context.corsHeaders,
			req,
		);
		return;
	}

	sendJson(
		res,
		result.status === HostedRunnerDrainStatusValue.Interrupted ? 503 : 200,
		{
			protocol_version: HOSTED_RUNNER_DRAIN_PROTOCOL_VERSION,
			status: result.status,
			runner_session_id: result.runner_session_id,
			requested_by: result.requested_by,
			reason: result.reason,
			manifest_path: result.manifest_path,
			manifest: result.manifest,
		},
		context.corsHeaders,
		req,
	);
}
