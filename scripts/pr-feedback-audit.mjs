#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";

function parseArgs(argv) {
	const args = {
		check: false,
		includeResolved: false,
		prs: [],
		repo: "",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--check":
				args.check = true;
				break;
			case "--include-resolved":
				args.includeResolved = true;
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

	if (args.prs.length === 0) {
		throw new Error(
			"Usage: node scripts/pr-feedback-audit.mjs [--repo owner/name] [--check] [--include-resolved] <pr-number-or-url> [...]",
		);
	}

	return args;
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
	const args = parseArgs(process.argv.slice(2));
	const defaultRepo = args.repo ? resolveRepo(args.repo) : "";
	let currentRepo = defaultRepo;
	const parsedInputs = args.prs.map(parsePullRequestInput);
	if (!currentRepo && parsedInputs.some((input) => !input.owner || !input.repo)) {
		currentRepo = resolveRepo("");
	}
	const [defaultOwner, defaultName] = currentRepo.split("/");
	if (currentRepo && (!defaultOwner || !defaultName)) {
		throw new Error(`Expected repo as owner/name, got ${currentRepo}`);
	}

	let unresolvedCount = 0;
	for (const input of parsedInputs) {
		const owner = input.owner ?? defaultOwner;
		const name = input.repo ?? defaultName;
		if (!owner || !name) {
			throw new Error(
				`Could not resolve repository for PR #${input.number}; pass --repo owner/name or a GitHub pull request URL`,
			);
		}
		const threads = fetchReviewThreads(owner, name, input.number);
		const visibleThreads = args.includeResolved
			? threads
			: threads.filter((thread) => !thread.isResolved);
		const unresolved = threads.filter((thread) => !thread.isResolved);
		unresolvedCount += unresolved.length;

		console.log(
			`${owner}/${name}#${input.number}: ${unresolved.length} unresolved review thread(s), ${threads.length} total`,
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
