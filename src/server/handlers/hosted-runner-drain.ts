import { execFile } from "node:child_process";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
	HEADLESS_PROTOCOL_VERSION,
	createHeadlessRuntimeState,
} from "../../cli/headless-protocol.js";
import type { HostedRunnerContext, WebServerContext } from "../app-context.js";
import type { HeadlessRuntimeSnapshot } from "../headless-runtime-service.js";
import { ApiError, readJsonBody, sendJson } from "../server-utils.js";

const execFileAsync = promisify(execFile);

export const HOSTED_RUNNER_DRAIN_PATH =
	"/.well-known/evalops/remote-runner/drain";

export const HOSTED_RUNNER_DRAIN_PROTOCOL_VERSION =
	"evalops.remote-runner.drain.v1";

export const HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION =
	"evalops.remote-runner.snapshot-manifest.v1";

type SnapshotManifestStatus = "drained" | "interrupted";

export interface HostedRunnerDrainInput {
	reason?: string;
	requestedBy?: string;
	exportPaths?: string[];
}

export interface HostedRunnerRuntimeDrainResult {
	sessionId: string;
	sessionFile?: string;
	protocolVersion?: string;
	cursor?: number;
	snapshot?: HeadlessRuntimeSnapshot;
}

export interface HostedRunnerWorkspaceExportPath {
	input: string;
	path: string;
	relative_path: string;
	type: "file" | "directory" | "other";
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
		flush_status: "completed" | "failed" | "skipped";
		error?: string;
		session_id: string;
		session_file?: string;
		protocol_version?: string;
		cursor?: number;
	};
	workspace_export: {
		mode: "local_path_contract";
		paths: HostedRunnerWorkspaceExportPath[];
	};
	snapshot: HeadlessRuntimeSnapshot;
	git?: {
		commit?: string;
		branch?: string;
		dirty?: boolean;
	};
}

export interface HostedRunnerDrainResult {
	status: SnapshotManifestStatus;
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
	) => Promise<HostedRunnerRuntimeDrainResult | null>;
	now?: () => Date;
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
				? "directory"
				: pathStat.isFile()
					? "file"
					: "other",
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
	state.is_ready = runtime.flush_status === "completed";
	state.last_status =
		runtime.flush_status === "completed"
			? "Drained"
			: runtime.flush_status === "failed"
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

export async function drainHostedRunner(
	input: HostedRunnerDrainInput,
	options: DrainHostedRunnerOptions,
): Promise<HostedRunnerDrainResult | null> {
	const hostedRunner = options.hostedRunner;
	if (!hostedRunner?.enabled || !hostedRunner.runnerSessionId) {
		return null;
	}

	hostedRunner.draining = true;
	const requestedAt = (options.now?.() ?? new Date()).toISOString();
	const workspaceRoot = await resolveWorkspaceRoot(hostedRunner);
	const snapshotRoot = resolve(
		workspaceRoot,
		hostedRunner.snapshotRoot ?? ".maestro/runner-snapshots",
	);
	const exportPaths = await resolveWorkspaceExportPaths(
		workspaceRoot,
		input.exportPaths,
	);
	const activeSessionId =
		hostedRunner.activeMaestroSessionId ??
		hostedRunner.configuredMaestroSessionId;
	const maestroSessionId = activeSessionId ?? hostedRunner.runnerSessionId;

	let status: SnapshotManifestStatus = "drained";
	let runtime: HostedRunnerSnapshotManifest["runtime"] = {
		flush_status: "skipped",
		session_id: maestroSessionId,
	};
	let runtimeSnapshot: HeadlessRuntimeSnapshot | undefined;

	if (activeSessionId && options.drainRuntime) {
		try {
			const runtimeResult = await options.drainRuntime(activeSessionId);
			const runtimeProtocolVersion =
				runtimeResult?.protocolVersion ??
				runtimeResult?.snapshot?.protocolVersion;
			const runtimeCursor =
				runtimeResult?.cursor ?? runtimeResult?.snapshot?.cursor;
			runtime = runtimeResult
				? {
						flush_status: "completed",
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
						flush_status: "skipped",
						session_id: activeSessionId,
					};
			runtimeSnapshot = runtimeResult?.snapshot;
		} catch (error) {
			status = "interrupted";
			runtime = {
				flush_status: "failed",
				session_id: activeSessionId,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	await mkdir(snapshotRoot, { recursive: true });
	const snapshotPath = join(
		snapshotRoot,
		safeManifestFileName(hostedRunner.runnerSessionId, requestedAt),
	);
	const git = await collectGitState(workspaceRoot);
	const snapshot =
		runtimeSnapshot ??
		buildHostedRunnerSnapshot(maestroSessionId, workspaceRoot, runtime);
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
			mode: "local_path_contract",
			paths: exportPaths,
		},
		snapshot,
		...(git ? { git } : {}),
	};

	await writeFile(
		snapshotPath,
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8",
	);

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
	context: WebServerContext,
	sessionId: string,
): Promise<HostedRunnerRuntimeDrainResult | null> {
	const runtime =
		context.headlessRuntimeService.getRuntimeBySessionId(sessionId);
	if (!runtime) {
		return null;
	}
	const snapshot = runtime.getSnapshot();
	const sessionFile = runtime.getSessionFile();
	await runtime.dispose();
	return {
		sessionId: snapshot.session_id,
		sessionFile,
		protocolVersion: snapshot.protocolVersion,
		cursor: snapshot.cursor,
		snapshot,
	};
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
		drainRuntime: (sessionId) => drainActiveRuntime(context, sessionId),
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
		result.status === "interrupted" ? 503 : 200,
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
