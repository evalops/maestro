import { execSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { requireApiAuth } from "../authz.js";
import { sendJson } from "../server-utils.js";

export async function handleReview(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method !== "GET") {
		sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
		return;
	}

	// Require authentication to prevent exposure of repository data
	if (!(await requireApiAuth(req, res, corsHeaders))) return;

	try {
		const cwd = process.cwd();

		// Get git status
		const statusResult = execSync("git status -sb", {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Get diff stats
		let diffStat = "";
		try {
			diffStat = execSync("git diff --stat", {
				cwd,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch {
			// No diff stats available
		}

		// Get staged diff
		let stagedDiff = "";
		try {
			stagedDiff = execSync("git diff --cached --unified=5", {
				cwd,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch {
			// No staged changes
		}

		// Get worktree diff
		let worktreeDiff = "";
		try {
			worktreeDiff = execSync("git diff --unified=5", {
				cwd,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch {
			// No unstaged changes
		}

		const hasDiff =
			diffStat.trim().length > 0 ||
			stagedDiff.trim().length > 0 ||
			worktreeDiff.trim().length > 0;

		sendJson(
			res,
			200,
			{
				ok: true,
				cwd,
				status: statusResult.trim(),
				diffStat: diffStat.trim(),
				stagedDiff: stagedDiff.trim(),
				worktreeDiff: worktreeDiff.trim(),
				hasDiff,
			},
			corsHeaders,
		);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		sendJson(
			res,
			500,
			{
				ok: false,
				error: errorMessage,
			},
			corsHeaders,
		);
	}
}
