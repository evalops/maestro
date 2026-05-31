#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
	fetchReviewThreads,
	parseRepoSpec,
} from "./pr-ready-to-merge.mjs";
import { resolvePublicMirrorRef } from "./resolve-public-mirror-ref.mjs";

const PASSING_CHECK_RUN_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const PASSING_STATUS_CONTEXT_STATES = new Set(["SUCCESS"]);
const PENDING_STATUS_CONTEXT_STATES = new Set(["EXPECTED", "PENDING"]);

function parseArgs(argv) {
	const args = {
		limit: 20,
		markdownOutput: "",
		prs: [],
		publicRepo: "https://github.com/evalops/maestro.git",
		repo: "EvalOps/maestro-internal",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--limit":
				args.limit = Number.parseInt(argv[++index] ?? "", 10);
				break;
			case "--markdown-output":
				args.markdownOutput = argv[++index] ?? "";
				break;
			case "--prs":
				args.prs = (argv[++index] ?? "")
					.split(",")
					.map((value) => Number.parseInt(value.trim(), 10))
					.filter(Number.isFinite);
				break;
			case "--public-repo":
				args.publicRepo = argv[++index] ?? args.publicRepo;
				break;
			case "--repo":
				args.repo = argv[++index] ?? args.repo;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!Number.isFinite(args.limit) || args.limit < 1) {
		throw new Error("--limit must be a positive integer");
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

function discoverOpenPrs(repo, limit) {
	return ghJson([
		"search",
		"prs",
		"--repo",
		repo,
		"--state",
		"open",
		"--limit",
		String(limit),
		"--json",
		"number",
	]).map((entry) => entry.number);
}

function fetchPullRequest(repo, number) {
	return ghJson([
		"pr",
		"view",
		String(number),
		"--repo",
		repo,
		"--json",
		"autoMergeRequest,baseRefName,headRefName,isDraft,mergeStateStatus,number,state,statusCheckRollup,title,updatedAt,url",
	]);
}

function statusCheckName(check) {
	if (check.__typename === "CheckRun") {
		return check.name ?? "unnamed check";
	}
	if (check.__typename === "StatusContext") {
		return check.context ?? "unnamed status";
	}
	return `unknown status type ${check.__typename ?? "UNKNOWN"}`;
}

function statusCheckKey(check) {
	if (check.__typename === "CheckRun") {
		return [
			check.__typename,
			check.workflowName ?? "unknown workflow",
			statusCheckName(check),
		].join(":");
	}
	return `${check.__typename ?? "UNKNOWN"}:${statusCheckName(check)}`;
}

function statusCheckTimestamp(check) {
	const timestamps = [
		check.startedAt,
		check.createdAt,
		check.completedAt,
		check.updatedAt,
	]
		.map((value) => Date.parse(value ?? ""))
		.filter(Number.isFinite);
	if (timestamps.length === 0) {
		return Number.NEGATIVE_INFINITY;
	}
	return Math.max(...timestamps);
}

function latestStatusChecks(statusCheckRollup) {
	const latestByName = new Map();

	statusCheckRollup.forEach((check, index) => {
		const key = statusCheckKey(check);
		const timestamp = statusCheckTimestamp(check);
		const previous = latestByName.get(key);
		if (
			!previous ||
			timestamp > previous.timestamp ||
			(timestamp === previous.timestamp && index > previous.index)
		) {
			latestByName.set(key, { check, index, timestamp });
		}
	});

	return [...latestByName.values()]
		.sort((left, right) => left.index - right.index)
		.map((entry) => entry.check);
}

export function summarizeChecks(statusCheckRollup = []) {
	const statusChecks = latestStatusChecks(statusCheckRollup);
	const summary = {
		failing: [],
		passing: 0,
		pending: [],
		total: statusChecks.length,
	};

	for (const check of statusChecks) {
		if (check.__typename === "CheckRun") {
			const name = statusCheckName(check);
			if (check.status !== "COMPLETED") {
				summary.pending.push(name);
			} else if (!PASSING_CHECK_RUN_CONCLUSIONS.has(check.conclusion)) {
				summary.failing.push(`${name} (${check.conclusion || "UNKNOWN"})`);
			} else {
				summary.passing += 1;
			}
			continue;
		}

		if (check.__typename === "StatusContext") {
			const name = statusCheckName(check);
			if (PENDING_STATUS_CONTEXT_STATES.has(check.state)) {
				summary.pending.push(name);
			} else if (!PASSING_STATUS_CONTEXT_STATES.has(check.state)) {
				summary.failing.push(`${name} (${check.state || "UNKNOWN"})`);
			} else {
				summary.passing += 1;
			}
			continue;
		}

		summary.failing.push(`unknown status type ${check.__typename ?? "UNKNOWN"}`);
	}

	return summary;
}

export function summarizeCheckText(summary) {
	const parts = [`${summary.passing}/${summary.total} pass`];
	if (summary.pending.length > 0) {
		parts.push(`${summary.pending.length} pending`);
	}
	if (summary.failing.length > 0) {
		parts.push(`${summary.failing.length} failing`);
	}
	return parts.join(", ");
}

export function autoMergeText(pr) {
	if (pr.state === "MERGED") {
		return "merged";
	}
	if (pr.state === "CLOSED") {
		return "closed";
	}
	return pr.autoMergeRequest ? "armed" : "off";
}

export function nextAction({ checkSummary, pr, unresolvedThreads }) {
	if (pr.state === "MERGED") {
		return "merged";
	}
	if (pr.state === "CLOSED") {
		return "closed";
	}
	if (pr.isDraft) {
		return "draft stack: keep behind base until parent lands";
	}
	if (unresolvedThreads.length > 0) {
		return "resolve review threads";
	}
	if (pr.mergeStateStatus === "BEHIND") {
		return "update branch from base";
	}
	if (checkSummary.failing.length > 0) {
		return `fix failing check: ${checkSummary.failing[0]}`;
	}
	if (checkSummary.pending.length > 0) {
		return `wait/investigate pending check: ${checkSummary.pending[0]}`;
	}
	if (pr.baseRefName && pr.baseRefName !== "main") {
		return `stacked on ${pr.baseRefName}: wait for parent or retarget`;
	}
	if (!pr.autoMergeRequest) {
		return "enable auto-merge or merge with verified head";
	}
	return "auto-merge armed";
}

function markdownTable(rows) {
	const lines = [
		"| PR | Base | Merge state | Draft | Threads | Checks | Auto-merge | Public ref | Next action |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const row of rows) {
		lines.push(
			[
				`[#${row.number}](${row.url}) ${row.title}`,
				row.baseRefName,
				row.mergeStateStatus,
				row.isDraft ? "yes" : "no",
				row.unresolvedThreads === 0 ? "clear" : `${row.unresolvedThreads} unresolved`,
				row.checks,
				row.autoMerge,
				row.publicRef,
				row.nextAction,
			]
				.map((cell) => String(cell).replaceAll("|", "\\|"))
				.join(" | ")
				.replace(/^/, "| ")
				.concat(" |"),
		);
	}
	return lines.join("\n");
}

export function markdownChecklist(rows) {
	const actionableRows = rows.filter(
		(row) => !["closed", "merged", "auto-merge armed"].includes(row.nextAction),
	);
	if (actionableRows.length === 0) {
		return "All tracked PRs are merged or waiting on armed auto-merge.";
	}

	return actionableRows
		.map((row) => `- [ ] #${row.number}: ${row.nextAction}`)
		.join("\n");
}

async function buildReport(args) {
	const repoSpec = parseRepoSpec(args.repo);
	const prNumbers = args.prs.length > 0 ? args.prs : discoverOpenPrs(args.repo, args.limit);
	const rows = [];

	for (const number of prNumbers) {
		const pr = fetchPullRequest(args.repo, number);
		const reviewThreads = fetchReviewThreads(repoSpec.owner, repoSpec.name, number);
		const unresolvedThreads = reviewThreads.filter((thread) => !thread.isResolved);
		const checkSummary = summarizeChecks(pr.statusCheckRollup ?? []);
		const publicMirror = resolvePublicMirrorRef({
			internalRef: pr.headRefName,
			publicRepo: args.publicRepo,
		});

		rows.push({
			autoMerge: autoMergeText(pr),
			baseRefName: pr.baseRefName,
			checks: summarizeCheckText(checkSummary),
			isDraft: pr.isDraft,
			mergeStateStatus: pr.mergeStateStatus ?? "UNKNOWN",
			nextAction: nextAction({ checkSummary, pr, unresolvedThreads }),
			number: pr.number,
			publicRef: `${publicMirror.ref} (${publicMirror.source})`,
			title: pr.title,
			unresolvedThreads: unresolvedThreads.length,
			url: pr.url,
		});
	}

	const generatedAt = new Date().toISOString();
	return [
		"# Maestro Merge Queue Status",
		"",
		`Generated: ${generatedAt}`,
		`Repository: ${args.repo}`,
		"",
		markdownTable(rows),
		"",
		"## Action Checklist",
		"",
		markdownChecklist(rows),
		"",
	].join("\n");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const report = await buildReport(args);
	if (args.markdownOutput) {
		writeFileSync(args.markdownOutput, report);
	}
	process.stdout.write(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
