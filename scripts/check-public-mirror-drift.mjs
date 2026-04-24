#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
	const args = {
		markdownOutput: "",
		report: "",
		source: process.cwd(),
		statusOutput: "",
		summaryLimit: 25,
		target: "",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--markdown-output":
				args.markdownOutput = argv[++index] ?? args.markdownOutput;
				break;
			case "--report":
				args.report = argv[++index] ?? args.report;
				break;
			case "--source":
				args.source = argv[++index] ?? args.source;
				break;
			case "--status-output":
				args.statusOutput = argv[++index] ?? args.statusOutput;
				break;
			case "--summary-limit":
				args.summaryLimit = Number.parseInt(argv[++index] ?? "", 10);
				break;
			case "--target":
				args.target = argv[++index] ?? args.target;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!args.target) {
		throw new Error("Missing required --target <path>");
	}
	if (!Number.isInteger(args.summaryLimit) || args.summaryLimit < 1) {
		throw new Error("--summary-limit must be a positive integer");
	}

	return args;
}

function readReport(reportPath) {
	if (!existsSync(reportPath)) {
		throw new Error(`Mirror drift report was not written: ${reportPath}`);
	}
	return JSON.parse(readFileSync(reportPath, "utf8"));
}

function samplePaths(report, limit) {
	const copied = Array.isArray(report.copiedPaths) ? report.copiedPaths : [];
	const deleted = Array.isArray(report.deletedPaths) ? report.deletedPaths : [];
	return [
		...copied.map((path) => `copy/update ${path}`),
		...deleted.map((path) => `delete ${path}`),
	].slice(0, limit);
}

function runGit(root, args) {
	const result = spawnSync("git", ["-C", root, ...args], {
		encoding: "utf8",
	});
	if (result.status !== 0) {
		return "";
	}
	return result.stdout.trim();
}

function normalizeRemote(value) {
	if (!value) {
		return "";
	}
	const sshMatch = value.match(/^git@github[.]com:(.+?)(?:[.]git)?$/u);
	if (sshMatch) {
		return `https://github.com/${sshMatch[1]}`;
	}
	return value.replace(/[.]git$/u, "");
}

function gitContext(root) {
	const sha = runGit(root, ["rev-parse", "HEAD"]);
	const branch = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
	return {
		branch: branch && branch !== "HEAD" ? branch : "",
		remote: normalizeRemote(runGit(root, ["config", "--get", "remote.origin.url"])),
		sha,
	};
}

function buildStatus(report, limit, sourceRoot, targetRoot) {
	const copiedCount = Number(report.copiedCount ?? 0);
	const deletedCount = Number(report.deletedCount ?? 0);
	const total = copiedCount + deletedCount;
	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		result: total === 0 ? "in_sync" : "drift_detected",
		invariant:
			total === 0
				? "public_is_verified_projection"
				: "public_projection_has_drift",
		source: {
			kind: "private-source-of-truth",
			...gitContext(sourceRoot),
		},
		target: {
			kind: "public-projection",
			...gitContext(targetRoot),
		},
		mirror: {
			publicPackageName: report.publicPackageName ?? "unknown",
			filesToCopyOrUpdate: copiedCount,
			staleFilesToDelete: deletedCount,
			sourceFileCount: Number(report.sourceFileCount ?? 0),
			targetFileCount: Number(report.targetFileCount ?? 0),
			sampleLimit: limit,
			sampledChangedPaths: samplePaths(report, limit),
		},
		guidance:
			total === 0
				? "Public main matches the sanitized private source tree for mirrored paths."
				: "Let internal main generate and merge the public sync PR before relying on public main.",
	};
}

function formatRef(context) {
	const ref = context.branch || "detached";
	const sha = context.sha ? context.sha.slice(0, 12) : "unknown";
	return context.remote ? `${context.remote}@${ref} (${sha})` : `${ref} (${sha})`;
}

function buildMarkdown(status) {
	const samples = status.mirror.sampledChangedPaths;
	const lines = [
		"## Public Mirror Drift Audit",
		"",
		`- package: \`${status.mirror.publicPackageName}\``,
		`- private source: \`${formatRef(status.source)}\``,
		`- public projection: \`${formatRef(status.target)}\``,
		`- files to copy or update: \`${status.mirror.filesToCopyOrUpdate}\``,
		`- stale files to delete: \`${status.mirror.staleFilesToDelete}\``,
		`- result: ${status.result === "in_sync" ? "in sync" : "drift detected"}`,
		`- invariant: \`${status.invariant}\``,
	];

	if (samples.length > 0) {
		lines.push("", "### Sample Changed Paths");
		for (const sample of samples) {
			lines.push(`- ${sample}`);
		}
		const total =
			status.mirror.filesToCopyOrUpdate + status.mirror.staleFilesToDelete;
		if (total > samples.length) {
			lines.push(`- ... ${total - samples.length} more`);
		}
	}

	lines.push("", "### Guidance", "", status.guidance);

	return `${lines.join("\n")}\n`;
}

const options = parseArgs(process.argv.slice(2));
const sourceRoot = resolve(options.source);
const targetRoot = resolve(options.target);
const reportPath = resolve(options.report || "public-mirror-drift-report.json");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const mirrorScript = resolve(scriptDir, "prepare-public-release-mirror.mjs");

const result = spawnSync(
	process.execPath,
	[
		mirrorScript,
		"--check",
		"--report",
		reportPath,
		"--source",
		sourceRoot,
		"--target",
		targetRoot,
	],
	{ encoding: "utf8" },
);

if (result.stdout) {
	process.stdout.write(result.stdout);
}
if (result.stderr) {
	process.stderr.write(result.stderr);
}
if (result.error) {
	throw result.error;
}

const report = readReport(reportPath);
const status = buildStatus(report, options.summaryLimit, sourceRoot, targetRoot);
const markdown = buildMarkdown(status);
process.stdout.write(markdown);

if (options.statusOutput) {
	writeFileSync(resolve(options.statusOutput), `${JSON.stringify(status, null, 2)}\n`);
}
if (options.markdownOutput) {
	writeFileSync(resolve(options.markdownOutput), markdown);
}
if (process.env.GITHUB_STEP_SUMMARY) {
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${markdown}`);
}

const copiedCount = Number(report.copiedCount ?? 0);
const deletedCount = Number(report.deletedCount ?? 0);
if (copiedCount + deletedCount > 0) {
	console.error(
		"Public mirror drift detected. Let internal main generate and merge the public sync PR before relying on public main.",
	);
	process.exit(1);
}

process.exit(result.status ?? 0);
