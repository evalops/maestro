import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
	isDatabaseConfigured,
	isDbAvailable,
	testConnection,
} from "../../db/client.js";
import {
	getAsyncHookCount,
	getHookConcurrencySnapshot,
} from "../../hooks/index.js";
import {
	getProjectOnboardingState,
	markProjectOnboardingSeen,
} from "../../onboarding/project-onboarding.js";
import { backgroundTaskManager } from "../../tools/background-tasks.js";
import { respondWithApiError, sendJson } from "../server-utils.js";

export type RunHealthLevel = "healthy" | "degraded" | "unhealthy";

export interface RunHealthSlo {
	id: string;
	label: string;
	status: RunHealthLevel;
	target: string;
	observed: string;
	detail?: string;
}

export interface RunHealthSnapshot {
	status: RunHealthLevel;
	slos: RunHealthSlo[];
	diagnostics: string[];
	generatedAt: string;
}

export interface RunHealthInput {
	apiLatencyMs: number;
	backgroundTasks: {
		running?: number;
		failed?: number;
		restarting?: number;
	} | null;
	database: {
		configured: boolean;
		connected: boolean;
		initialized?: boolean;
		reachable?: boolean;
	};
	hooks: {
		asyncInFlight: number;
		concurrency: {
			max: number;
			active: number;
			queued: number;
		};
	};
	generatedAt?: number;
}

function maxHealthLevel(levels: RunHealthLevel[]): RunHealthLevel {
	if (levels.includes("unhealthy")) return "unhealthy";
	if (levels.includes("degraded")) return "degraded";
	return "healthy";
}

function latencySlo(apiLatencyMs: number): RunHealthSlo {
	const status =
		apiLatencyMs > 3000
			? "unhealthy"
			: apiLatencyMs > 1000
				? "degraded"
				: "healthy";
	return {
		id: "api_latency",
		label: "API latency",
		status,
		target: "p50 snapshot <= 1000ms",
		observed: `${Math.max(0, Math.round(apiLatencyMs))}ms`,
		...(status === "healthy"
			? {}
			: { detail: "Status endpoint latency exceeded the local operator SLO." }),
	};
}

function databaseSlo(database: RunHealthInput["database"]): RunHealthSlo {
	if (!database.configured) {
		return {
			id: "database",
			label: "Database",
			status: "healthy",
			target: "connected when configured",
			observed: "unconfigured",
			detail: "Local mode does not require a database connection.",
		};
	}
	if (database.reachable === false) {
		return {
			id: "database",
			label: "Database",
			status: "unhealthy",
			target: "reachable when configured",
			observed: "unreachable",
			detail: "Configured database failed an explicit reachability check.",
		};
	}
	if (database.connected || database.reachable === true) {
		return {
			id: "database",
			label: "Database",
			status: "healthy",
			target: "reachable when configured",
			observed: database.connected ? "connected" : "reachable",
		};
	}
	if (database.initialized === false) {
		return {
			id: "database",
			label: "Database",
			status: "healthy",
			target: "reachable when configured",
			observed: "configured, idle",
			detail:
				"Database is configured, but no query has initialized the lazy client yet.",
		};
	}
	return {
		id: "database",
		label: "Database",
		status: "unhealthy",
		target: "reachable when configured",
		observed: "disconnected",
		detail: "Configured database is not currently reachable.",
	};
}

function backgroundTaskSlo(
	backgroundTasks: RunHealthInput["backgroundTasks"],
): RunHealthSlo {
	const failed = backgroundTasks?.failed ?? 0;
	const restarting = backgroundTasks?.restarting ?? 0;
	const status =
		failed > 0 ? "unhealthy" : restarting > 0 ? "degraded" : "healthy";
	return {
		id: "background_tasks",
		label: "Background tasks",
		status,
		target: "0 failed, 0 restarting",
		observed: `${backgroundTasks?.running ?? 0} running, ${failed} failed, ${restarting} restarting`,
		...(status === "healthy"
			? {}
			: { detail: "Background task supervisor has unhealthy work." }),
	};
}

function hookQueueSlo(hooks: RunHealthInput["hooks"]): RunHealthSlo {
	const queued = hooks.concurrency.queued;
	const active = hooks.concurrency.active;
	const max = hooks.concurrency.max;
	const status =
		queued > max ? "unhealthy" : queued > 0 ? "degraded" : "healthy";
	return {
		id: "hook_queue",
		label: "Hook queue",
		status,
		target: "0 queued hooks",
		observed: `${active}/${max} active, ${queued} queued, ${hooks.asyncInFlight} async`,
		...(status === "healthy"
			? {}
			: {
					detail: "Hook execution is backing up behind the concurrency gate.",
				}),
	};
}

export function buildRunHealthSnapshot(
	input: RunHealthInput,
): RunHealthSnapshot {
	const slos = [
		latencySlo(input.apiLatencyMs),
		databaseSlo(input.database),
		backgroundTaskSlo(input.backgroundTasks),
		hookQueueSlo(input.hooks),
	];
	const diagnostics = slos
		.filter((slo) => slo.status !== "healthy")
		.map((slo) => `${slo.label}: ${slo.observed}`);
	return {
		status: maxHealthLevel(slos.map((slo) => slo.status)),
		slos,
		diagnostics,
		generatedAt: new Date(input.generatedAt ?? Date.now()).toISOString(),
	};
}

export async function getStatusSnapshot(
	options: { staticCacheMaxAge?: number } = {},
) {
	const startedAt = Date.now();
	const cwd = process.cwd();

	let gitBranch = null;
	let gitStatus = null;
	try {
		gitBranch = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
		}).trim();

		const status = execSync("git status --porcelain", {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
		});
		const lines = status.trim().split("\n").filter(Boolean);
		gitStatus = {
			modified: lines.filter((l: string) => l.startsWith(" M")).length,
			added: lines.filter((l: string) => l.startsWith("A ")).length,
			deleted: lines.filter((l: string) => l.startsWith(" D")).length,
			untracked: lines.filter((l: string) => l.startsWith("??")).length,
			total: lines.length,
		};
	} catch {
		// Not a git repository or git not available
	}

	const databaseInitialized = isDbAvailable();
	const databaseReachable = databaseInitialized
		? await testConnection()
		: undefined;
	const database = {
		configured: isDatabaseConfigured(),
		connected: databaseReachable === true,
		initialized: databaseInitialized,
		...(databaseReachable === undefined
			? {}
			: { reachable: databaseReachable }),
	};
	const backgroundTasks = backgroundTaskManager.getHealthSnapshot({
		maxEntries: 5,
		logLines: 2,
	});
	const hooks = {
		asyncInFlight: getAsyncHookCount(),
		concurrency: getHookConcurrencySnapshot(),
	};
	const lastUpdated = Date.now();
	const lastLatencyMs = lastUpdated - startedAt;

	return {
		cwd,
		git: gitBranch ? { branch: gitBranch, status: gitStatus } : null,
		context: {
			agentMd: existsSync(join(cwd, "AGENT.md")),
			claudeMd: existsSync(join(cwd, "CLAUDE.md")),
		},
		onboarding: getProjectOnboardingState(cwd),
		server: {
			uptime: process.uptime(),
			version: process.version,
			staticCacheMaxAgeSeconds: options.staticCacheMaxAge,
		},
		database,
		backgroundTasks,
		hooks,
		runHealth: buildRunHealthSnapshot({
			apiLatencyMs: lastLatencyMs,
			backgroundTasks,
			database,
			hooks,
			generatedAt: lastUpdated,
		}),
		lastUpdated,
		lastLatencyMs,
	};
}

export async function handleStatus(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	options: { staticCacheMaxAge?: number } = {},
) {
	try {
		const method = (req.method ?? "GET").toUpperCase();
		const url = new URL(req.url ?? "/api/status", "http://localhost");
		const action = url.searchParams.get("action");

		if (method === "POST" && action === "mark-onboarding-seen") {
			markProjectOnboardingSeen(process.cwd());
			sendJson(res, 200, { success: true }, cors, req);
			return;
		}

		const status = await getStatusSnapshot(options);
		sendJson(res, 200, status, cors, req);
	} catch (error) {
		respondWithApiError(res, error, 500, cors, req);
	}
}
