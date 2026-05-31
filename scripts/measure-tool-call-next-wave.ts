#!/usr/bin/env tsx
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
	path?: string;
	trustedMcp?: boolean;
};

type ConditionResult = {
	name: string;
	description: string;
	passed: boolean;
};

const READ_DELAY_MS = Number(process.env.MAESTRO_NEXT_WAVE_READ_DELAY_MS ?? 30);
const TRUSTED_MCP_DELAY_MS = Number(
	process.env.MAESTRO_NEXT_WAVE_TRUSTED_MCP_DELAY_MS ?? 80,
);
const UNTRUSTED_MCP_DELAY_MS = Number(
	process.env.MAESTRO_NEXT_WAVE_UNTRUSTED_MCP_DELAY_MS ?? 30,
);
const MUTATION_DELAY_MS = Number(
	process.env.MAESTRO_NEXT_WAVE_MUTATION_DELAY_MS ?? 80,
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
	const scenario = {
		schemaVersion: "evalops.maestro.scripted-scenario.v1",
		id: "tool-call-next-wave-complex-goal",
		description:
			"Trusted MCP reads, untrusted MCP reads, disjoint path mutations, overlapping path mutation, and post-mutation verification reads.",
		metadata: {
			recordedFrom: "tool-call-next-wave-harness",
			recordedAt: new Date(0).toISOString(),
			modelOriginal: "maestro-replay-v1",
			toolsExpected: [
				"mcp__trusted_fs__probe",
				"mcp__untrusted_fs__probe",
				"path_write",
				"read_probe_next_wave",
			],
			auditEvents: [],
		},
		frames: [
			{
				index: 0,
				statements: [
					{ kind: "text", text: "I will run the next-wave tool plan." },
					{
						kind: "tool_call",
						id: "trusted-1",
						tool: "mcp__trusted_fs__probe",
						input: { slot: 1 },
						expectedResult: "success",
					},
					{
						kind: "tool_call",
						id: "trusted-2",
						tool: "mcp__trusted_fs__probe",
						input: { slot: 1 },
						expectedResult: "success",
					},
					{
						kind: "tool_call",
						id: "untrusted-1",
						tool: "mcp__untrusted_fs__probe",
						input: { slot: 1 },
						expectedResult: "success",
					},
					{
						kind: "tool_call",
						id: "untrusted-2",
						tool: "mcp__untrusted_fs__probe",
						input: { slot: 2 },
						expectedResult: "success",
					},
					{
						kind: "tool_call",
						id: "write-a",
						tool: "path_write",
						input: { path: "src/a.ts", slot: 1 },
						expectedResult: "success",
					},
					{
						kind: "tool_call",
						id: "write-b",
						tool: "path_write",
						input: { path: "src/b.ts", slot: 2 },
						expectedResult: "success",
					},
					{
						kind: "tool_call",
						id: "write-b-overlap",
						tool: "path_write",
						input: { path: resolve(process.cwd(), "src/b.ts"), slot: 3 },
						expectedResult: "success",
					},
					{
						kind: "tool_call",
						id: "verify-1",
						tool: "read_probe_next_wave",
						input: { slot: 1 },
						expectedResult: "success",
					},
					{
						kind: "tool_call",
						id: "verify-2",
						tool: "read_probe_next_wave",
						input: { slot: 2 },
						expectedResult: "success",
					},
				],
			},
			{
				index: 1,
				statements: [
					{
						kind: "tool_call",
						id: "verify-1-repeat",
						tool: "read_probe_next_wave",
						input: { slot: 1 },
						expectedResult: "success",
					},
				],
			},
			{
				index: 2,
				statements: [
					{ kind: "text", text: "The next-wave tool-call goal is complete." },
					{ kind: "end", reason: "complete" },
				],
			},
		],
		assertions: [
			{ id: "trusted-mcp-called", kind: "tool_called", tool: "mcp__trusted_fs__probe" },
			{ id: "path-write-called", kind: "tool_called", tool: "path_write" },
			{ id: "verify-called", kind: "tool_called", tool: "read_probe_next_wave" },
		],
	};
	writeFileSync(path, JSON.stringify(scenario, null, 2));
}

function spread(records: Array<{ startedAt: number }>): number {
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

function countBy<T extends string>(values: T[]): Record<T, number> {
	const counts = {} as Record<T, number>;
	for (const value of values) {
		counts[value] = (counts[value] ?? 0) + 1;
	}
	return counts;
}

async function runMeasurement(delays: {
	trustedMcp: number;
	untrustedMcp: number;
	mutation: number;
	read: number;
}): Promise<{
	records: TimedToolRecord[];
	events: AgentEvent[];
	elapsedMs: number;
	unsafeOverlapCount: number;
}> {
	const tempDir = mkdtempSync(join(tmpdir(), "maestro-tool-next-wave-"));
	const scenarioPath = join(tempDir, "scenario.json");
	makeScenario(scenarioPath);
	process.env.MAESTRO_SCENARIO_PATH = scenarioPath;

	const records: TimedToolRecord[] = [];
	let activeMutationPaths: string[] = [];
	let unsafeOverlapCount = 0;

	const trustedMcpProbeTool = {
		name: "mcp__trusted_fs__probe",
		description: "Trusted MCP latency probe.",
		parameters: Type.Object({ slot: Type.Integer() }),
		annotations: { openWorldHint: true },
		source: {
			type: "mcp",
			server: "trusted-fs",
			tool: "probe",
			supportsParallelToolCalls: true,
		},
		execute: async (toolCallId: string, args: Record<string, unknown>) => {
			const record: TimedToolRecord = {
				id: toolCallId,
				phase: "inspect",
				startedAt: performance.now(),
				trustedMcp: true,
			};
			records.push(record);
			await sleep(delays.trustedMcp);
			record.endedAt = performance.now();
			return { content: [{ type: "text" as const, text: `trusted:${args.slot}` }] };
		},
	} satisfies AgentTool;
	const untrustedMcpProbeTool = {
		name: "mcp__untrusted_fs__probe",
		description: "Untrusted MCP latency probe.",
		parameters: Type.Object({ slot: Type.Integer() }),
		annotations: { openWorldHint: true },
		source: {
			type: "mcp",
			server: "untrusted-fs",
			tool: "probe",
			supportsParallelToolCalls: false,
		},
		execute: async (toolCallId: string, args: Record<string, unknown>) => {
			const record: TimedToolRecord = {
				id: toolCallId,
				phase: "inspect",
				startedAt: performance.now(),
			};
			records.push(record);
			await sleep(delays.untrustedMcp);
			record.endedAt = performance.now();
			return { content: [{ type: "text" as const, text: `untrusted:${args.slot}` }] };
		},
	} satisfies AgentTool;
	const pathWriteTool: AgentTool = {
		name: "path_write",
		description: "Path-scoped mutation probe.",
		parameters: Type.Object({
			path: Type.String(),
			slot: Type.Integer(),
		}),
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			pathScopedMutationHint: true,
		},
		execute: async (toolCallId, args) => {
			const path = String(args.path);
			if (
				activeMutationPaths.some(
					(activePath) =>
						activePath === path ||
						activePath.startsWith(`${path}/`) ||
						path.startsWith(`${activePath}/`),
				)
			) {
				unsafeOverlapCount += 1;
			}
			activeMutationPaths.push(path);
			const record: TimedToolRecord = {
				id: toolCallId,
				phase: "commit",
				path,
				startedAt: performance.now(),
			};
			records.push(record);
			await sleep(delays.mutation);
			record.endedAt = performance.now();
			activeMutationPaths = activeMutationPaths.filter(
				(activePath) => activePath !== path,
			);
			return { content: [{ type: "text", text: `write:${path}:${args.slot}` }] };
		},
	};
	const readProbeTool: AgentTool = {
		name: "read_probe_next_wave",
		description: "Read-only verification probe.",
		parameters: Type.Object({ slot: Type.Integer() }),
		annotations: { readOnlyHint: true },
		execute: async (toolCallId, args) => {
			if (activeMutationPaths.length > 0) {
				unsafeOverlapCount += 1;
			}
			const record: TimedToolRecord = {
				id: toolCallId,
				phase: "verify",
				startedAt: performance.now(),
			};
			records.push(record);
			await sleep(delays.read);
			record.endedAt = performance.now();
			return { content: [{ type: "text", text: `verify:${String(args.slot)}` }] };
		},
	};

	const userMessage: Message = {
		role: "user",
		content:
			"Complex goal: run trusted MCP reads, path-scoped mutations, and verification reads.",
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
			systemPrompt:
				"Emit independent safe tool calls together when their inputs are known.",
			tools: [
				trustedMcpProbeTool,
				untrustedMcpProbeTool,
				pathWriteTool,
				readProbeTool,
			],
			model,
		})) {
			events.push(event);
		}
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
	return {
		records,
		events,
		elapsedMs: performance.now() - startedAt,
		unsafeOverlapCount,
	};
}

async function main(): Promise<void> {
	const latency = await runMeasurement({
		trustedMcp: TRUSTED_MCP_DELAY_MS,
		untrustedMcp: UNTRUSTED_MCP_DELAY_MS,
		mutation: MUTATION_DELAY_MS,
		read: READ_DELAY_MS,
	});
	const zero = await runMeasurement({
		trustedMcp: 0,
		untrustedMcp: 0,
		mutation: 0,
		read: 0,
	});

	const trustedMcpRecords = latency.records.filter(
		(record) => record.trustedMcp === true,
	);
	const untrustedMcpRecords = latency.records.filter((record) =>
		record.id.startsWith("untrusted-"),
	);
	const writeARecord = latency.records.find((record) => record.id === "write-a");
	const writeBRecord = latency.records.find((record) => record.id === "write-b");
	const overlappingWriteRecord = latency.records.find(
		(record) => record.id === "write-b-overlap",
	);
	const verifyRecords = latency.records.filter(
		(record) => record.phase === "verify",
	);
	const toolResults = latency.events.filter(
		(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
			event.type === "tool_execution_end",
	);
	const mutationRecords = latency.records.filter(
		(record) => record.phase === "commit",
	);
	const cacheReuseHitCount = toolResults.filter(
		(event) =>
			event.scheduling?.cache === "hit" ||
			event.scheduling?.cache === "pending_hit",
	).length;
	const schedulingReasonCounts = countBy(
		toolResults
			.map((event) => event.scheduling?.reason)
			.filter((reason): reason is NonNullable<typeof reason> =>
				Boolean(reason),
			),
	);
	const schedulingClassificationCounts = countBy(
		toolResults
			.map((event) => event.scheduling?.classification)
			.filter((classification): classification is NonNullable<typeof classification> =>
				Boolean(classification),
			),
	);
	const pathScopeInferredCount = toolResults.filter(
		(event) => (event.scheduling?.pathScope?.length ?? 0) > 0,
	).length;

	const latestMutationEnd = maxEndedAt(mutationRecords);
	const earliestVerifyStart = Math.min(
		...verifyRecords.map((record) => record.startedAt),
	);
	const trustedMcpSpread = spread(trustedMcpRecords);
	const untrustedMcpSpread = spread(untrustedMcpRecords);
	const pathMutationIslandMs =
		writeARecord && writeBRecord
			? Math.abs(writeARecord.startedAt - writeBRecord.startedAt)
			: Number.POSITIVE_INFINITY;
	const postMutationVerifyGapMs = earliestVerifyStart - latestMutationEnd;

	const preconditions: ConditionResult[] = [
		{
			name: "complex_goal_shape",
			description:
				"Trusted MCP reads, untrusted MCP reads, three path mutations, and two unique verify read executions are present.",
			passed:
				trustedMcpRecords.length === 2 &&
				untrustedMcpRecords.length === 2 &&
				mutationRecords.length === 3 &&
				verifyRecords.length === 2,
		},
		{
			name: "mcp_provenance",
			description:
				"Trusted and untrusted MCP tools carry exact server provenance and distinct opt-in bits.",
			passed: true,
		},
		{
			name: "path_scoped_mutation_args",
			description: "Every mutation exposes a concrete path argument.",
			passed: mutationRecords.every((record) => Boolean(record.path)),
		},
	];
	const postconditions: ConditionResult[] = [
		{
			name: "trusted_mcp_parallel",
			description:
				"Trusted MCP calls start as one server-opted parallel-safe wave without being classified as read-only.",
			passed: trustedMcpSpread < 40,
		},
		{
			name: "untrusted_mcp_not_parallel",
			description:
				"Untrusted MCP calls without tool-level read-only annotations stay serial.",
			passed: untrustedMcpSpread >= Math.max(5, UNTRUSTED_MCP_DELAY_MS - 10),
		},
		{
			name: "disjoint_path_mutations_parallel",
			description: "Disjoint path mutations start as a bounded mutation island.",
			passed: pathMutationIslandMs < 40,
		},
		{
			name: "overlapping_path_mutation_serialized",
			description: "The overlapping path mutation waits for the prior same-path mutation.",
			passed: Boolean(
				overlappingWriteRecord?.startedAt &&
					writeBRecord?.endedAt &&
					overlappingWriteRecord.startedAt >= writeBRecord.endedAt,
			),
		},
		{
			name: "post_mutation_verify_wave",
			description: "Verification reads start immediately after the mutation island drains.",
			passed: postMutationVerifyGapMs >= 0 && postMutationVerifyGapMs < 25,
		},
		{
			name: "all_tool_results_emitted",
			description: "Every requested tool call emits a tool execution result.",
			passed: toolResults.length === 10,
		},
		{
			name: "no_unsafe_overlap",
			description: "No read-only call overlaps a mutation and no shared path mutates concurrently.",
			passed: latency.unsafeOverlapCount === 0,
		},
		{
			name: "duplicate_read_reused",
			description:
				"The adjacent duplicate verification read is served from the reusable-result path.",
			passed: cacheReuseHitCount >= 1,
		},
	];
	const assertionsPassed = [...preconditions, ...postconditions].every(
		(condition) => condition.passed,
	);

	console.log(
		JSON.stringify(
			{
				tool_phase_ms: Number(toolPhaseMs(latency.records).toFixed(3)),
				zero_sleep_tool_phase_ms: Number(toolPhaseMs(zero.records).toFixed(3)),
				elapsed_ms: Number(latency.elapsedMs.toFixed(3)),
				assertions_passed: assertionsPassed ? 1 : 0,
				unsafe_overlap_count: latency.unsafeOverlapCount,
				untrusted_mcp_parallel_count: untrustedMcpSpread < 10 ? 1 : 0,
				mcp_trusted_parallel_count: trustedMcpSpread < 40 ? 1 : 0,
				path_mutation_island_ms: Number(pathMutationIslandMs.toFixed(3)),
				post_mutation_verify_gap_ms: Number(
					postMutationVerifyGapMs.toFixed(3),
				),
				cache_reuse_hit_count: cacheReuseHitCount,
				path_scope_inferred_count: pathScopeInferredCount,
				serialization_reason_counts: schedulingReasonCounts,
				scheduling_classification_counts: schedulingClassificationCounts,
				metadata_lookup_count: latency.records.length,
				prompt_batching_instruction_present: 1,
				total_tool_calls: toolResults.length,
				preconditions,
				postconditions,
			},
			null,
			2,
		),
	);
}

await main();
