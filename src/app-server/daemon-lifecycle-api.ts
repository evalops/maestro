import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
	MaestroAppServerDaemonStatusResult,
	MaestroAppServerRemoteControlDrainResult,
	MaestroAppServerRemoteControlLease,
	MaestroAppServerRemoteControlLeaseResult,
	MaestroAppServerRemoteControlStatusResult,
} from "@evalops/contracts";
import type { HostedRunnerContext } from "../server/app-context.js";
import {
	type HostedRunnerDrainInput,
	HostedRunnerDrainStatusValue,
	drainHostedRunner,
} from "../server/handlers/hosted-runner-drain.js";
import {
	hostedRunnerLeaseSnapshot,
	refreshHostedRunnerLease,
} from "../server/hosted-runner-lease.js";
import { ApiError } from "../server/server-utils.js";

type UnknownRecord = Record<string, unknown>;
type DrainRunner = typeof drainHostedRunner;

export class MaestroAppServerDaemonLifecycleError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "MaestroAppServerDaemonLifecycleError";
	}
}

export interface MaestroAppServerDaemonLifecycleCapabilities {
	daemonStatus: boolean;
	remoteControlStatus: boolean;
	remoteControlLease: boolean;
	remoteControlDrain: boolean;
}

export interface MaestroAppServerDaemonLifecycle {
	capabilities(): MaestroAppServerDaemonLifecycleCapabilities;
	status(params?: UnknownRecord): Promise<MaestroAppServerDaemonStatusResult>;
	remoteControlStatus(
		params?: UnknownRecord,
	): Promise<MaestroAppServerRemoteControlStatusResult>;
	readLease(
		params?: UnknownRecord,
	): Promise<MaestroAppServerRemoteControlLeaseResult>;
	heartbeatLease(
		params?: UnknownRecord,
	): Promise<MaestroAppServerRemoteControlLeaseResult>;
	drain(
		params?: UnknownRecord,
	): Promise<MaestroAppServerRemoteControlDrainResult>;
}

export interface MaestroAppServerDaemonLifecycleOptions {
	hostedRunner?: HostedRunnerContext;
	drainRunner?: DrainRunner;
	now?: () => Date;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new MaestroAppServerDaemonLifecycleError(-32602, `Invalid ${field}`);
	}
	const trimmed = value.trim();
	return trimmed || undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function paramsRecord(params: unknown): UnknownRecord {
	if (params === undefined) {
		return {};
	}
	if (isRecord(params)) {
		return params;
	}
	throw new MaestroAppServerDaemonLifecycleError(-32602, "Invalid params");
}

function optionalStringArray(
	value: unknown,
	field: string,
): string[] | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new MaestroAppServerDaemonLifecycleError(-32602, `Invalid ${field}`);
	}
	return value.map((entry, index) => {
		if (typeof entry !== "string" || !entry.trim()) {
			throw new MaestroAppServerDaemonLifecycleError(
				-32602,
				`Invalid ${field}[${index}]`,
			);
		}
		if (entry.includes("\0")) {
			throw new MaestroAppServerDaemonLifecycleError(
				-32602,
				`Invalid ${field}[${index}]`,
			);
		}
		return entry.trim();
	});
}

function toLease(
	hostedRunner: HostedRunnerContext,
	now: Date,
): MaestroAppServerRemoteControlLease {
	const lease = hostedRunnerLeaseSnapshot(hostedRunner, now);
	return {
		protocolVersion: lease.protocolVersion,
		runnerSessionId: lease.runnerSessionId,
		ownerInstanceId: lease.ownerInstanceId,
		workspaceId: lease.workspaceId,
		agentId: lease.agentId,
		agentRunId: lease.agentRunId,
		maestroSessionId: lease.maestroSessionId,
		configuredMaestroSessionId: lease.configuredMaestroSessionId,
		state: lease.state,
		generation: lease.generation,
		heartbeatAt: lease.heartbeatAt,
		updatedAt: lease.updatedAt,
		leaseTokenPresent: Boolean(lease.leaseToken),
	};
}

function nowFromOptions(options: MaestroAppServerDaemonLifecycleOptions): Date {
	return options.now?.() ?? new Date();
}

async function remoteControlStatus(
	options: MaestroAppServerDaemonLifecycleOptions,
): Promise<MaestroAppServerRemoteControlStatusResult> {
	const hostedRunner = options.hostedRunner;
	if (!hostedRunner?.enabled) {
		return {
			available: false,
			status: "unavailable",
			lease: null,
		};
	}

	const now = nowFromOptions(options);
	const maestroSessionId =
		hostedRunner.activeMaestroSessionId ??
		hostedRunner.configuredMaestroSessionId;
	const base = {
		available: true,
		runnerSessionId: hostedRunner.runnerSessionId,
		ownerInstanceId: hostedRunner.ownerInstanceId,
		workspaceRoot: hostedRunner.workspaceRoot,
		snapshotRoot: hostedRunner.snapshotRoot,
		workspaceId: hostedRunner.workspaceId,
		agentId: hostedRunner.agentId,
		agentRunId: hostedRunner.agentRunId,
		a2aMessageId: hostedRunner.a2aMessageId,
		a2aTaskId: hostedRunner.a2aTaskId,
		agentRuntimeWorkerQueue: hostedRunner.agentRuntimeWorkerQueue,
		agentRuntimeCorrelationPath: hostedRunner.agentRuntimeCorrelationPath,
		maestroSessionId,
		lastDrain: hostedRunner.lastDrain
			? { ...hostedRunner.lastDrain }
			: undefined,
		lease: toLease(hostedRunner, now),
	};

	if (hostedRunner.draining) {
		return {
			...base,
			status: "draining",
		};
	}

	try {
		const stats = await stat(hostedRunner.workspaceRoot);
		if (!stats.isDirectory()) {
			return {
				...base,
				status: "unavailable",
				error: "workspace root is not a directory",
			};
		}
		return {
			...base,
			status: "ready",
		};
	} catch (error) {
		return {
			...base,
			status: "unavailable",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function requireHostedRunner(
	options: MaestroAppServerDaemonLifecycleOptions,
): HostedRunnerContext {
	if (!options.hostedRunner?.enabled) {
		throw new MaestroAppServerDaemonLifecycleError(
			-32601,
			"Remote control lifecycle is not available",
		);
	}
	return options.hostedRunner;
}

function drainInputFromParams(params: UnknownRecord): HostedRunnerDrainInput {
	return {
		reason:
			optionalString(params.reason, "reason") ??
			optionalString(params.stop_reason, "stop_reason"),
		requestedBy:
			optionalString(params.requestedBy, "requestedBy") ??
			optionalString(params.requested_by, "requested_by"),
		exportPaths:
			optionalStringArray(params.exportPaths, "exportPaths") ??
			optionalStringArray(params.export_paths, "export_paths"),
	};
}

function daemonLifecycleErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function apiStatusToJsonRpcCode(statusCode: number): number {
	switch (statusCode) {
		case 400:
			return -32602;
		case 404:
			return -32004;
		case 503:
			return -32005;
		default:
			return -32000;
	}
}

function toDaemonLifecycleError(
	error: unknown,
): MaestroAppServerDaemonLifecycleError {
	if (error instanceof MaestroAppServerDaemonLifecycleError) {
		return error;
	}
	if (error instanceof ApiError) {
		return new MaestroAppServerDaemonLifecycleError(
			apiStatusToJsonRpcCode(error.statusCode),
			error.message,
		);
	}
	return new MaestroAppServerDaemonLifecycleError(
		-32000,
		daemonLifecycleErrorMessage(error),
	);
}

export function createMaestroAppServerDaemonLifecycle(
	options: MaestroAppServerDaemonLifecycleOptions = {},
): MaestroAppServerDaemonLifecycle {
	const drainRunner = options.drainRunner ?? drainHostedRunner;
	return {
		capabilities() {
			const remoteControlAvailable = Boolean(options.hostedRunner?.enabled);
			return {
				daemonStatus: true,
				remoteControlStatus: remoteControlAvailable,
				remoteControlLease: remoteControlAvailable,
				remoteControlDrain: remoteControlAvailable,
			};
		},

		async status() {
			return {
				daemon: {
					pid: process.pid,
					ppid: process.ppid,
					platform: process.platform,
					arch: process.arch,
					nodeVersion: process.version,
					cwd: resolve(process.cwd()),
					uptimeMs: Math.round(process.uptime() * 1000),
				},
				remoteControl: await remoteControlStatus(options),
			};
		},

		async remoteControlStatus() {
			requireHostedRunner(options);
			return remoteControlStatus(options);
		},

		async readLease() {
			const hostedRunner = requireHostedRunner(options);
			return {
				available: true,
				lease: toLease(hostedRunner, nowFromOptions(options)),
			};
		},

		async heartbeatLease() {
			const hostedRunner = requireHostedRunner(options);
			const lease = refreshHostedRunnerLease(
				hostedRunner,
				nowFromOptions(options),
			);
			return {
				available: true,
				lease: {
					protocolVersion: lease.protocolVersion,
					runnerSessionId: lease.runnerSessionId,
					ownerInstanceId: lease.ownerInstanceId,
					workspaceId: lease.workspaceId,
					agentId: lease.agentId,
					agentRunId: lease.agentRunId,
					maestroSessionId: lease.maestroSessionId,
					configuredMaestroSessionId: lease.configuredMaestroSessionId,
					state: lease.state,
					generation: lease.generation,
					heartbeatAt: lease.heartbeatAt,
					updatedAt: lease.updatedAt,
					leaseTokenPresent: Boolean(lease.leaseToken),
				},
			};
		},

		async drain(params = {}) {
			const hostedRunner = requireHostedRunner(options);
			let result: Awaited<ReturnType<DrainRunner>>;
			try {
				result = await drainRunner(drainInputFromParams(paramsRecord(params)), {
					hostedRunner,
					now: options.now,
				});
			} catch (error) {
				throw toDaemonLifecycleError(error);
			}
			if (!result) {
				throw new MaestroAppServerDaemonLifecycleError(
					-32601,
					"Remote control drain is not available",
				);
			}
			return {
				drained: result.status === HostedRunnerDrainStatusValue.Drained,
				status: result.status,
				runnerSessionId: result.runner_session_id,
				reason: result.reason,
				requestedBy: result.requested_by,
				manifestPath: result.manifest_path,
				manifest: result.manifest,
				remoteControl: await remoteControlStatus(options),
			};
		},
	};
}
