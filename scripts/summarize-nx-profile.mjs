#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
	const args = {
		profile: "",
		targets: "",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--profile":
				args.profile = argv[++index] ?? "";
				break;
			case "--targets":
				args.targets = argv[++index] ?? "";
				break;
			default:
				throw new Error(
					"Usage: node scripts/summarize-nx-profile.mjs --profile <path> [--targets <path>]",
				);
		}
	}

	if (!args.profile) {
		throw new Error(
			"Usage: node scripts/summarize-nx-profile.mjs --profile <path> [--targets <path>]",
		);
	}

	return args;
}

function asObject(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}

function profileEvents(profile) {
	if (Array.isArray(profile)) {
		return profile;
	}
	const objectProfile = asObject(profile);
	return Array.isArray(objectProfile.traceEvents) ? objectProfile.traceEvents : [];
}

function targetNameFromEvent(event) {
	const args = asObject(event.args);
	const target = asObject(args.target);
	const project = typeof target.project === "string" ? target.project : "";
	const targetName = typeof target.target === "string" ? target.target : "";
	const configuration =
		typeof target.configuration === "string" ? target.configuration : "";

	if (project && targetName) {
		return configuration
			? `${project}:${targetName}:${configuration}`
			: `${project}:${targetName}`;
	}

	return typeof event.name === "string" ? event.name : "";
}

export function summarizeNxProfile(profile) {
	return profileEvents(profile)
		.map((rawEvent) => asObject(rawEvent))
		.filter((event) => event.ph === "X" && typeof event.dur === "number")
		.map((event) => {
			const args = asObject(event.args);
			return {
				durationMs: Math.round(event.dur / 1000),
				status: typeof args.status === "string" ? args.status : "unknown",
				target: targetNameFromEvent(event),
			};
		})
		.filter((row) => row.target.length > 0)
		.sort(
			(left, right) =>
				right.durationMs - left.durationMs ||
				left.target.localeCompare(right.target),
		);
}

function formatDuration(durationMs) {
	if (durationMs < 1000) {
		return `${durationMs}ms`;
	}
	const seconds = durationMs / 1000;
	return `${Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
}

export function formatNxTargetTimingSummary(rows, { expectedTargets = [] } = {}) {
	const profiledTargets = new Set(rows.map((row) => row.target));
	const missingTargets = expectedTargets
		.filter((target) => target && !profiledTargets.has(target))
		.sort((left, right) => left.localeCompare(right));
	const lines = ["Nx target timings:", "target | status | duration"];

	for (const row of rows) {
		lines.push(`${row.target} | ${row.status} | ${formatDuration(row.durationMs)}`);
	}
	for (const target of missingTargets) {
		lines.push(`${target} | not-profiled | -`);
	}
	if (rows.length === 0 && missingTargets.length === 0) {
		lines.push("(no Nx task timing events found)");
	}

	return `${lines.join("\n")}\n`;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function readTargets(path) {
	if (!path || !existsSync(path)) {
		return [];
	}
	return readFileSync(path, "utf8")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const rows = summarizeNxProfile(readJson(args.profile));
	process.stdout.write(
		formatNxTargetTimingSummary(rows, {
			expectedTargets: readTargets(args.targets),
		}),
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
