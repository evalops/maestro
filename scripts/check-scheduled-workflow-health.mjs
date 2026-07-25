#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const DEFAULT_WORKFLOWS = [
	"public-mirror-drift-audit",
	"sync-public-release-mirror",
];
const LABEL = "ci-watchdog";
const LABEL_COLOR = "d93f0b";
const DEFAULT_RUNS = 3;
const MIN_CONSECUTIVE_FAILURES = 2;
const EXCERPT_LINE_LIMIT = 10;

function parseArgs(argv) {
	const args = {
		dryRun: false,
		repo: process.env.GITHUB_REPOSITORY ?? "",
		runs: DEFAULT_RUNS,
		workflows: [...DEFAULT_WORKFLOWS],
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--dry-run":
				args.dryRun = true;
				break;
			case "--repo":
				args.repo = argv[++index] ?? args.repo;
				break;
			case "--runs":
				args.runs = Number.parseInt(argv[++index] ?? "", 10);
				break;
			case "--workflow": {
				const workflow = argv[++index] ?? "";
				if (!workflow) {
					throw new Error("Missing value for --workflow <name>");
				}
				if (!args.workflows.includes(workflow)) {
					args.workflows.push(workflow);
				}
				break;
			}
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!Number.isInteger(args.runs) || args.runs < MIN_CONSECUTIVE_FAILURES) {
		throw new Error(
			`--runs must be an integer >= ${MIN_CONSECUTIVE_FAILURES}`,
		);
	}

	return args;
}

function warn(message) {
	console.error(`warning: ${message}`);
}

function gh(args) {
	const result = spawnSync("gh", ["api", ...args], { encoding: "utf8" });
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		return {
			ok: false,
			stderr: (result.stderr ?? "").trim(),
			stdout: "",
		};
	}
	return { ok: true, stderr: "", stdout: result.stdout ?? "" };
}

function ghJson(args) {
	const result = gh(args);
	if (!result.ok) {
		warn(`gh api ${args[0]} failed: ${result.stderr || "unknown error"}`);
		return null;
	}
	try {
		return JSON.parse(result.stdout);
	} catch {
		warn(`gh api ${args[0]} returned invalid JSON`);
		return null;
	}
}

function resolveRepo(repo) {
	if (repo) {
		return repo;
	}
	const result = spawnSync(
		"gh",
		["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
		{ encoding: "utf8" },
	);
	if (result.status !== 0 || !result.stdout.trim()) {
		throw new Error(
			"Unable to resolve repository; pass --repo <owner/name> or set GITHUB_REPOSITORY",
		);
	}
	return result.stdout.trim();
}

function resolveWorkflow(repo, workflow) {
	const data = ghJson([`repos/${repo}/actions/workflows?per_page=100`]);
	if (!data) {
		return null;
	}
	const workflows = Array.isArray(data.workflows) ? data.workflows : [];
	const match = workflows.find(
		(entry) =>
			entry.name === workflow ||
			(typeof entry.path === "string" && entry.path.endsWith(`/${workflow}.yml`)),
	);
	if (!match) {
		warn(`workflow not found in ${repo}: ${workflow}`);
		return null;
	}
	return match;
}

function scheduledRuns(repo, workflowId, count) {
	const data = ghJson([
		`repos/${repo}/actions/workflows/${workflowId}/runs?event=schedule&per_page=${count}`,
	]);
	if (!data) {
		return null;
	}
	return (Array.isArray(data.workflow_runs) ? data.workflow_runs : []).filter(
		(run) => run.status === "completed",
	);
}

function countConsecutiveFailures(runs) {
	let count = 0;
	for (const run of runs) {
		if (run.conclusion !== "failure") {
			break;
		}
		count += 1;
	}
	return count;
}

function findWatchdogIssue(repo, workflow) {
	const issues = ghJson([
		`repos/${repo}/issues?state=open&labels=${LABEL}&per_page=100`,
	]);
	if (!Array.isArray(issues)) {
		return null;
	}
	const prefix = `[watchdog] ${workflow} `;
	return (
		issues.find(
			(issue) =>
				!issue.pull_request &&
				typeof issue.title === "string" &&
				issue.title.startsWith(prefix),
		) ?? null
	);
}

function failureExcerpt(repo, run) {
	const jobsUrl = run.jobs_url;
	if (!jobsUrl) {
		return "";
	}
	const jobs = ghJson([jobsUrl.replace("https://api.github.com/", "")]);
	const failedJob = (jobs?.jobs ?? []).find(
		(job) => job.conclusion === "failure",
	);
	if (!failedJob) {
		return "";
	}
	const log = gh([
		`repos/${repo}/actions/jobs/${failedJob.id}/logs`,
	]);
	if (!log.ok || !log.stdout) {
		return "";
	}
	const lines = log.stdout.split("\n").filter((line) => line.trim());
	const errorLines = lines.filter((line) => /error|fail/i.test(line));
	const excerpt = (errorLines.length > 0 ? errorLines : lines).slice(
		-EXCERPT_LINE_LIMIT,
	);
	return excerpt.join("\n").slice(0, 4000);
}

function buildFailureBody(workflow, runs, excerpt) {
	const runLinks = runs
		.map((run) => `- ${run.html_url} (${run.created_at ?? "unknown time"})`)
		.join("\n");
	const excerptBlock = excerpt
		? `\n\nFailure excerpt (latest failing run):\n\n\`\`\`\n${excerpt}\n\`\`\``
		: "";
	return [
		`Scheduled workflow \`${workflow}\` has failed ${runs.length} consecutive scheduled runs.`,
		"",
		"Failing runs:",
		runLinks,
		excerptBlock,
		"",
		"Filed by `.github/workflows/scheduled-failure-watchdog.yml`.",
	].join("\n");
}

function ensureLabel(repo, dryRun) {
	const existing = gh([`repos/${repo}/labels/${LABEL}`]);
	if (existing.ok) {
		return;
	}
	if (dryRun) {
		console.log(`[dry-run] would create label ${LABEL}`);
		return;
	}
	const result = gh([
		`repos/${repo}/labels`,
		"-X",
		"POST",
		"-f",
		`name=${LABEL}`,
		"-f",
		`color=${LABEL_COLOR}`,
		"-f",
		"description=Automated scheduled-workflow failure watchdog",
	]);
	if (!result.ok) {
		warn(`failed to create label ${LABEL}: ${result.stderr}`);
	}
}

function createIssue(repo, title, body, dryRun) {
	if (dryRun) {
		console.log(`[dry-run] would create issue: ${title}`);
		return;
	}
	const result = gh([
		`repos/${repo}/issues`,
		"-X",
		"POST",
		"-f",
		`title=${title}`,
		"-f",
		`body=${body}`,
		"-f",
		`labels[]=${LABEL}`,
	]);
	if (!result.ok) {
		warn(`failed to create issue "${title}": ${result.stderr}`);
		return;
	}
	console.log(`created issue: ${title}`);
}

function commentIssue(repo, issueNumber, body, dryRun) {
	if (dryRun) {
		console.log(`[dry-run] would comment on issue #${issueNumber}`);
		return;
	}
	const result = gh([
		`repos/${repo}/issues/${issueNumber}/comments`,
		"-X",
		"POST",
		"-f",
		`body=${body}`,
	]);
	if (!result.ok) {
		warn(`failed to comment on issue #${issueNumber}: ${result.stderr}`);
	}
}

function closeIssue(repo, issueNumber, dryRun) {
	if (dryRun) {
		console.log(`[dry-run] would close issue #${issueNumber}`);
		return;
	}
	const result = gh([
		`repos/${repo}/issues/${issueNumber}`,
		"-X",
		"PATCH",
		"-f",
		"state=closed",
	]);
	if (!result.ok) {
		warn(`failed to close issue #${issueNumber}: ${result.stderr}`);
	}
}

function checkWorkflow(repo, workflow, options) {
	const entry = resolveWorkflow(repo, workflow);
	if (!entry) {
		warn(`skipping ${workflow}: unable to resolve workflow`);
		return;
	}
	const runs = scheduledRuns(repo, entry.id, options.runs);
	if (!runs) {
		warn(`skipping ${workflow}: unable to query scheduled runs`);
		return;
	}
	if (runs.length === 0) {
		console.log(`${workflow}: no scheduled runs found; skipping`);
		return;
	}

	const consecutiveFailures = countConsecutiveFailures(runs);
	const issue = findWatchdogIssue(repo, workflow);

	if (consecutiveFailures >= MIN_CONSECUTIVE_FAILURES) {
		const failingRuns = runs.slice(0, consecutiveFailures);
		const title = `[watchdog] ${workflow} failing ${consecutiveFailures} consecutive scheduled runs`;
		const body = buildFailureBody(
			workflow,
			failingRuns,
			failureExcerpt(repo, failingRuns[0]),
		);
		if (issue) {
			console.log(
				`${workflow}: still failing (${consecutiveFailures} consecutive); commenting on #${issue.number}`,
			);
			commentIssue(repo, issue.number, body, options.dryRun);
		} else {
			console.log(`${workflow}: ${consecutiveFailures} consecutive failures; filing issue`);
			ensureLabel(repo, options.dryRun);
			createIssue(repo, title, body, options.dryRun);
		}
		return;
	}

	if (runs[0].conclusion === "success" && issue) {
		console.log(
			`${workflow}: recovered (latest scheduled run succeeded); closing #${issue.number}`,
		);
		commentIssue(
			repo,
			issue.number,
			`Latest scheduled run succeeded: ${runs[0].html_url}\n\nClosing this watchdog issue.`,
			options.dryRun,
		);
		closeIssue(repo, issue.number, options.dryRun);
		return;
	}

	console.log(
		`${workflow}: ok (latest conclusion: ${runs[0].conclusion ?? "unknown"})`,
	);
}

const options = parseArgs(process.argv.slice(2));
const repo = resolveRepo(options.repo);
console.log(
	`Monitoring ${options.workflows.length} workflow(s) in ${repo}${options.dryRun ? " (dry-run)" : ""}`,
);
for (const workflow of options.workflows) {
	checkWorkflow(repo, workflow, options);
}
