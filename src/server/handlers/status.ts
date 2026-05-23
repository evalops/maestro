import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { isDatabaseConfigured, testConnection } from "../../db/client.js";
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

const DATABASE_STATUS_CACHE_TTL_MS = 5_000;
const DATABASE_STATUS_PROBE_TIMEOUT_MS = 500;
const DATABASE_STATUS_PROBE_RETRY_AFTER_MS = 30_000;

let databaseHealthCache: { connected: boolean; checkedAt: number } | null =
	null;
let databaseHealthProbe: Promise<boolean> | null = null;
let databaseHealthProbeStartedAt = 0;
let databaseHealthProbeGeneration = 0;

function startDatabaseHealthProbe(): Promise<boolean> {
	const now = Date.now();
	if (
		databaseHealthProbe &&
		now - databaseHealthProbeStartedAt < DATABASE_STATUS_PROBE_RETRY_AFTER_MS
	) {
		return databaseHealthProbe;
	}

	const generation = databaseHealthProbeGeneration + 1;
	databaseHealthProbeGeneration = generation;
	databaseHealthProbeStartedAt = now;
	const probe = testConnection()
		.then((connected) => {
			if (databaseHealthProbeGeneration === generation) {
				databaseHealthCache = { connected, checkedAt: Date.now() };
			}
			return connected;
		})
		.catch(() => {
			if (databaseHealthProbeGeneration === generation) {
				databaseHealthCache = { connected: false, checkedAt: Date.now() };
			}
			return false;
		})
		.finally(() => {
			if (databaseHealthProbe === probe) {
				databaseHealthProbe = null;
				databaseHealthProbeStartedAt = 0;
			}
		});

	databaseHealthProbe = probe;
	return probe;
}

async function waitForDatabaseProbe(
	probe: Promise<boolean>,
	fallback: boolean,
): Promise<boolean> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			probe,
			new Promise<boolean>((resolve) => {
				timeout = setTimeout(() => {
					resolve(fallback);
				}, DATABASE_STATUS_PROBE_TIMEOUT_MS);
				if (typeof timeout === "object" && "unref" in timeout) {
					timeout.unref();
				}
			}),
		]);
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

async function getDatabaseHealthSnapshot(): Promise<{
	configured: boolean;
	connected: boolean;
}> {
	const configured = isDatabaseConfigured();
	if (!configured) {
		return { configured: false, connected: false };
	}

	const now = Date.now();
	if (
		databaseHealthCache &&
		now - databaseHealthCache.checkedAt <= DATABASE_STATUS_CACHE_TTL_MS
	) {
		return { configured: true, connected: databaseHealthCache.connected };
	}

	const connected = await waitForDatabaseProbe(
		startDatabaseHealthProbe(),
		false,
	);
	return { configured: true, connected };
}

export function resetStatusDatabaseHealthCacheForTests(): void {
	databaseHealthCache = null;
	databaseHealthProbe = null;
	databaseHealthProbeStartedAt = 0;
	databaseHealthProbeGeneration = 0;
}

export async function getStatusSnapshot(
	options: { staticCacheMaxAge?: number } = {},
) {
	const startedAt = Date.now();
	const cwd = process.cwd();
	const database = await getDatabaseHealthSnapshot();

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
		backgroundTasks: backgroundTaskManager.getHealthSnapshot({
			maxEntries: 5,
			logLines: 2,
		}),
		hooks: {
			asyncInFlight: getAsyncHookCount(),
			concurrency: getHookConcurrencySnapshot(),
		},
		lastUpdated: Date.now(),
		lastLatencyMs: Date.now() - startedAt,
	};
}

export async function handleStatus(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	options: { staticCacheMaxAge?: number } = {},
): Promise<void> {
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
