import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { isDatabaseConfigured, isDbAvailable } from "../../db/client.js";
import {
	getAsyncHookCount,
	getHookConcurrencySnapshot,
} from "../../hooks/index.js";
import { backgroundTaskManager } from "../../tools/background-tasks.js";
import { respondWithApiError, sendJson } from "../server-utils.js";

export function getStatusSnapshot(
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

	return {
		cwd,
		git: gitBranch ? { branch: gitBranch, status: gitStatus } : null,
		context: {
			agentMd: existsSync(join(cwd, "AGENT.md")),
			claudeMd: existsSync(join(cwd, "CLAUDE.md")),
		},
		server: {
			uptime: process.uptime(),
			version: process.version,
			staticCacheMaxAgeSeconds: options.staticCacheMaxAge,
		},
		database: {
			configured: isDatabaseConfigured(),
			connected: isDbAvailable(),
		},
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

export function handleStatus(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	options: { staticCacheMaxAge?: number } = {},
) {
	try {
		const status = getStatusSnapshot(options);
		sendJson(res, 200, status, cors, req);
	} catch (error) {
		respondWithApiError(res, error, 500, cors, req);
	}
}
