#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const argsPath = process.argv[2];
const envPath = process.env.PLAYWRIGHT_TELEMETRY_FILE;

const logPath = argsPath
	? isAbsolute(argsPath)
		? argsPath
		: join(projectRoot, argsPath)
	: envPath
		? envPath
		: join(homedir(), ".playwright", "telemetry.log");

if (!existsSync(logPath)) {
	console.error(`Telemetry log not found at: ${logPath}`);
	process.exit(1);
}

const raw = await readFile(logPath, "utf-8");
const lines = raw
	.split("\n")
	.map((line) => line.trim())
	.filter(Boolean);

let toolExecutions = 0;
let toolSuccess = 0;
let totalDuration = 0;
let evaluations = 0;
let evalSuccess = 0;

for (const line of lines) {
	try {
		const event = JSON.parse(line);
		if (event.type === "tool-execution") {
			toolExecutions += 1;
			if (event.success) {
				toolSuccess += 1;
			}
			totalDuration += Number(event.durationMs) || 0;
		} else if (event.type === "evaluation") {
			evaluations += 1;
			if (event.success) {
				evalSuccess += 1;
			}
		}
	} catch (_error) {
		// ignore malformed lines
	}
}

const averageDuration = toolExecutions > 0 ? totalDuration / toolExecutions : 0;

console.log("Telemetry Summary\n=================");
console.log(`Log file: ${logPath}`);
console.log(`Tool executions: ${toolExecutions}`);
console.log(
	`Tool success rate: ${toolExecutions === 0 ? "n/a" : `${((toolSuccess / toolExecutions) * 100).toFixed(1)}%`}`,
);
console.log(
	`Average duration: ${toolExecutions === 0 ? "n/a" : `${averageDuration.toFixed(1)} ms`}`,
);
console.log(`Evaluations: ${evaluations}`);
console.log(
	`Evaluation success rate: ${evaluations === 0 ? "n/a" : `${((evalSuccess / evaluations) * 100).toFixed(1)}%`}`,
);
