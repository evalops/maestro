#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const jsonOutput = process.argv.includes("--json");
const argsPaths = process.argv
	.slice(2)
	.filter((arg) => arg !== "--json" && !arg.startsWith("--"));
const envPath =
	process.env.MAESTRO_TELEMETRY_FILE ?? process.env.PLAYWRIGHT_TELEMETRY_FILE;

const defaultLogCandidates = [
	envPath ? { path: envPath, preserveRelativePath: true } : undefined,
	{ path: join(homedir(), ".maestro", "telemetry.log") },
	{ path: join(homedir(), ".composer", "telemetry.log") },
].filter(Boolean);

function resolveLogPath(input, { preserveRelativePath = false } = {}) {
	return isAbsolute(input) || preserveRelativePath
		? input
		: join(projectRoot, input);
}

async function expandTelemetrySource(input, options) {
	const resolved = resolveLogPath(input, options);
	if (!existsSync(resolved)) {
		return [];
	}
	const info = await stat(resolved);
	if (!info.isDirectory()) {
		return [resolved];
	}
	const entries = await readdir(resolved, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => join(resolved, entry.name))
		.filter((entryPath) => [".jsonl", ".log"].includes(extname(entryPath)))
		.sort();
}

async function resolveTelemetrySources() {
	const requestedPaths =
		argsPaths.length > 0
			? argsPaths.map((path) => ({ path }))
			: defaultLogCandidates.slice(0, 1);
	const sources = [];
	for (const requestedPath of requestedPaths) {
		sources.push(
			...(await expandTelemetrySource(
				requestedPath.path,
				requestedPath.preserveRelativePath
					? { preserveRelativePath: true }
					: undefined,
			)),
		);
	}
	if (sources.length > 0 || argsPaths.length > 0 || envPath) {
		return {
			requestedPaths: requestedPaths.map((candidate) => candidate.path),
			sources,
		};
	}
	for (const candidate of defaultLogCandidates.slice(1)) {
		const candidateSources = await expandTelemetrySource(
			candidate.path,
			candidate.preserveRelativePath ? { preserveRelativePath: true } : undefined,
		);
		if (candidateSources.length > 0) {
			return {
				requestedPaths: [candidate.path],
				sources: candidateSources,
			};
		}
	}
	return {
		requestedPaths: defaultLogCandidates.length
			? [defaultLogCandidates[0].path]
			: [join(homedir(), ".maestro", "telemetry.log")],
		sources: [],
	};
}

const { requestedPaths, sources } = await resolveTelemetrySources();

if (sources.length === 0) {
	console.error(`Telemetry log not found at: ${requestedPaths.join(", ")}`);
	process.exit(1);
}

const sourceContents = await Promise.all(
	sources.map(async (sourcePath) => ({
		path: sourcePath,
		raw: await readFile(sourcePath, "utf-8"),
	})),
);
const lines = sourceContents.flatMap(({ path, raw }) =>
	raw
		.split("\n")
		.map((line, index) => ({ path, lineNumber: index + 1, text: line.trim() }))
		.filter((line) => line.text.length > 0),
);

let toolExecutions = 0;
let toolSuccess = 0;
let totalDuration = 0;
let evaluations = 0;
let evalSuccess = 0;
let parsedEventCount = 0;
let malformedLineCount = 0;
let canonicalTurnCount = 0;
let canonicalSchedulingSummaryCount = 0;
let rawToolPhaseSummaryCount = 0;
let dedupedRawToolPhaseSummaryCount = 0;
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
	modelSingletonTurnCount: 0,
	modelMultiCallTurnCount: 0,
	avoidableSingletonCount: 0,
	topSerializationReasons: [],
	serializationReasonTiming: [],
	nextActions: [],
	operatorSummary: null,
	hasSchedulingData: false,
	schedulingCoverageRatio: 0,
	canonicalSchedulingSummaryCount: 0,
	rawToolPhaseSummaryCount: 0,
	dedupedRawToolPhaseSummaryCount: 0,
};
const serializationReasons = new Map();
const serializationReasonTiming = new Map();
const canonicalToolSchedulingSummaries = [];
const canonicalTurnIds = new Set();
const standaloneToolPhaseSummaries = [];

function incrementReasonTiming(reason, waitMs = 0) {
	if (!reason) return;
	const current = serializationReasonTiming.get(reason) ?? {
		reason,
		count: 0,
		totalWaitMs: 0,
	};
	current.count += 1;
	current.totalWaitMs += Math.max(0, Number(waitMs) || 0);
	serializationReasonTiming.set(reason, current);
}

function addSerializationReason(reason, count = 1) {
	if (!reason || count <= 0) return;
	serializationReasons.set(reason, (serializationReasons.get(reason) ?? 0) + count);
}

function decisionOutcome(decision) {
	if (!decision || typeof decision !== "object") {
		return undefined;
	}
	if (typeof decision.outcome === "string") {
		return decision.outcome;
	}
	if (decision.cacheHit === true) {
		return "cached";
	}
	if (decision.decision === "skipped") {
		return "skipped";
	}
	if (decision.decision === "delayed" || decision.blockedByMutation === true) {
		return "delayed";
	}
	if (decision.decision === "parallelized") {
		return "parallelized";
	}
	if (decision.decision === "serialized" || decision.decision === "scheduled") {
		return "serialized";
	}
	return undefined;
}

function decisionWaitMs(decision) {
	return Number(decision?.waitMs ?? decision?.schedulerWaitMs) || 0;
}

function recordDecisionTiming(decision) {
	const outcome = decisionOutcome(decision);
	if (outcome !== "serialized" && outcome !== "delayed") {
		return;
	}
	incrementReasonTiming(decision.reason, decisionWaitMs(decision));
}

function recordToolSchedulingSummary(summary, decisions = []) {
	if (!summary || typeof summary !== "object") return;
	const modelToolCallCount =
		Number(summary.modelToolCallCount ?? summary.modelEmittedToolCallCount) || 0;
	toolScheduling.modelToolCallCount += modelToolCallCount;
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
	if (modelToolCallCount === 1) {
		toolScheduling.modelSingletonTurnCount += 1;
	} else if (modelToolCallCount > 1) {
		toolScheduling.modelMultiCallTurnCount += 1;
	}
	if (summary.batchShapingFeedback?.avoidableSingleton === true) {
		toolScheduling.avoidableSingletonCount += 1;
	}

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
	if (
		!summary.batchShapingFeedback &&
		typeof summary.serializationReasons?.single_read_only_call === "number"
	) {
		toolScheduling.avoidableSingletonCount +=
			Number(summary.serializationReasons.single_read_only_call) || 0;
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
	for (const decision of Array.isArray(summary.decisions)
		? summary.decisions
		: decisions) {
		recordDecisionTiming(decision);
	}
}

function eventTurnId(event) {
	return typeof event.turnId === "string" && event.turnId.length > 0
		? event.turnId
		: undefined;
}

function recordCollectedToolSchedulingSummaries() {
	for (const { summary, decisions } of canonicalToolSchedulingSummaries) {
		recordToolSchedulingSummary(summary, decisions);
	}

	for (const event of standaloneToolPhaseSummaries) {
		const turnId = eventTurnId(event);
		if (turnId && canonicalTurnIds.has(turnId)) {
			dedupedRawToolPhaseSummaryCount += 1;
			continue;
		}
		recordToolSchedulingSummary(event);
	}
}

for (const line of lines) {
	try {
		const event = JSON.parse(line.text);
		parsedEventCount += 1;
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
			canonicalTurnCount += 1;
			const turnId = eventTurnId(event);
			if (event.toolScheduling) {
				if (turnId) {
					canonicalTurnIds.add(turnId);
				}
				canonicalSchedulingSummaryCount += 1;
				canonicalToolSchedulingSummaries.push({
					summary: event.toolScheduling,
					decisions: Array.isArray(event.tools)
						? event.tools
								.map((tool) => tool?.scheduling)
								.filter((scheduling) => scheduling && typeof scheduling === "object")
						: [],
				});
			}
		} else if (event.type === "tool_phase_summary") {
			rawToolPhaseSummaryCount += 1;
			standaloneToolPhaseSummaries.push(event);
		}
	} catch (_error) {
		malformedLineCount += 1;
	}
}

recordCollectedToolSchedulingSummaries();

const averageDuration = toolExecutions > 0 ? totalDuration / toolExecutions : 0;
toolScheduling.topSerializationReasons = [...serializationReasons.entries()]
	.map(([reason, count]) => ({ reason, count }))
	.sort((left, right) => right.count - left.count);
toolScheduling.serializationReasonTiming = [
	...serializationReasonTiming.values(),
]
	.map((entry) => ({
		reason: entry.reason,
		count: entry.count,
		totalWaitMs: Number(entry.totalWaitMs.toFixed(1)),
		averageWaitMs:
			entry.count > 0 ? Number((entry.totalWaitMs / entry.count).toFixed(1)) : 0,
	}))
	.sort((left, right) => right.totalWaitMs - left.totalWaitMs);
toolScheduling.hasSchedulingData =
	canonicalSchedulingSummaryCount + rawToolPhaseSummaryCount > 0;
toolScheduling.canonicalSchedulingSummaryCount = canonicalSchedulingSummaryCount;
toolScheduling.rawToolPhaseSummaryCount = rawToolPhaseSummaryCount;
toolScheduling.dedupedRawToolPhaseSummaryCount = dedupedRawToolPhaseSummaryCount;
toolScheduling.schedulingCoverageRatio =
	canonicalTurnCount > 0
		? Number((canonicalSchedulingSummaryCount / canonicalTurnCount).toFixed(3))
		: toolScheduling.hasSchedulingData
			? 1
			: 0;

function countReason(reason) {
	return serializationReasons.get(reason) ?? 0;
}

function buildNextActions() {
	if (!toolScheduling.hasSchedulingData) {
		return [
			{
				id: "collect_real_tool_phase_telemetry",
				reason:
					"No canonical toolScheduling or raw tool_phase_summary events were found.",
			},
		];
	}
	const actions = [];
	if (
		toolScheduling.avoidableSingletonCount > 0 ||
		countReason("single_read_only_call") > 0
	) {
		actions.push({
			id: "batch_shaping_feedback",
			reason: `${toolScheduling.avoidableSingletonCount} avoidable singleton read-only calls observed.`,
		});
	}
	if (countReason("mutation_unknown_write_set") > 0) {
		actions.push({
			id: "path_scope_inference",
			reason: `${countReason("mutation_unknown_write_set")} calls blocked by unknown mutation write set.`,
		});
	}
	if (toolScheduling.cacheHitCount === 0 && toolScheduling.modelToolCallCount > 0) {
		actions.push({
			id: "adjacent_turn_read_cache",
			reason:
				"No tool-result cache hits were observed in turns with tool calls.",
		});
	}
	if (toolScheduling.mcpOptInCallCount > 0) {
		actions.push({
			id: "mcp_capability_handshake",
			reason: `${toolScheduling.mcpOptInCallCount} MCP opt-in calls depended on static parallel-safety config.`,
		});
	}
	if (
		toolScheduling.totalToolWaitMs > 0 &&
		toolScheduling.delayedCallCount > 0
	) {
		actions.push({
			id: "rust_cancellation_backpressure_parity",
			reason: `${toolScheduling.delayedCallCount} delayed calls accumulated ${toolScheduling.totalToolWaitMs}ms of scheduler wait.`,
		});
	}
	return actions;
}

toolScheduling.nextActions = buildNextActions();

function plural(count, singular, pluralForm = `${singular}s`) {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

function buildOperatorSummary() {
	const serializedOrDelayedCallCount =
		toolScheduling.serializedCallCount + toolScheduling.delayedCallCount;
	const topSerializationReason =
		toolScheduling.topSerializationReasons[0] ?? null;
	const topNextAction = toolScheduling.nextActions[0] ?? null;
	const metrics = [
		plural(toolScheduling.modelToolCallCount, "call"),
		plural(toolScheduling.schedulableWaveCount, "wave"),
		`${toolScheduling.parallelizedCallCount} parallelized`,
		`${serializedOrDelayedCallCount} serialized/delayed`,
		plural(toolScheduling.cacheHitCount, "cache hit"),
	];
	const segments = [metrics.join(", ")];
	if (topSerializationReason) {
		segments.push(
			`top blocker ${topSerializationReason.reason} (${topSerializationReason.count})`,
		);
	}
	segments.push(`next ${topNextAction?.id ?? "none"}`);

	return {
		line: segments.join("; "),
		serializedOrDelayedCallCount,
		topNextActionId: topNextAction?.id ?? "none",
		topSerializationReason,
	};
}

toolScheduling.operatorSummary = buildOperatorSummary();

const logPath = sources.length === 1 ? sources[0] : `${sources.length} telemetry logs`;

if (jsonOutput) {
	console.log(
		JSON.stringify(
			{
				logPath,
				logPaths: sources,
				sourceCount: sources.length,
				lineCount: lines.length,
				parsedEventCount,
				malformedLineCount,
				canonicalTurnCount,
				canonicalSchedulingSummaryCount,
				rawToolPhaseSummaryCount,
				dedupedRawToolPhaseSummaryCount,
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
if (sources.length > 1) {
	console.log(`Source logs: ${sources.map((source) => basename(source)).join(", ")}`);
}
console.log(`Parsed events: ${parsedEventCount}`);
if (malformedLineCount > 0) {
	console.log(`Malformed lines ignored: ${malformedLineCount}`);
}
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
console.log(`Tool scheduling summary: ${toolScheduling.operatorSummary.line}`);
console.log(`Schedulable waves: ${toolScheduling.schedulableWaveCount}`);
console.log(`Parallelized calls: ${toolScheduling.parallelizedCallCount}`);
console.log(`Serialized calls: ${toolScheduling.serializedCallCount}`);
console.log(`Delayed calls: ${toolScheduling.delayedCallCount}`);
console.log(`Cache hits: ${toolScheduling.cacheHitCount}`);
console.log(`Total tool wait: ${toolScheduling.totalToolWaitMs} ms`);
console.log(
	`Scheduling coverage: ${canonicalSchedulingSummaryCount}/${canonicalTurnCount} canonical turns`,
);
console.log(`Model singleton turns: ${toolScheduling.modelSingletonTurnCount}`);
console.log(`Model multi-call turns: ${toolScheduling.modelMultiCallTurnCount}`);
console.log(`Avoidable singleton calls: ${toolScheduling.avoidableSingletonCount}`);
if (toolScheduling.topSerializationReasons.length > 0) {
	console.log("Top serialization reasons:");
	for (const entry of toolScheduling.topSerializationReasons.slice(0, 5)) {
		console.log(`- ${entry.reason}: ${entry.count}`);
	}
}
if (toolScheduling.serializationReasonTiming.length > 0) {
	console.log("Top serialization wait reasons:");
	for (const entry of toolScheduling.serializationReasonTiming.slice(0, 5)) {
		console.log(
			`- ${entry.reason}: ${entry.totalWaitMs} ms (${entry.count} calls)`,
		);
	}
}
if (toolScheduling.nextActions.length > 0) {
	console.log("Suggested next actions:");
	for (const action of toolScheduling.nextActions.slice(0, 5)) {
		console.log(`- ${action.id}: ${action.reason}`);
	}
}
