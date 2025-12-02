import type { IncomingMessage, ServerResponse } from "node:http";
import {
	isDatabaseConfigured,
	isDbAvailable,
	testConnection,
} from "../../db/client.js";
import { sendJson } from "../server-utils.js";

export interface HealthCheckResult {
	status: "healthy" | "degraded" | "unhealthy";
	checks: {
		database: {
			status: "up" | "down" | "unconfigured";
			latencyMs?: number;
		};
	};
	timestamp: number;
}

export async function handleReadyz(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
): Promise<void> {
	const result = await runHealthChecks();

	const httpStatus = result.status === "unhealthy" ? 503 : 200;
	sendJson(res, httpStatus, result, cors, req);
}

export async function runHealthChecks(): Promise<HealthCheckResult> {
	const checks: HealthCheckResult["checks"] = {
		database: { status: "unconfigured" },
	};

	let overallStatus: HealthCheckResult["status"] = "healthy";

	// Database check
	if (!isDatabaseConfigured()) {
		checks.database.status = "unconfigured";
		// unconfigured is acceptable - some deployments don't use enterprise features
	} else if (!isDbAvailable()) {
		checks.database.status = "down";
		overallStatus = "degraded";
	} else {
		const start = performance.now();
		const connected = await testConnection();
		checks.database.latencyMs = Math.round(performance.now() - start);

		if (connected) {
			checks.database.status = "up";
		} else {
			checks.database.status = "down";
			overallStatus = "degraded";
		}
	}

	return {
		status: overallStatus,
		checks,
		timestamp: Date.now(),
	};
}
