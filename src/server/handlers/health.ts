import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isDatabaseConfigured, testConnection } from "../../db/client.js";
import {
	CRITICAL_DATABASE_TABLES,
	checkCriticalTables,
} from "../../db/health.js";
import type { HostedRunnerContext } from "../app-context.js";
import { sendJson } from "../server-utils.js";

export interface HealthCheckResult {
	status: "healthy" | "degraded" | "unhealthy";
	checks: {
		database: {
			status: "up" | "down" | "unconfigured";
			latencyMs?: number;
			criticalTables?: {
				status: "ok" | "missing" | "error";
				checked: string[];
				missing: string[];
				error?: string;
			};
		};
		hostedRunner?: {
			status: "ready" | "draining" | "unavailable";
			runnerSessionId: string;
			ownerInstanceId?: string;
			workspaceRoot: string;
			snapshotRoot?: string;
			workspaceId?: string;
			agentRunId?: string;
			maestroSessionId?: string;
			error?: string;
		};
	};
	timestamp: number;
}

export type HostedRunnerHealthCheck = NonNullable<
	HealthCheckResult["checks"]["hostedRunner"]
>;

export async function handleReadyz(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	hostedRunner?: HostedRunnerContext,
): Promise<void> {
	const result = await runHealthChecks({ hostedRunner });

	const httpStatus = result.status === "unhealthy" ? 503 : 200;
	sendJson(res, httpStatus, result, cors, req);
}

export async function checkHostedRunnerReadiness(
	hostedRunner: HostedRunnerContext,
): Promise<HostedRunnerHealthCheck> {
	const base = {
		runnerSessionId: hostedRunner.runnerSessionId,
		ownerInstanceId: hostedRunner.ownerInstanceId,
		workspaceRoot: hostedRunner.workspaceRoot,
		...(hostedRunner.snapshotRoot
			? { snapshotRoot: hostedRunner.snapshotRoot }
			: {}),
		workspaceId: hostedRunner.workspaceId,
		agentRunId: hostedRunner.agentRunId,
		maestroSessionId:
			hostedRunner.activeMaestroSessionId ??
			hostedRunner.configuredMaestroSessionId,
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

export async function runHealthChecks(
	options: {
		hostedRunner?: HostedRunnerContext;
	} = {},
): Promise<HealthCheckResult> {
	const checks: HealthCheckResult["checks"] = {
		database: { status: "unconfigured" },
	};

	let overallStatus: HealthCheckResult["status"] = "healthy";

	// Database check
	if (!isDatabaseConfigured()) {
		checks.database.status = "unconfigured";
		// unconfigured is acceptable - some deployments don't use enterprise features
	} else {
		const start = performance.now();
		const connected = await testConnection();
		checks.database.latencyMs = Math.round(performance.now() - start);

		if (connected) {
			checks.database.status = "up";
			try {
				const tableChecks = await checkCriticalTables();
				const missing = tableChecks
					.filter((table) => !table.exists)
					.map((table) => table.name);
				checks.database.criticalTables = {
					status: missing.length > 0 ? "missing" : "ok",
					checked: tableChecks.map((table) => table.name),
					missing,
				};
				if (missing.length > 0) {
					overallStatus = "unhealthy";
				}
			} catch (error) {
				checks.database.criticalTables = {
					status: "error",
					checked: [...CRITICAL_DATABASE_TABLES],
					missing: [...CRITICAL_DATABASE_TABLES],
					error: error instanceof Error ? error.message : String(error),
				};
				overallStatus = "unhealthy";
			}
		} else {
			checks.database.status = "down";
			overallStatus = "degraded";
		}
	}

	if (options.hostedRunner) {
		const hostedRunnerCheck = await checkHostedRunnerReadiness(
			options.hostedRunner,
		);
		checks.hostedRunner = hostedRunnerCheck;
		if (hostedRunnerCheck.status !== "ready") {
			overallStatus = "unhealthy";
		}
	}

	return {
		status: overallStatus,
		checks,
		timestamp: Date.now(),
	};
}
