#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";
import {
	fetchIssueComments,
	fetchReviewThreads,
	parseBugbotAutofixFixedTitles,
	threadBlocksAfterBugbotDisposition,
} from "./pr-ready-to-merge.mjs";

const DEFAULT_REPO = "evalops/maestro";
const DEFAULT_BRANCH = "sync/public-release-mirror";
const EMPTY_SET = new Set();

function parseArgs(argv) {
	const args = {
		branch: DEFAULT_BRANCH,
		repo: DEFAULT_REPO,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--branch":
				args.branch = argv[++index] ?? "";
				break;
			case "--repo":
				args.repo = argv[++index] ?? "";
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!args.branch) {
		throw new Error("--branch must not be empty");
	}
	if (!args.repo || !args.repo.includes("/")) {
		throw new Error(`Expected --repo owner/name, got ${args.repo}`);
	}

	return args;
}

function ghJson(args) {
	const output = execFileSync("gh", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return JSON.parse(output);
}

export function parsePublicMirrorPulls(value) {
	if (!Array.isArray(value)) {
		throw new Error("Expected GitHub pull request API response to be an array");
	}
	return value.map((pull) => {
		const number = Number(pull?.number);
		const htmlUrl = String(pull?.html_url ?? "");
		const title = String(pull?.title ?? "");
		if (!Number.isInteger(number) || number <= 0 || !htmlUrl) {
			throw new Error("Malformed public mirror pull request API response");
		}
		return {
			html_url: htmlUrl,
			number,
			title,
		};
	});
}

function fetchOpenMirrorPulls(repo, branch) {
	const [owner] = repo.split("/");
	return parsePublicMirrorPulls(
		ghJson([
			"api",
			"-H",
			"Accept: application/vnd.github+json",
			`repos/${repo}/pulls?state=open&base=main&head=${owner}:${encodeURIComponent(branch)}`,
		]),
	);
}

/**
 * Generated public mirror PRs are force-updated by automation from internal
 * main. Bot review threads (Codex, Bugbot, etc.) on those PRs must not block
 * the next sync: they reappear after every force-push and created a deadlock
 * (sync fails → public stays stale → bots re-comment on the next attempt).
 *
 * Review debt is therefore advisory: we still report unresolved threads so
 * operators can see them, but we never fail the sync job for them.
 */
export function evaluatePublicMirrorReviewDebt({
	pulls,
	reviewThreadsByPr,
	bugbotFixedTitlesByPr,
	repo = DEFAULT_REPO,
}) {
	const advisories = [];

	for (const pull of pulls) {
		const fixedTitles = bugbotFixedTitlesByPr?.get(pull.number) ?? EMPTY_SET;
		const unresolved = (reviewThreadsByPr.get(pull.number) ?? []).filter((thread) =>
			threadBlocksAfterBugbotDisposition(thread, fixedTitles),
		);
		if (unresolved.length === 0) {
			continue;
		}
		const first = unresolved[0];
		const firstComment = first?.comments?.nodes?.[0];
		advisories.push(
			`${repo}#${pull.number} has ${unresolved.length} unresolved review thread(s) on the generated mirror PR (advisory only; does not block sync): ${pull.html_url}${firstComment?.url ? ` (${firstComment.url})` : ""}.`,
		);
	}

	return {
		// Keep `failures` empty for callers that still check the old field.
		failures: [],
		advisories,
		ok: true,
	};
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const pulls = fetchOpenMirrorPulls(args.repo, args.branch);
	if (pulls.length === 0) {
		console.log(
			`No open generated public mirror PR found for ${args.repo}:${args.branch}.`,
		);
		return;
	}

	const [owner, repoName] = args.repo.split("/");
	const reviewThreadsByPr = new Map(
		pulls.map((pull) => [
			pull.number,
			fetchReviewThreads(owner, repoName, pull.number),
		]),
	);
	const bugbotFixedTitlesByPr = new Map(
		pulls.map((pull) => [
			pull.number,
			parseBugbotAutofixFixedTitles(
				fetchIssueComments(owner, repoName, pull.number),
			),
		]),
	);
	const result = evaluatePublicMirrorReviewDebt({
		pulls,
		repo: args.repo,
		reviewThreadsByPr,
		bugbotFixedTitlesByPr,
	});

	if (result.advisories.length === 0) {
		console.log(
			`No unresolved review threads on ${pulls.length} open generated public mirror PR(s).`,
		);
		return;
	}

	console.log(
		"Public mirror review debt is advisory only (generated PR threads do not block sync):",
	);
	for (const advisory of result.advisories) {
		console.log(`- ${advisory}`);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
