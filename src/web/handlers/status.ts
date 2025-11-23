import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { backgroundTaskManager } from "../../tools/background-tasks.js";
import { respondWithApiError, sendJson } from "../server-utils.js";

export function handleStatus(
	res: ServerResponse,
	cors: Record<string, string>,
) {
	try {
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

		const status = {
			cwd,
			git: gitBranch ? { branch: gitBranch, status: gitStatus } : null,
			context: {
				agentMd: existsSync(join(cwd, "AGENT.md")),
				claudeMd: existsSync(join(cwd, "CLAUDE.md")),
			},
			server: {
				uptime: process.uptime(),
				version: process.version,
			},
			backgroundTasks: backgroundTaskManager.getHealthSnapshot({
				maxEntries: 5,
				logLines: 2,
			}),
			lastUpdated: Date.now(),
			lastLatencyMs: Date.now() - startedAt,
		};

		sendJson(res, 200, status, cors);
	} catch (error) {
		respondWithApiError(res, error, 500, cors);
	}
}
