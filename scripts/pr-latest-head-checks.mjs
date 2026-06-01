#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
	summarizeChecks,
	summarizeCheckText,
} from "./maestro-merge-queue-status.mjs";
import { parseRepoSpec, prNumberFromInput } from "./pr-ready-to-merge.mjs";

export const LATEST_HEAD_CHECKS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
	repository(owner:$owner,name:$repo){
		pullRequest(number:$number){
			baseRefName
			headRefName
			headRefOid
			number
			title
			url
			commits(last:1){
				nodes{
					commit{
						oid
						statusCheckRollup{
							contexts(first:100,after:$after){
								nodes{
									__typename
									... on CheckRun {
										checkSuite {
											workflowRun {
												workflow {
													name
												}
											}
										}
										completedAt
										conclusion
										detailsUrl
										name
										startedAt
										status
									}
									... on StatusContext {
										context
										createdAt
										state
										targetUrl
									}
								}
								pageInfo{
									hasNextPage
									endCursor
								}
							}
						}
					}
				}
			}
		}
	}
}`;

function parseArgs(argv) {
	const args = {
		json: false,
		pr: "",
		repo: "",
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--json":
				args.json = true;
				break;
			case "--repo":
				args.repo = argv[++index] ?? "";
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
		throw new Error(
			"Usage: node scripts/pr-latest-head-checks.mjs [--repo owner/name] [--json] <pr-number-or-url>",
		);
	}
	return args;
}

function ghText(args) {
	return execFileSync("gh", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function ghJson(args) {
	const output = execFileSync("gh", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return JSON.parse(output);
}

function resolveRepo(repo) {
	if (repo) {
		return repo;
	}
	return ghText([
		"repo",
		"view",
		"--json",
		"nameWithOwner",
		"--jq",
		".nameWithOwner",
	]);
}

function normalizeStatusCheckNode(node) {
	if (node?.__typename !== "CheckRun") {
		return node;
	}
	const { checkSuite, ...checkRun } = node;
	const workflowName = checkSuite?.workflowRun?.workflow?.name;
	if (!workflowName) {
		return checkRun;
	}
	return {
		...checkRun,
		workflowName,
	};
}

export function extractLatestHeadCheckPage(data) {
	const pr = data?.data?.repository?.pullRequest;
	if (!pr) {
		throw new Error("GitHub response did not include a pull request.");
	}
	const commit = pr.commits?.nodes?.[0]?.commit;
	if (!commit) {
		throw new Error(
			`PR #${pr.number ?? "unknown"} does not expose a latest head commit.`,
		);
	}
	const contexts = commit.statusCheckRollup?.contexts;
	return {
		checks: (contexts?.nodes ?? []).map(normalizeStatusCheckNode),
		pageInfo: contexts?.pageInfo ?? { endCursor: "", hasNextPage: false },
		pr: {
			baseRefName: pr.baseRefName,
			headRefName: pr.headRefName,
			headRefOid: pr.headRefOid,
			latestCommitOid: commit.oid,
			number: pr.number,
			title: pr.title,
			url: pr.url,
		},
	};
}

export function fetchLatestHeadCheckRollup(repo, prInput, queryGh = ghJson) {
	const repoSpec = parseRepoSpec(repo);
	const number = prNumberFromInput(prInput);
	let cursor = "";
	let pr = null;
	const checks = [];

	do {
		const apiArgs = [
			"api",
			"graphql",
			"-f",
			`query=${LATEST_HEAD_CHECKS_QUERY}`,
			"-f",
			`owner=${repoSpec.owner}`,
			"-f",
			`repo=${repoSpec.name}`,
			"-F",
			`number=${number}`,
		];
		if (cursor) {
			apiArgs.push("-f", `after=${cursor}`);
		}
		const page = extractLatestHeadCheckPage(queryGh(apiArgs));
		pr = page.pr;
		checks.push(...page.checks);
		cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : "";
	} while (cursor);

	return {
		...pr,
		checks,
		repo: repoSpec.nameWithOwner,
	};
}

function shortSha(value) {
	return String(value ?? "").slice(0, 12);
}

export function formatLatestHeadCheckReport(report) {
	const summary = summarizeChecks(report.checks ?? []);
	const lines = [
		`PR #${report.number}: ${report.title}`,
		report.url,
		`Repo: ${report.repo}`,
		`Base: ${report.baseRefName}`,
		`Latest head: ${report.headRefName}@${shortSha(report.latestCommitOid ?? report.headRefOid)}`,
		`Checks: ${summarizeCheckText(summary)}`,
	];
	if (
		report.headRefOid &&
		report.latestCommitOid &&
		report.headRefOid !== report.latestCommitOid
	) {
		lines.push(
			`Warning: pull request headRefOid ${shortSha(report.headRefOid)} differs from latest commit ${shortSha(report.latestCommitOid)}.`,
		);
	}
	if (summary.failing.length > 0) {
		lines.push(
			"",
			"Failing checks:",
			...summary.failing.map((check) => `- ${check}`),
		);
	}
	if (summary.pending.length > 0) {
		lines.push(
			"",
			"Pending checks:",
			...summary.pending.map((check) => `- ${check}`),
		);
	}
	if (summary.failing.length === 0 && summary.pending.length === 0) {
		lines.push("", "All latest-head checks are passing.");
	}
	return `${lines.join("\n")}\n`;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const repo = resolveRepo(args.repo);
	const report = fetchLatestHeadCheckRollup(repo, args.pr);
	const summary = summarizeChecks(report.checks);
	if (args.json) {
		process.stdout.write(`${JSON.stringify({ ...report, summary }, null, 2)}\n`);
		return;
	}
	process.stdout.write(formatLatestHeadCheckReport(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
