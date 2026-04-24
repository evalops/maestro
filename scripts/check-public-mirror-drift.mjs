#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
	const args = {
		report: "",
		source: process.cwd(),
		summaryLimit: 25,
		target: "",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--report":
				args.report = argv[++index] ?? args.report;
				break;
			case "--source":
				args.source = argv[++index] ?? args.source;
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

function buildMarkdown(report, limit) {
	const copiedCount = Number(report.copiedCount ?? 0);
	const deletedCount = Number(report.deletedCount ?? 0);
	const total = copiedCount + deletedCount;
	const samples = samplePaths(report, limit);
	const lines = [
		"## Public Mirror Drift Audit",
		"",
		`- package: \`${report.publicPackageName ?? "unknown"}\``,
		`- files to copy or update: \`${copiedCount}\``,
		`- stale files to delete: \`${deletedCount}\``,
		`- result: ${total === 0 ? "in sync" : "drift detected"}`,
	];

	if (samples.length > 0) {
		lines.push("", "### Sample Changed Paths");
		for (const sample of samples) {
			lines.push(`- ${sample}`);
		}
		if (total > samples.length) {
			lines.push(`- ... ${total - samples.length} more`);
		}
	}

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
const markdown = buildMarkdown(report, options.summaryLimit);
process.stdout.write(markdown);

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
