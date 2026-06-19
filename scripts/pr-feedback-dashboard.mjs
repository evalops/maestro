#!/usr/bin/env node

import process from "node:process";
import {
	collectFeedbackAuditTargets,
	dedupeFeedbackAuditTargets,
	fetchRecentPullTargets,
	fetchReviewThreads,
	parseFeedbackAuditArgs,
	resolveRepo,
} from "./pr-feedback-audit.mjs";

const DEFAULT_STALE_HOURS = 24;
const DEFAULT_RECENT_LIMIT = 50;

function firstComment(thread) {
	return thread?.comments?.nodes?.[0] ?? null;
}

function threadAgeHours(thread, nowMs) {
	const createdAt = Date.parse(String(firstComment(thread)?.createdAt ?? ""));
	return Number.isFinite(createdAt)
		? Math.max(0, (nowMs - createdAt) / (60 * 60 * 1000))
		: 0;
}

function increment(map, key) {
	const normalized = key || "(unknown)";
	map.set(normalized, (map.get(normalized) ?? 0) + 1);
}

function topEntries(map, limit = 5) {
	return [...map.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([key, count]) => ({ count, key }));
}

export function summarizeReviewFeedbackDashboard(
	reports,
	{ now = new Date(), staleHours = DEFAULT_STALE_HOURS } = {},
) {
	const nowMs = now.getTime();
	const unresolvedByAuthor = new Map();
	const unresolvedByPath = new Map();
	const staleThreads = [];
	let totalThreads = 0;
	let unresolvedThreads = 0;
	let resolvedThreads = 0;
	let outdatedUnresolvedThreads = 0;
	let oldestUnresolvedAgeHours = 0;

	for (const report of reports) {
		for (const thread of report.threads ?? []) {
			totalThreads += 1;
			if (thread.isResolved) {
				resolvedThreads += 1;
				continue;
			}

			unresolvedThreads += 1;
			if (thread.isOutdated) {
				outdatedUnresolvedThreads += 1;
			}
			const ageHours = threadAgeHours(thread, nowMs);
			oldestUnresolvedAgeHours = Math.max(oldestUnresolvedAgeHours, ageHours);
			increment(unresolvedByAuthor, firstComment(thread)?.author?.login);
			increment(unresolvedByPath, thread.path ?? "(no path)");
			if (ageHours >= staleHours) {
				staleThreads.push({
					ageHours,
					id: thread.id,
					path: thread.path ?? "",
					pullRequest: report.target,
					url: firstComment(thread)?.url ?? "",
				});
			}
		}
	}

	return {
		oldestUnresolvedAgeHours,
		outdatedUnresolvedThreads,
		pullRequests: reports.length,
		resolvedThreads,
		staleHours,
		staleThreads: staleThreads.sort((a, b) => b.ageHours - a.ageHours),
		topAuthors: topEntries(unresolvedByAuthor),
		topPaths: topEntries(unresolvedByPath),
		totalThreads,
		unresolvedThreads,
	};
}

function plural(count, noun) {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function formatReviewFeedbackDashboard(summary) {
	const lines = [
		"# Review Feedback Dashboard",
		"",
		`- Pull requests: ${summary.pullRequests}`,
		`- Threads: ${summary.totalThreads} total, ${summary.unresolvedThreads} unresolved, ${summary.resolvedThreads} resolved`,
		`- Outdated unresolved: ${summary.outdatedUnresolvedThreads}`,
		`- Oldest unresolved age: ${Math.round(summary.oldestUnresolvedAgeHours)}h`,
		`- Stale unresolved (${summary.staleHours}h+): ${summary.staleThreads.length}`,
	];

	if (summary.topAuthors.length > 0) {
		lines.push("", "## Unresolved By Reviewer");
		for (const entry of summary.topAuthors) {
			lines.push(`- ${entry.key}: ${plural(entry.count, "thread")}`);
		}
	}

	if (summary.topPaths.length > 0) {
		lines.push("", "## Unresolved By Path");
		for (const entry of summary.topPaths) {
			lines.push(`- ${entry.key}: ${plural(entry.count, "thread")}`);
		}
	}

	if (summary.staleThreads.length > 0) {
		lines.push("", "## Stale Threads");
		for (const thread of summary.staleThreads.slice(0, 10)) {
			const target = `${thread.pullRequest.owner}/${thread.pullRequest.repo}#${thread.pullRequest.number}`;
			const location = thread.path ? ` ${thread.path}` : "";
			const link = thread.url ? ` ${thread.url}` : "";
			lines.push(`- ${target}${location}: ${Math.round(thread.ageHours)}h${link}`);
		}
	}

	return lines.join("\n");
}

export function evaluateReviewFeedbackDashboardThresholds(
	summary,
	{
		maxOutdated = 0,
		maxStale = 0,
		maxUnresolved = 0,
	} = {},
) {
	const failures = [];
	if (summary.unresolvedThreads > maxUnresolved) {
		failures.push(
			`unresolved review threads ${summary.unresolvedThreads} exceeds ${maxUnresolved}`,
		);
	}
	if (summary.staleThreads.length > maxStale) {
		failures.push(
			`stale review threads ${summary.staleThreads.length} exceeds ${maxStale}`,
		);
	}
	if (summary.outdatedUnresolvedThreads > maxOutdated) {
		failures.push(
			`outdated unresolved review threads ${summary.outdatedUnresolvedThreads} exceeds ${maxOutdated}`,
		);
	}
	return failures;
}

export function parseReviewFeedbackDashboardArgs(argv) {
	const feedbackArgv = [];
	const thresholds = {
		maxOutdated: 0,
		maxStale: 0,
		maxUnresolved: 0,
	};
	let staleHours = DEFAULT_STALE_HOURS;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--max-outdated":
				thresholds.maxOutdated = Number(argv[++index] ?? "");
				break;
			case "--max-stale":
				thresholds.maxStale = Number(argv[++index] ?? "");
				break;
			case "--max-unresolved":
				thresholds.maxUnresolved = Number(argv[++index] ?? "");
				break;
			case "--stale-hours":
				staleHours = Number(argv[++index] ?? "");
				break;
			default:
				feedbackArgv.push(arg);
		}
	}

	for (const [name, value] of [
		["--max-outdated", thresholds.maxOutdated],
		["--max-stale", thresholds.maxStale],
		["--max-unresolved", thresholds.maxUnresolved],
		["--stale-hours", staleHours],
	]) {
		if (!Number.isInteger(value) || value < 0) {
			throw new Error(`${name} must be a non-negative integer`);
		}
	}

	const args = parseFeedbackAuditArgs(feedbackArgv);
	if (args.recentDays > 0 && args.limit === Number.MAX_SAFE_INTEGER) {
		args.limit = DEFAULT_RECENT_LIMIT;
	}
	return { args, staleHours, thresholds };
}

function collectTargets(args, currentRepo) {
	const targets = collectFeedbackAuditTargets(args, currentRepo);
	if (args.recentDays > 0) {
		const [owner, repo] = currentRepo.split("/");
		if (!owner || !repo) {
			throw new Error(`Expected repo as owner/name, got ${currentRepo}`);
		}
		targets.push(
			...fetchRecentPullTargets(owner, repo, args.recentDays, args.limit),
		);
	}
	return dedupeFeedbackAuditTargets(targets);
}

function inputHasRepository(value) {
	return /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:$|[/?#])/.test(
		String(value),
	);
}

function main() {
	const { args, staleHours, thresholds } = parseReviewFeedbackDashboardArgs(
		process.argv.slice(2),
	);
	const defaultRepo = args.repo ? resolveRepo(args.repo) : "";
	const needsDefaultRepo =
		args.recentDays > 0 || args.prs.some((value) => !inputHasRepository(value));
	const currentRepo = defaultRepo || (needsDefaultRepo ? resolveRepo("") : "");
	const targets = collectTargets(args, currentRepo);
	const reports = targets.map((target) => ({
		target,
		threads: fetchReviewThreads(target.owner, target.repo, target.number),
	}));

	const summary = summarizeReviewFeedbackDashboard(reports, { staleHours });
	console.log(formatReviewFeedbackDashboard(summary));
	if (args.check) {
		const failures = evaluateReviewFeedbackDashboardThresholds(
			summary,
			thresholds,
		);
		if (failures.length > 0) {
			for (const failure of failures) {
				console.error(`review-feedback-dashboard: ${failure}`);
			}
			process.exit(1);
		}
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
