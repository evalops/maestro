#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";

const PASSING_CHECK_RUN_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const PASSING_STATUS_CONTEXT_STATES = new Set(["SUCCESS"]);

function parseArgs(argv) {
	const args = {
		headSha: "",
		pr: "",
		repo: "",
		strictStatusChecks: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--head-sha":
				args.headSha = argv[++index] ?? "";
				break;
			case "--repo":
				args.repo = argv[++index] ?? "";
				break;
			case "--strict-status-checks":
				args.strictStatusChecks = true;
				break;
			default:
				if (!args.pr) {
					args.pr = arg;
				} else {
					throw new Error(`Unknown argument: ${arg}`);
				}
		}
	}

	if (!args.pr) {
		throw new Error("Usage: node scripts/pr-ready-to-merge.mjs [--repo owner/name] [--head-sha sha] <pr-number-or-url>");
	}

	return args;
}

export function prNumberFromInput(value) {
	const input = String(value).trim();
	const match = input.match(
		/^(?:(\d+)(?:$|[?#])|https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)(?:$|[/?#]))/,
	);
	if (!match) {
		throw new Error(`Could not parse pull request number from ${value}`);
	}
	return Number(match[1] ?? match[2]);
}

export function parseRepoSpec(repo) {
	const parts = String(repo).trim().split("/").filter(Boolean);
	const [owner, name] = parts.length === 2 ? parts : parts.slice(-2);
	if (!owner || !name || parts.length < 2 || parts.length > 3) {
		throw new Error(`Expected repo as [host/]owner/name, got ${repo}`);
	}
	return {
		host: parts.length === 3 ? parts[0] : "",
		name,
		nameWithOwner: `${owner}/${name}`,
		owner,
	};
}

function ghJson(args) {
	const output = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	return JSON.parse(output);
}

function ghText(args) {
	return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function resolveRepo(repo) {
	if (repo) {
		return repo;
	}
	return ghText(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
}

function statusCheckName(node) {
	if (node.__typename === "CheckRun") {
		return node.name;
	}
	if (node.__typename === "StatusContext") {
		return node.context;
	}
	return node.__typename ?? "UNKNOWN";
}

function statusCheckProblem(node) {
	if (node.__typename === "CheckRun") {
		if (node.status !== "COMPLETED") {
			return `${statusCheckName(node)}: ${node.status.toLowerCase()}`;
		}
		if (!PASSING_CHECK_RUN_CONCLUSIONS.has(node.conclusion)) {
			return `${statusCheckName(node)}: ${String(node.conclusion || "UNKNOWN").toLowerCase()}`;
		}
		return null;
	}
	if (node.__typename === "StatusContext") {
		if (!PASSING_STATUS_CONTEXT_STATES.has(node.state)) {
			return `${statusCheckName(node)}: ${String(node.state || "UNKNOWN").toLowerCase()}`;
		}
		return null;
	}
	return `unknown status type: ${node.__typename ?? "UNKNOWN"}`;
}

function statusCheckProblems(pr, requiredStatusChecks, strictStatusChecks) {
	const checks = pr.statusCheckRollup ?? [];
	if (strictStatusChecks) {
		return {
			failures: checks.map(statusCheckProblem).filter(Boolean),
			warnings: [],
		};
	}

	const required = new Set(requiredStatusChecks ?? []);
	if (requiredStatusChecks === null || required.size === 0) {
		const warnings = checks
			.map(statusCheckProblem)
			.filter(Boolean)
			.map((problem) => `non-required check ${problem}`);
		if (requiredStatusChecks === null) {
			warnings.unshift("Required status-check metadata was unavailable; relying on GitHub merge state.");
		}
		return { failures: [], warnings };
	}

	const failures = [];
	const warnings = [];
	for (const name of required) {
		const matches = checks.filter((check) => statusCheckName(check) === name);
		if (matches.length === 0) {
			failures.push(`Required check ${name} is missing.`);
			continue;
		}
		failures.push(...matches.map(statusCheckProblem).filter(Boolean));
	}

	for (const check of checks) {
		if (required.has(statusCheckName(check))) {
			continue;
		}
		const problem = statusCheckProblem(check);
		if (problem) {
			warnings.push(`optional check ${problem}`);
		}
	}

	return { failures, warnings };
}

export function evaluateReadiness({
	pr,
	reviewThreads,
	expectedHeadSha = "",
	requiredStatusChecks = null,
	strictStatusChecks = false,
}) {
	const failures = [];
	const warnings = [];

	if (pr.state !== "OPEN") {
		failures.push(`PR is ${String(pr.state).toLowerCase()}, not open.`);
	}
	if (pr.isDraft) {
		failures.push("PR is still a draft.");
	}
	if (expectedHeadSha && pr.headRefOid !== expectedHeadSha) {
		failures.push(`PR head is ${pr.headRefOid}, expected ${expectedHeadSha}.`);
	}
	if (pr.mergeable !== "MERGEABLE") {
		failures.push(`PR mergeable state is ${pr.mergeable}.`);
	}
	if (!["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(pr.mergeStateStatus)) {
		failures.push(`PR merge state is ${pr.mergeStateStatus}.`);
	} else if (pr.mergeStateStatus === "UNSTABLE") {
		warnings.push("PR merge state is UNSTABLE because at least one non-required status is not passing.");
	}

	const unresolvedThreads = reviewThreads.filter((thread) => !thread.isResolved);
	for (const thread of unresolvedThreads) {
		const firstComment = thread.comments?.nodes?.[0];
		const location = [thread.path, thread.line].filter(Boolean).join(":");
		failures.push(
			`Unresolved review thread ${thread.id}${location ? ` at ${location}` : ""}${firstComment?.url ? ` (${firstComment.url})` : ""}.`,
		);
	}

	const checkResult = statusCheckProblems(
		pr,
		requiredStatusChecks,
		strictStatusChecks,
	);
	failures.push(...checkResult.failures);
	warnings.push(...checkResult.warnings);

	if ((pr.statusCheckRollup ?? []).length === 0) {
		warnings.push("PR has no status checks in statusCheckRollup.");
	}

	return {
		failures,
		ready: failures.length === 0,
		warnings,
	};
}

export function fetchReviewThreads(owner, repo, number, queryGh = ghJson) {
	const threads = [];
	let cursor = "";

	do {
		const apiArgs = [
			"api",
			"graphql",
			"-f",
			`query=query($owner:String!,$repo:String!,$number:Int!,$after:String){
				repository(owner:$owner,name:$repo){
					pullRequest(number:$number){
						reviewThreads(first:100,after:$after){
							nodes{
								id
								isResolved
								isOutdated
								path
								line
								comments(first:1){nodes{url body author{login}}}
							}
							pageInfo{
								hasNextPage
								endCursor
							}
						}
					}
				}
			}`,
			"-f",
			`owner=${owner}`,
			"-f",
			`repo=${repo}`,
			"-F",
			`number=${number}`,
		];
		if (cursor) {
			apiArgs.push("-f", `after=${cursor}`);
		}

		const data = queryGh(apiArgs);
		const reviewThreads = data.data.repository.pullRequest.reviewThreads;
		threads.push(...reviewThreads.nodes);
		cursor = reviewThreads.pageInfo.hasNextPage ? reviewThreads.pageInfo.endCursor : "";
	} while (cursor);

	return threads;
}

function fetchPullRequest(repo, number) {
	const args = [
		"pr",
		"view",
		String(number),
		"--json",
		"baseRefName,headRefOid,isDraft,mergeable,mergeStateStatus,state,statusCheckRollup,url",
	];
	if (repo) {
		args.push("--repo", repo);
	}
	return ghJson(args);
}

export function fetchRequiredStatusChecks(repo, branch, queryGh = ghJson) {
	if (!branch) {
		return null;
	}
	try {
		const data = queryGh([
			"api",
			`repos/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`,
		]);
		return Array.from(
			new Set([
				...(data.contexts ?? []),
				...(data.checks ?? []).map((check) => check.context).filter(Boolean),
			]),
		);
	} catch {
		return null;
	}
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const number = prNumberFromInput(args.pr);
	const repo = resolveRepo(args.repo);
	const repoSpec = parseRepoSpec(repo);

	const pr = fetchPullRequest(repo, number);
	const reviewThreads = fetchReviewThreads(repoSpec.owner, repoSpec.name, number);
	const requiredStatusChecks = fetchRequiredStatusChecks(repoSpec.nameWithOwner, pr.baseRefName);
	const result = evaluateReadiness({
		pr,
		reviewThreads,
		expectedHeadSha: args.headSha,
		requiredStatusChecks,
		strictStatusChecks: args.strictStatusChecks,
	});

	if (result.ready) {
		console.log(`Ready to merge: ${pr.url}`);
		for (const warning of result.warnings) {
			console.log(`warning: ${warning}`);
		}
		return;
	}

	console.error(`Not ready to merge: ${pr.url}`);
	for (const failure of result.failures) {
		console.error(`- ${failure}`);
	}
	for (const warning of result.warnings) {
		console.error(`warning: ${warning}`);
	}
	process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
