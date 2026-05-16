#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectCliEntrypoint } from "./direct-cli-entrypoint.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cli = join(scriptDir, "..", "dist", "cli.js");
const baseEnv = {
	...process.env,
	NO_COLOR: "1",
	MAESTRO_TELEMETRY_DISABLED: "1",
};

const DEFAULT_MAX_TOTAL_TOOL_CALLS = 3;
const DEFAULT_MAX_IDENTICAL_TOOL_CALLS = 1;
const CODEX_SUBAGENT_WORK_GRAPH_SCHEMA =
	"evalops.maestro.codex.subagent-workgraph.v1";

const loopWarningPatterns = [
	/Exact repetition loop detected/i,
	/Similar operation loop detected/i,
	/Cyclic pattern detected/i,
	/Identical tool call repeated/i,
	/Similar .* calls detected/i,
	/Loop pattern detected/i,
	/loop_detected/i,
	/loop detector is paused/i,
	/tool\.duplicate_request/i,
	/possible doom loop/i,
];

function run(name, args, options = {}) {
	console.log(`[codex-live-smoke] ${name}`);
	const result = spawnSync("node", [cli, ...args], {
		encoding: "utf8",
		env: baseEnv,
		cwd: options.cwd,
		timeout: options.timeoutMs ?? 180_000,
	});
	if (result.stdout) {
		process.stdout.write(result.stdout);
	}
	if (result.stderr) {
		process.stderr.write(result.stderr);
	}
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`${name} failed with exit code ${result.status}`);
	}
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function parsePositiveIntegerEnv(name, fallback) {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${name} must be a positive integer. Received ${raw}`);
	}
	return parsed;
}

export function parseJsonlEvents(output) {
	const events = [];
	for (const [index, rawLine] of output.split(/\r?\n/).entries()) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		try {
			events.push(JSON.parse(line));
		} catch (error) {
			throw new Error(
				`Codex live smoke emitted non-JSON output on line ${index + 1}: ${line}`,
				{ cause: error },
			);
		}
	}
	return events;
}

function stableJson(value) {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJson(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value).sort(([left], [right]) =>
			left.localeCompare(right),
		);
		return `{${entries
			.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function dynamicToolOperationArgs(args) {
	if (!isRecord(args)) {
		return {};
	}
	if (isRecord(args.arguments)) {
		return args.arguments;
	}
	const { callId, threadId, toolCallId, turnId, ...operationArgs } = args;
	void callId;
	void threadId;
	void toolCallId;
	void turnId;
	return operationArgs;
}

function toolCallSignature(call) {
	return `${call.toolName}:${stableJson(dynamicToolOperationArgs(call.args ?? {}))}`;
}

export function summarizeDynamicToolCalls(events) {
	const calls = events
		.filter((event) => event?.type === "item" && event.subtype === "tool_call")
		.map((event) => ({
			toolName: event.data?.toolName,
			args: event.data?.args ?? {},
			toolCallId: event.data?.toolCallId,
			signature: toolCallSignature({
				toolName: event.data?.toolName,
				args: event.data?.args ?? {},
			}),
		}));
	const bySignature = new Map();
	for (const call of calls) {
		bySignature.set(call.signature, (bySignature.get(call.signature) ?? 0) + 1);
	}
	const maxIdenticalCalls =
		bySignature.size === 0 ? 0 : Math.max(...bySignature.values());
	return {
		calls,
		totalCalls: calls.length,
		uniqueCalls: bySignature.size,
		maxIdenticalCalls,
	};
}

export function getFinalAssistantText(events) {
	const completions = events.filter(
		(event) => event?.type === "item" && event.subtype === "message_complete",
	);
	const final = completions.at(-1);
	const text = final?.data?.text;
	return typeof text === "string" ? text : "";
}

function findLoopWarningText(output) {
	for (const pattern of loopWarningPatterns) {
		const match = output.match(pattern);
		if (match) {
			return match[0];
		}
	}
	return null;
}

function assertNoLoopWarnings(stdout, stderr = "") {
	const combinedOutput = `${stdout}\n${stderr}`;
	const warningText = findLoopWarningText(combinedOutput);
	if (warningText) {
		throw new Error(
			`Codex live smoke emitted a loop warning: ${warningText}`,
		);
	}
}

export function assertBoundedDynamicToolUse({
	stdout,
	stderr = "",
	expectedToken,
	maxTotalToolCalls = DEFAULT_MAX_TOTAL_TOOL_CALLS,
	maxIdenticalToolCalls = DEFAULT_MAX_IDENTICAL_TOOL_CALLS,
}) {
	assertNoLoopWarnings(stdout, stderr);

	const events = parseJsonlEvents(stdout);
	const finalAssistantText = getFinalAssistantText(events).trim();
	if (finalAssistantText !== expectedToken) {
		throw new Error(
			`real inference final assistant text did not exactly match expected token ${expectedToken}. Received ${JSON.stringify(finalAssistantText)}`,
		);
	}

	const summary = summarizeDynamicToolCalls(events);
	if (summary.totalCalls === 0) {
		throw new Error("real inference did not execute any dynamic tools");
	}
	if (summary.totalCalls > maxTotalToolCalls) {
		throw new Error(
			`real inference executed ${summary.totalCalls} dynamic tools, exceeding limit ${maxTotalToolCalls}`,
		);
	}
	if (summary.maxIdenticalCalls > maxIdenticalToolCalls) {
		throw new Error(
			`real inference repeated an identical dynamic tool call ${summary.maxIdenticalCalls} times, exceeding limit ${maxIdenticalToolCalls}`,
		);
	}
	return summary;
}

function toolEvents(events, subtype, toolName) {
	return events.filter(
		(event) =>
			event?.type === "item" &&
			event.subtype === subtype &&
			event.data?.toolName === toolName,
	);
}

function toolResultDetails(event) {
	const result = event?.data?.result;
	if (isRecord(result) && isRecord(result.details)) {
		return result.details;
	}
	const data = event?.data;
	if (isRecord(data) && isRecord(data.details)) {
		return data.details;
	}
	return {};
}

function assertCodexWorkGraph(
	graph,
	label,
	expectedTool,
	{ allowEmptyChildRuns = false } = {},
) {
	if (!isRecord(graph)) {
		throw new Error(`${label} is missing codexWorkGraph`);
	}
	if (graph.schemaVersion !== CODEX_SUBAGENT_WORK_GRAPH_SCHEMA) {
		throw new Error(
			`${label} has unexpected codexWorkGraph schema ${JSON.stringify(graph.schemaVersion)}`,
		);
	}
	if (graph.tool !== expectedTool) {
		throw new Error(
			`${label} has unexpected codexWorkGraph tool ${JSON.stringify(graph.tool)}`,
		);
	}
	if (typeof graph.toolCallId !== "string" || graph.toolCallId.length === 0) {
		throw new Error(`${label} codexWorkGraph is missing toolCallId`);
	}
	if (!Array.isArray(graph.childRuns)) {
		throw new Error(`${label} codexWorkGraph is missing childRuns`);
	}
	if (!allowEmptyChildRuns && graph.childRuns.length === 0) {
		throw new Error(`${label} codexWorkGraph is missing childRuns`);
	}
	for (const [index, childRun] of graph.childRuns.entries()) {
		if (!isRecord(childRun)) {
			throw new Error(`${label} childRuns[${index}] is not an object`);
		}
		for (const key of ["threadId", "childRunId", "operation"]) {
			if (typeof childRun[key] !== "string" || childRun[key].length === 0) {
				throw new Error(`${label} childRuns[${index}] is missing ${key}`);
			}
		}
	}
	return graph.childRuns;
}

function assertToolCallWorkGraph(event, label, expectedTool, options) {
	const args = event?.data?.args;
	const graph = isRecord(args) ? args.codexWorkGraph : undefined;
	return assertCodexWorkGraph(graph, label, expectedTool, options);
}

function assertToolResultWorkGraph(event, label, expectedTool, options) {
	const details = toolResultDetails(event);
	return assertCodexWorkGraph(
		details.codexWorkGraph,
		label,
		expectedTool,
		options,
	);
}

function sortedChildRunIds(childRuns, label) {
	const ids = childRuns.map((childRun) => childRun.childRunId).sort();
	if (ids.length === 0) {
		throw new Error(`${label} has no childRunIds`);
	}
	return ids;
}

function childRunIdsFromEvent(event) {
	const args = event?.data?.args;
	const details = toolResultDetails(event);
	const ids = isRecord(args) ? args.childRunIds : details.childRunIds;
	return Array.isArray(ids)
		? ids.filter((id) => typeof id === "string" && id.length > 0).sort()
		: [];
}

function formatIds(ids) {
	return JSON.stringify([...ids].sort());
}

function assertSameChildRunIds(expectedIds, actualIds, label) {
	if (
		expectedIds.length !== actualIds.length ||
		expectedIds.some((id, index) => id !== actualIds[index])
	) {
		throw new Error(
			`${label} childRunIds ${formatIds(actualIds)} do not match spawned childRunIds ${formatIds(expectedIds)}`,
		);
	}
}

function assertEventTargetsSpawnedChildRuns(event, graphChildRuns, spawnedIds, label) {
	const graphIds = sortedChildRunIds(graphChildRuns, `${label} codexWorkGraph`);
	assertSameChildRunIds(spawnedIds, graphIds, `${label} codexWorkGraph`);

	const eventIds = childRunIdsFromEvent(event);
	if (eventIds.length > 0) {
		assertSameChildRunIds(spawnedIds, eventIds, label);
	}
}

function assertWaitResultHasCompletedAgentState(event, expectedChildRuns) {
	const details = toolResultDetails(event);
	const states = details.agentsStates;
	if (!isRecord(states) || Object.keys(states).length === 0) {
		throw new Error(
			"codex.subagent.wait result is missing child agentsStates evidence",
		);
	}
	for (const childRun of expectedChildRuns) {
		const state = states[childRun.threadId];
		if (!isRecord(state)) {
			throw new Error(
				`codex.subagent.wait result is missing child agent state for ${childRun.threadId}`,
			);
		}
		if (state.status !== "completed") {
			throw new Error(
				`codex.subagent.wait child ${childRun.threadId} status ${JSON.stringify(state.status)} is not completed`,
			);
		}
	}
}

function assertExactlyOneToolEvent(events, label) {
	if (events.length !== 1) {
		throw new Error(
			`subagent smoke expected exactly one ${label}, received ${events.length}`,
		);
	}
}

export function assertSubagentWorkGraphUse({
	stdout,
	stderr = "",
	expectedToken,
}) {
	assertNoLoopWarnings(stdout, stderr);

	const events = parseJsonlEvents(stdout);
	const finalAssistantText = getFinalAssistantText(events).trim();
	if (finalAssistantText !== expectedToken) {
		throw new Error(
			`subagent smoke final assistant text did not exactly match expected token ${expectedToken}. Received ${JSON.stringify(finalAssistantText)}`,
		);
	}

	const spawnCalls = toolEvents(
		events,
		"tool_call",
		"codex.subagent.spawnAgent",
	);
	const spawnResults = toolEvents(
		events,
		"tool_result",
		"codex.subagent.spawnAgent",
	);
	const waitCalls = toolEvents(events, "tool_call", "codex.subagent.wait");
	const waitResults = toolEvents(events, "tool_result", "codex.subagent.wait");

	assertExactlyOneToolEvent(
		spawnCalls,
		"codex.subagent.spawnAgent tool_call",
	);
	assertExactlyOneToolEvent(
		spawnResults,
		"codex.subagent.spawnAgent tool_result",
	);
	assertExactlyOneToolEvent(waitCalls, "codex.subagent.wait tool_call");
	assertExactlyOneToolEvent(waitResults, "codex.subagent.wait tool_result");

	const spawnCallChildRuns = assertToolCallWorkGraph(
		spawnCalls[0],
		"codex.subagent.spawnAgent tool_call",
		"spawnAgent",
		{ allowEmptyChildRuns: true },
	);
	const spawnResultChildRuns = assertToolResultWorkGraph(
		spawnResults[0],
		"codex.subagent.spawnAgent tool_result",
		"spawnAgent",
	);
	const waitCallChildRuns = assertToolCallWorkGraph(
		waitCalls[0],
		"codex.subagent.wait tool_call",
		"wait",
	);
	const waitResultChildRuns = assertToolResultWorkGraph(
		waitResults[0],
		"codex.subagent.wait tool_result",
		"wait",
	);
	const spawnedIds = sortedChildRunIds(
		spawnResultChildRuns,
		"codex.subagent.spawnAgent tool_result codexWorkGraph",
	);
	if (spawnCallChildRuns.length > 0) {
		assertEventTargetsSpawnedChildRuns(
			spawnCalls[0],
			spawnCallChildRuns,
			spawnedIds,
			"codex.subagent.spawnAgent tool_call",
		);
	}
	assertEventTargetsSpawnedChildRuns(
		spawnResults[0],
		spawnResultChildRuns,
		spawnedIds,
		"codex.subagent.spawnAgent tool_result",
	);
	assertEventTargetsSpawnedChildRuns(
		waitCalls[0],
		waitCallChildRuns,
		spawnedIds,
		"codex.subagent.wait tool_call",
	);
	assertEventTargetsSpawnedChildRuns(
		waitResults[0],
		waitResultChildRuns,
		spawnedIds,
		"codex.subagent.wait tool_result",
	);
	assertWaitResultHasCompletedAgentState(waitResults[0], waitResultChildRuns);

	return {
		spawnCalls: spawnCalls.length,
		spawnResults: spawnResults.length,
		waitCalls: waitCalls.length,
		waitResults: waitResults.length,
		childRunCount:
			spawnCallChildRuns.length +
			spawnResultChildRuns.length +
			waitCallChildRuns.length +
			waitResultChildRuns.length,
	};
}

export function main() {
	run("doctor", ["codex", "doctor"], { timeoutMs: 60_000 });

	const tempDir = mkdtempSync(join(tmpdir(), "maestro-codex-live-"));
	try {
		const token = `codex-live-smoke-${Date.now().toString(36)}`;
		const tokenPath = join(tempDir, "token.txt");
		const maxTotalToolCalls = parsePositiveIntegerEnv(
			"MAESTRO_CODEX_LIVE_SMOKE_MAX_TOTAL_TOOL_CALLS",
			DEFAULT_MAX_TOTAL_TOOL_CALLS,
		);
		const maxIdenticalToolCalls = parsePositiveIntegerEnv(
			"MAESTRO_CODEX_LIVE_SMOKE_MAX_IDENTICAL_TOOL_CALLS",
			DEFAULT_MAX_IDENTICAL_TOOL_CALLS,
		);
		writeFileSync(tokenPath, `${token}\n`, "utf8");

		const result = run(
			"real inference with dynamic read tool",
			[
				"--provider",
				"openai-codex",
				"--model",
				"gpt-5.5",
				"--mode",
				"json",
				"--no-session",
				"--approval-mode",
				"fail",
				"--sandbox",
				"read-only",
				`Use exactly one dynamic tool call: read ${tokenPath}. Do not read README.md, package READMEs, directories, or any other file. After that single read, reply exactly with the token in that file.`,
			],
			{ cwd: tempDir, timeoutMs: 240_000 },
		);
		const summary = assertBoundedDynamicToolUse({
			...result,
			expectedToken: token,
			maxTotalToolCalls,
			maxIdenticalToolCalls,
		});
		console.log("[codex-live-smoke] real inference returned expected token");
		console.log(
			`[codex-live-smoke] dynamic tool calls bounded: total=${summary.totalCalls} unique=${summary.uniqueCalls} max_identical=${summary.maxIdenticalCalls}`,
		);

		const subagentToken = `codex-subagent-live-smoke-${Date.now().toString(36)}`;
		const subagentResult = run(
			"real inference with Codex subagent",
			[
				"--provider",
				"openai-codex",
				"--model",
				"gpt-5.5",
				"--mode",
				"json",
				"--no-session",
				"--approval-mode",
				"fail",
				"--sandbox",
				"read-only",
				`Spawn exactly one Codex subagent with this child task: reply exactly ${subagentToken}. Wait for the subagent. Then reply exactly ${subagentToken} and nothing else.`,
			],
			{ cwd: tempDir, timeoutMs: 240_000 },
		);
		const subagentSummary = assertSubagentWorkGraphUse({
			...subagentResult,
			expectedToken: subagentToken,
		});
		console.log("[codex-live-smoke] subagent returned expected token");
		console.log(
			`[codex-live-smoke] subagent work graph observed: spawn=${subagentSummary.spawnCalls} wait=${subagentSummary.waitCalls} child_runs=${subagentSummary.childRunCount}`,
		);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

if (isDirectCliEntrypoint(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
