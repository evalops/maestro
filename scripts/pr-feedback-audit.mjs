#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";

export function parseFeedbackAuditArgs(argv) {
	const args = {
		alsoPublic: [],
		check: false,
		includeResolved: false,
		limit: 20,
		prs: [],
		recentDays: 0,
		repo: "",
	};
	let sawLimit = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--also-public":
				args.alsoPublic.push(argv[++index] ?? "");
				break;
			case "--check":
				args.check = true;
				break;
			case "--include-resolved":
				args.includeResolved = true;
				break;
			case "--limit":
				args.limit = Number(argv[++index] ?? "");
				sawLimit = true;
				break;
			case "--recent-days":
				args.recentDays = Number(argv[++index] ?? "");
				break;
			case "--repo":
				args.repo = argv[++index] ?? "";
				break;
			default:
				if (arg.startsWith("-")) {
					throw new Error(`Unknown argument: ${arg}`);
				}
				args.prs.push(arg);
		}
	}

	if (!Number.isInteger(args.limit) || args.limit <= 0) {
		throw new Error("--limit must be a positive integer");
	}
	if (
		args.recentDays !== 0 &&
		(!Number.isInteger(args.recentDays) || args.recentDays <= 0)
	) {
		throw new Error("--recent-days must be a positive integer");
	}
	if (args.recentDays > 0 && !sawLimit) {
		args.limit = Number.MAX_SAFE_INTEGER;
	}
	if (args.prs.length === 0 && args.recentDays === 0) {
		throw new Error(
			"Usage: node scripts/pr-feedback-audit.mjs [--repo owner/name] [--check] [--include-resolved] [--recent-days days] [--limit count] [--also-public public-pr] <pr-number-or-url> [...]",
		);
	}

	return args;
}

function targetKey(target) {
	return `${target.owner}/${target.repo}#${target.number}`;
}

export function dedupeFeedbackAuditTargets(targets) {
	const byKey = new Map();
	for (const target of targets) {
		byKey.set(targetKey(target), target);
	}
	return [...byKey.values()];
}

function parsePullRequestInput(value) {
	const input = String(value);
	const urlMatch = input.match(
		/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:$|[/?#])/,
	);
	if (urlMatch) {
		return {
			number: Number(urlMatch[3]),
			owner: urlMatch[1],
			repo: urlMatch[2],
		};
	}
	const numberMatch = input.match(/(?:pull\/)?(\d+)(?:$|[/?#])/);
	if (!numberMatch) {
		throw new Error(`Could not parse pull request number from ${value}`);
	}
	return { number: Number(numberMatch[1]) };
}

export function collectFeedbackAuditTargets(args, defaultRepo) {
	const [defaultOwner, defaultName] = String(defaultRepo ?? "").split("/");
	if (defaultRepo && (!defaultOwner || !defaultName)) {
		throw new Error(`Expected repo as owner/name, got ${defaultRepo}`);
	}
	const primaryTargets = args.prs.map((value) => {
		const input = parsePullRequestInput(value);
		const owner = input.owner ?? defaultOwner;
		const repo = input.repo ?? defaultName;
		if (!owner || !repo) {
			throw new Error(
				`Could not resolve repository for PR #${input.number}; pass --repo owner/name or a GitHub pull request URL`,
			);
		}
		return {
			number: input.number,
			owner,
			repo,
		};
	});
	const publicTargets = args.alsoPublic.map((value) => {
		const input = parsePullRequestInput(value);
		return {
			number: input.number,
			owner: input.owner ?? "evalops",
			repo: input.repo ?? "maestro",
		};
	});
	return [...primaryTargets, ...publicTargets];
}

function ghJson(args) {
	const output = execFileSync("gh", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return JSON.parse(output);
}

function ghText(args) {
	return execFileSync("gh", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function resolveRepo(repo) {
	return (
		repo ||
		ghText(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
	);
}

function fetchReviewThreads(owner, repo, number) {
	const threads = [];
	let cursor = "";
	do {
		const args = [
			"api",
			"graphql",
			"-f",
			`query=query($owner:String!,$repo:String!,$number:Int!,$after:String){
				repository(owner:$owner,name:$repo){
					pullRequest(number:$number){
						url
						title
						reviewThreads(first:100,after:$after){
							nodes{
								id
								isResolved
								isOutdated
								path
								line
								startLine
								comments(first:20){
									nodes{
										author{login}
										body
										createdAt
										url
									}
								}
							}
							pageInfo{hasNextPage endCursor}
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
			args.push("-f", `after=${cursor}`);
		}
		const data = ghJson(args);
		const pr = data.data.repository.pullRequest;
		if (!pr) {
			throw new Error(`Pull request #${number} was not found in ${owner}/${repo}`);
		}
		threads.push(...pr.reviewThreads.nodes);
		cursor = pr.reviewThreads.pageInfo.hasNextPage
			? pr.reviewThreads.pageInfo.endCursor
			: "";
	} while (cursor);
	return threads;
}

export function fetchRecentPullTargets(owner, repo, days, limit, requestJson = ghJson) {
	if (days === 0 || limit <= 0) {
		return [];
	}
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
	const perPage = Math.min(limit, 100);
	const targets = [];
	let page = 1;

	while (true) {
		const remaining = limit - targets.length;
		if (remaining <= 0) {
			return targets;
		}
		const pulls = requestJson([
			"api",
			"-H",
			"Accept: application/vnd.github+json",
			`repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${perPage}&page=${page}`,
		]);
		if (!Array.isArray(pulls)) {
			throw new Error("Malformed GitHub pull request API response");
		}
		let reachedCutoff = false;
		const candidates = pulls
			.filter((pull) => {
				const updatedAt = Date.parse(String(pull?.updated_at ?? ""));
				const state = String(pull?.state ?? "");
				if (Number.isFinite(updatedAt) && updatedAt < cutoff) {
					reachedCutoff = true;
					return false;
				}
				return (
					Number.isFinite(updatedAt) &&
					updatedAt >= cutoff &&
					(state === "open" || state === "closed")
				);
			})
			.map((pull) => ({
				number: Number(pull.number),
				owner,
				repo,
			}))
			.filter((target) => Number.isInteger(target.number) && target.number > 0);
		targets.push(...candidates.slice(0, remaining));
		if (reachedCutoff || candidates.length === 0 || pulls.length < perPage) {
			return targets;
		}
		page += 1;
	}
}

function summarizeBody(body) {
	return String(body ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 240);
}

function printThread(thread) {
	const location = [thread.path, thread.line ?? thread.startLine]
		.filter(Boolean)
		.join(":");
	const firstComment = thread.comments?.nodes?.[0];
	const status = thread.isResolved
		? "resolved"
		: thread.isOutdated
			? "unresolved, outdated"
			: "unresolved";
	console.log(`- ${thread.id} ${status}${location ? ` at ${location}` : ""}`);
	if (firstComment?.url) {
		console.log(`  ${firstComment.url}`);
	}
	if (firstComment?.body) {
		console.log(`  ${firstComment.author?.login ?? "reviewer"}: ${summarizeBody(firstComment.body)}`);
	}
}

function main() {
	const args = parseFeedbackAuditArgs(process.argv.slice(2));
	const defaultRepo = args.repo ? resolveRepo(args.repo) : "";
	const needsDefaultRepo = args.prs.some((value) => {
		const input = parsePullRequestInput(value);
		return !input.owner || !input.repo;
	});
	const needsRecentRepo = args.recentDays > 0;
	const currentRepo =
		defaultRepo || (needsDefaultRepo || needsRecentRepo ? resolveRepo("") : "");
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
	const uniqueTargets = dedupeFeedbackAuditTargets(targets);

	let unresolvedCount = 0;
	for (const input of uniqueTargets) {
		const threads = fetchReviewThreads(input.owner, input.repo, input.number);
		const visibleThreads = args.includeResolved
			? threads
			: threads.filter((thread) => !thread.isResolved);
		const unresolved = threads.filter((thread) => !thread.isResolved);
		unresolvedCount += unresolved.length;

		console.log(
			`${input.owner}/${input.repo}#${input.number}: ${unresolved.length} unresolved review thread(s), ${threads.length} total`,
		);
		if (visibleThreads.length === 0) {
			console.log("  no matching review threads");
			continue;
		}
		for (const thread of visibleThreads) {
			printThread(thread);
		}
	}

	if (args.check && unresolvedCount > 0) {
		process.exit(1);
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
