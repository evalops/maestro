#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const jsonOutput = process.argv.includes("--json");
const argsPath = process.argv.find((arg, index) => index > 1 && arg !== "--json");
const envPath =
	process.env.MAESTRO_TELEMETRY_FILE ?? process.env.PLAYWRIGHT_TELEMETRY_FILE;

const logPath = argsPath
	? isAbsolute(argsPath)
		? argsPath
		: join(projectRoot, argsPath)
	: envPath
		? envPath
		: join(homedir(), ".composer", "telemetry.log");

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
const toolScheduling = {
	modelToolCallCount: 0,
	schedulableWaveCount: 0,
	parallelizedCallCount: 0,
	serializedCallCount: 0,
	delayedCallCount: 0,
	blockedByMutationCount: 0,
	mcpOptInCallCount: 0,
	cacheHitCount: 0,
	totalToolWaitMs: 0,
	topSerializationReasons: [],
};
const serializationReasons = new Map();
const canonicalToolSchedulingSummaries = [];
const canonicalTurnIds = new Set();
const standaloneToolPhaseSummaries = [];

function addSerializationReason(reason, count = 1) {
	if (!reason || count <= 0) return;
	serializationReasons.set(reason, (serializationReasons.get(reason) ?? 0) + count);
}

function recordToolSchedulingSummary(summary) {
	if (!summary || typeof summary !== "object") return;
	toolScheduling.modelToolCallCount +=
		Number(summary.modelToolCallCount ?? summary.modelEmittedToolCallCount) || 0;
	toolScheduling.schedulableWaveCount += Number(summary.schedulableWaveCount) || 0;
	toolScheduling.parallelizedCallCount +=
		Number(summary.parallelizedCallCount ?? summary.actuallyParallelizedCallCount) ||
		0;
	toolScheduling.serializedCallCount += Number(summary.serializedCallCount) || 0;
	toolScheduling.delayedCallCount += Number(summary.delayedCallCount) || 0;
	toolScheduling.blockedByMutationCount +=
		Number(summary.blockedByMutationCount) || 0;
	toolScheduling.mcpOptInCallCount +=
		Number(summary.mcpOptInCallCount ?? summary.mcpOptInUseCount) || 0;
	toolScheduling.cacheHitCount += Number(summary.cacheHitCount) || 0;
	toolScheduling.totalToolWaitMs +=
		Number(summary.totalToolWaitMs ?? summary.toolWaitTimeMs) || 0;

	let usedExplicitReasons = false;
	if (
		summary.serializationReasons &&
		typeof summary.serializationReasons === "object"
	) {
		usedExplicitReasons = true;
		for (const [reason, count] of Object.entries(summary.serializationReasons)) {
			addSerializationReason(reason, Number(count) || 0);
		}
	}
	if (!usedExplicitReasons && Array.isArray(summary.decisions)) {
		for (const decision of summary.decisions) {
			if (
				decision &&
				typeof decision === "object" &&
				(decision.outcome === "serialized" || decision.outcome === "delayed")
			) {
				addSerializationReason(decision.reason);
			}
		}
	}
}

function eventTurnId(event) {
	return typeof event.turnId === "string" && event.turnId.length > 0
		? event.turnId
		: undefined;
}

function recordCollectedToolSchedulingSummaries() {
	for (const summary of canonicalToolSchedulingSummaries) {
		recordToolSchedulingSummary(summary);
	}

	for (const event of standaloneToolPhaseSummaries) {
		const turnId = eventTurnId(event);
		if (turnId && canonicalTurnIds.has(turnId)) {
			continue;
		}
		recordToolSchedulingSummary(event);
	}
}

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
		} else if (event.type === "canonical-turn") {
			const turnId = eventTurnId(event);
			if (event.toolScheduling) {
				if (turnId) {
					canonicalTurnIds.add(turnId);
				}
				canonicalToolSchedulingSummaries.push(event.toolScheduling);
			}
		} else if (event.type === "tool_phase_summary") {
			standaloneToolPhaseSummaries.push(event);
		}
	} catch (_error) {
		// ignore malformed lines
	}
}

recordCollectedToolSchedulingSummaries();

const averageDuration = toolExecutions > 0 ? totalDuration / toolExecutions : 0;
toolScheduling.topSerializationReasons = [...serializationReasons.entries()]
	.map(([reason, count]) => ({ reason, count }))
	.sort((left, right) => right.count - left.count);

if (jsonOutput) {
	console.log(
		JSON.stringify(
			{
				logPath,
				toolExecutions,
				toolSuccess,
				averageDuration,
				evaluations,
				evalSuccess,
				toolScheduling,
			},
			null,
			2,
		),
	);
	process.exit(0);
}

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
console.log(`Model tool calls: ${toolScheduling.modelToolCallCount}`);
console.log(`Schedulable waves: ${toolScheduling.schedulableWaveCount}`);
console.log(`Parallelized calls: ${toolScheduling.parallelizedCallCount}`);
console.log(`Serialized calls: ${toolScheduling.serializedCallCount}`);
console.log(`Delayed calls: ${toolScheduling.delayedCallCount}`);
console.log(`Cache hits: ${toolScheduling.cacheHitCount}`);
if (toolScheduling.topSerializationReasons.length > 0) {
	console.log("Top serialization reasons:");
	for (const entry of toolScheduling.topSerializationReasons.slice(0, 5)) {
		console.log(`- ${entry.reason}: ${entry.count}`);
	}
}
