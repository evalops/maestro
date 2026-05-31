#!/usr/bin/env tsx
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Type } from "@sinclair/typebox";
import { ProviderTransport } from "../src/agent/transport.js";
import type {
	AgentEvent,
	AgentTool,
	Message,
	Model,
} from "../src/agent/types.js";

type Phase = "inspect" | "commit" | "verify";

type TimedToolRecord = {
	id: string;
	phase: Phase;
	startedAt: number;
	endedAt?: number;
};

type ConditionResult = {
	name: string;
	description: string;
	passed: boolean;
};

const READ_DELAY_MS = Number(process.env.MAESTRO_TOOL_SPEED_READ_DELAY_MS ?? 80);
const COMMIT_DELAY_MS = Number(
	process.env.MAESTRO_TOOL_SPEED_COMMIT_DELAY_MS ?? 20,
);

const model: Model<"scripted-replay"> = {
	id: "maestro-replay-v1",
	name: "Maestro scripted replay",
	api: "scripted-replay",
	provider: "scripted-replay",
	baseUrl: "scripted-replay://local",
	reasoning: false,
	toolUse: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4_096,
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeScenario(path: string): void {
	const inspectCalls = Array.from({ length: 4 }, (_, index) => ({
		kind: "tool_call",
		id: `inspect-${index + 1}`,
		tool: "read_probe",
		input: { phase: "inspect", slot: index + 1 },
		expectedResult: "success",
	}));
	const verifyCalls = Array.from({ length: 4 }, (_, index) => ({
		kind: "tool_call",
		id: `verify-${index + 1}`,
		tool: "read_probe",
		input: { phase: "verify", slot: index + 1 },
		expectedResult: "success",
	}));
	const scenario = {
		schemaVersion: "evalops.maestro.scripted-scenario.v1",
		id: "tool-call-speed-complex-goal",
		description:
			"Inspect four independent inputs, commit one mutation, then verify four independent outputs.",
		metadata: {
			recordedFrom: "tool-call-speed-harness",
			recordedAt: new Date(0).toISOString(),
			modelOriginal: "maestro-replay-v1",
			toolsExpected: ["read_probe", "commit_step"],
			auditEvents: [],
		},
		frames: [
			{
				index: 0,
				statements: [
					{
						kind: "text",
						text: "I will inspect inputs, commit the plan, and verify outputs.",
					},
					...inspectCalls,
					{
						kind: "tool_call",
						id: "commit-1",
						tool: "commit_step",
						input: { label: "apply-plan" },
						expectedResult: "success",
					},
					...verifyCalls,
				],
			},
			{
				index: 1,
				statements: [
					{
						kind: "text",
						text: "The complex tool-call goal is complete.",
					},
					{ kind: "end", reason: "complete" },
				],
			},
		],
		assertions: [
			{ id: "read-probe-called", kind: "tool_called", tool: "read_probe" },
			{ id: "commit-step-called", kind: "tool_called", tool: "commit_step" },
		],
	};
	writeFileSync(path, JSON.stringify(scenario, null, 2));
}

function spread(records: TimedToolRecord[]): number {
	if (records.length === 0) return 0;
	return (
		Math.max(...records.map((record) => record.startedAt)) -
		Math.min(...records.map((record) => record.startedAt))
	);
}

function maxEndedAt(records: TimedToolRecord[]): number {
	return Math.max(...records.map((record) => record.endedAt ?? 0));
}

function toolPhaseMs(records: TimedToolRecord[]): number {
	if (records.length === 0) return 0;
	const firstStart = Math.min(...records.map((record) => record.startedAt));
	const lastEnd = Math.max(...records.map((record) => record.endedAt ?? 0));
	return lastEnd - firstStart;
}

async function main(): Promise<void> {
	const tempDir = mkdtempSync(join(tmpdir(), "maestro-tool-speed-"));
	const scenarioPath = join(tempDir, "scenario.json");
	makeScenario(scenarioPath);
	process.env.MAESTRO_SCENARIO_PATH = scenarioPath;

	const records: TimedToolRecord[] = [];
	let activeReadOnlyTools = 0;
	let mutationOverlapCount = 0;

	const readProbeTool: AgentTool = {
		name: "read_probe",
		description: "Read-only latency probe.",
		parameters: Type.Object({
			phase: Type.Union([Type.Literal("inspect"), Type.Literal("verify")]),
			slot: Type.Integer(),
		}),
		annotations: {
			readOnlyHint: true,
		},
		execute: async (toolCallId, args) => {
			const record: TimedToolRecord = {
				id: toolCallId,
				phase: args.phase as "inspect" | "verify",
				startedAt: performance.now(),
			};
			records.push(record);
			activeReadOnlyTools += 1;
			await sleep(READ_DELAY_MS);
			activeReadOnlyTools -= 1;
			record.endedAt = performance.now();
			return {
				content: [
					{
						type: "text",
						text: `${String(args.phase)}:${String(args.slot)}`,
					},
				],
			};
		},
	};
	const commitStepTool: AgentTool = {
		name: "commit_step",
		description: "Mutating latency probe.",
		parameters: Type.Object({
			label: Type.String(),
		}),
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
		},
		execute: async (toolCallId, args) => {
			if (activeReadOnlyTools > 0) {
				mutationOverlapCount += 1;
			}
			const record: TimedToolRecord = {
				id: toolCallId,
				phase: "commit",
				startedAt: performance.now(),
			};
			records.push(record);
			await sleep(COMMIT_DELAY_MS);
			record.endedAt = performance.now();
			return {
				content: [{ type: "text", text: `commit:${String(args.label)}` }],
			};
		},
	};

	const userMessage: Message = {
		role: "user",
		content:
			"Complex goal: inspect four independent inputs, commit one plan change, then verify four independent outputs.",
		timestamp: Date.now(),
	};
	const transport = new ProviderTransport({
		maxConcurrentToolExecutions: 2,
		platformToolExecutionBridge: false,
	});
	const startedAt = performance.now();
	const events: AgentEvent[] = [];
	try {
		for await (const event of transport.run([userMessage], userMessage, {
			systemPrompt: "Use the scripted replay tool calls.",
			tools: [readProbeTool, commitStepTool],
			model,
		})) {
			events.push(event);
		}
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
	const elapsedMs = performance.now() - startedAt;
	const inspectRecords = records.filter((record) => record.phase === "inspect");
	const verifyRecords = records.filter((record) => record.phase === "verify");
	const commitRecord = records.find((record) => record.phase === "commit");
	const toolResults = events.filter(
		(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
			event.type === "tool_execution_end",
	);

	const preconditions: ConditionResult[] = [
		{
			name: "complex_goal_shape",
			description:
				"Four inspect reads, one commit mutation, and four verify reads are present.",
			passed:
				inspectRecords.length === 4 &&
				Boolean(commitRecord) &&
				verifyRecords.length === 4,
		},
		{
			name: "read_only_annotations",
			description:
				"The probe read tool is explicitly annotated read-only; commit is destructive.",
			passed:
				readProbeTool.annotations?.readOnlyHint === true &&
				commitStepTool.annotations?.destructiveHint === true,
		},
	];
	const postconditions: ConditionResult[] = [
		{
			name: "inspect_wave_parallel",
			description: "The first four read-only inspections start as one wave.",
			passed: spread(inspectRecords) < 40,
		},
		{
			name: "commit_after_inspect",
			description:
				"The mutating commit starts only after the inspect wave has completed.",
			passed: Boolean(
				commitRecord &&
					commitRecord.startedAt >= maxEndedAt(inspectRecords),
			),
		},
		{
			name: "no_mutation_overlap",
			description: "No mutating tool overlaps an active read-only tool.",
			passed: mutationOverlapCount === 0,
		},
		{
			name: "verify_after_commit_parallel",
			description:
				"The final read-only verifications start as one wave after the commit ends.",
			passed: Boolean(
				commitRecord?.endedAt &&
					Math.min(...verifyRecords.map((record) => record.startedAt)) >=
						commitRecord.endedAt &&
					spread(verifyRecords) < 40,
			),
		},
		{
			name: "all_tool_results_emitted",
			description: "Every requested tool call emits a tool execution result.",
			passed: toolResults.length === 9,
		},
	];
	const assertionsPassed = [...preconditions, ...postconditions].every(
		(condition) => condition.passed,
	);

	console.log(
		JSON.stringify(
			{
				tool_phase_ms: Number(toolPhaseMs(records).toFixed(3)),
				elapsed_ms: Number(elapsedMs.toFixed(3)),
				assertions_passed: assertionsPassed ? 1 : 0,
				mutation_overlap_count: mutationOverlapCount,
				first_read_wave_ms: Number(spread(inspectRecords).toFixed(3)),
				verify_read_wave_ms: Number(spread(verifyRecords).toFixed(3)),
				total_tool_calls: toolResults.length,
				plateau_delta_ms: 0,
				preconditions,
				postconditions,
			},
			null,
			2,
		),
	);
}

await main();
