import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("telemetry-report", () => {
	it("resolves relative telemetry env paths from the process cwd", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-telemetry-report-"));
		await writeFile(
			join(dir, "relative-env.log"),
			JSON.stringify({ type: "tool_phase_summary" }),
		);

		const { stdout } = await execFileAsync(
			process.execPath,
			[join(repoRoot, "scripts/telemetry-report.js"), "--json"],
			{
				cwd: dir,
				env: {
					...process.env,
					MAESTRO_TELEMETRY_FILE: "relative-env.log",
				},
			},
		);
		const report = JSON.parse(stdout);

		expect(report).toMatchObject({
			logPath: "relative-env.log",
			sourceCount: 1,
			lineCount: 1,
			parsedEventCount: 1,
		});
	});

	it("prefers canonical tool scheduling over raw phase summaries", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-telemetry-report-"));
		const logPath = join(dir, "telemetry.log");
		await writeFile(
			logPath,
			[
				JSON.stringify({
					type: "canonical-turn",
					turnId: "turn-1",
					toolScheduling: {
						modelToolCallCount: 3,
						schedulableWaveCount: 2,
						parallelizedCallCount: 2,
						serializedCallCount: 1,
						delayedCallCount: 1,
						blockedByMutationCount: 1,
						mcpOptInCallCount: 0,
						cacheHitCount: 0,
						totalToolWaitMs: 7,
						serializationReasons: {
							blocked_by_mutation: 1,
						},
					},
					tools: [
						{
							name: "write",
							callId: "call-1",
							durationMs: 9,
							success: true,
							scheduling: {
								callId: "call-1",
								toolName: "write",
								emittedIndex: 0,
								decision: "delayed",
								reason: "blocked_by_mutation",
								schedulerWaitMs: 7,
								blockedByMutation: true,
							},
						},
					],
				}),
				JSON.stringify({
					type: "tool_phase_summary",
					turnId: "turn-1",
					modelToolCallCount: 1,
					schedulableWaveCount: 1,
					parallelizedCallCount: 0,
					serializedCallCount: 1,
					delayedCallCount: 0,
					blockedByMutationCount: 0,
					mcpOptInCallCount: 0,
					cacheHitCount: 0,
					totalToolWaitMs: 0,
					decisions: [
						{
							toolCallId: "call-1",
							toolName: "read",
							outcome: "serialized",
							reason: "single_read_only_call",
							waveIndex: 0,
							waitMs: 0,
						},
						{
							toolCallId: "call-2",
							toolName: "read",
							outcome: "skipped",
							reason: "steering_interrupted",
							waitMs: 0,
						},
					],
				}),
			].join("\n"),
		);

		const { stdout } = await execFileAsync(
			process.execPath,
			["scripts/telemetry-report.js", logPath, "--json"],
			{ cwd: repoRoot },
		);
		const report = JSON.parse(stdout);

		expect(report.toolScheduling).toMatchObject({
			modelToolCallCount: 3,
			schedulableWaveCount: 2,
			parallelizedCallCount: 2,
			serializedCallCount: 1,
			delayedCallCount: 1,
			blockedByMutationCount: 1,
			cacheHitCount: 0,
		});
		expect(report.toolScheduling.topSerializationReasons).toEqual([
			{ reason: "blocked_by_mutation", count: 1 },
		]);
		expect(report.toolScheduling.operatorSummary).toMatchObject({
			line: "3 calls, 2 waves, 2 parallelized, 2 serialized/delayed, 0 cache hits; top blocker blocked_by_mutation (1); next adjacent_turn_read_cache",
			serializedOrDelayedCallCount: 2,
			topSerializationReason: {
				count: 1,
				reason: "blocked_by_mutation",
			},
			topNextActionId: "adjacent_turn_read_cache",
		});
		expect(report.toolScheduling.serializationReasonTiming).toEqual([
			{
				reason: "blocked_by_mutation",
				count: 1,
				totalWaitMs: 7,
				averageWaitMs: 7,
			},
		]);
		expect(report.toolScheduling.dedupedRawToolPhaseSummaryCount).toBe(1);
		expect(JSON.stringify(report)).not.toContain("src/private.ts");
	});

	it("keeps unscoped raw phase summaries alongside canonical scheduling rollups", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-telemetry-report-"));
		const logPath = join(dir, "telemetry.log");
		await writeFile(
			logPath,
			[
				JSON.stringify({
					type: "canonical-turn",
					turnId: "turn-1",
					toolScheduling: {
						modelToolCallCount: 3,
						schedulableWaveCount: 2,
						parallelizedCallCount: 2,
						serializedCallCount: 1,
						delayedCallCount: 1,
						blockedByMutationCount: 1,
						mcpOptInCallCount: 0,
						cacheHitCount: 0,
						totalToolWaitMs: 7,
						serializationReasons: {
							blocked_by_mutation: 1,
						},
					},
				}),
				JSON.stringify({
					type: "tool_phase_summary",
					modelToolCallCount: 1,
					schedulableWaveCount: 1,
					parallelizedCallCount: 0,
					serializedCallCount: 1,
					delayedCallCount: 0,
					blockedByMutationCount: 0,
					mcpOptInCallCount: 0,
					cacheHitCount: 0,
					totalToolWaitMs: 0,
					serializationReasons: {
						single_read_only_call: 1,
					},
				}),
			].join("\n"),
		);

		const { stdout } = await execFileAsync(
			process.execPath,
			["scripts/telemetry-report.js", logPath, "--json"],
			{ cwd: repoRoot },
		);
		const report = JSON.parse(stdout);

		expect(report.toolScheduling).toMatchObject({
			modelToolCallCount: 4,
			schedulableWaveCount: 3,
			parallelizedCallCount: 2,
			serializedCallCount: 2,
			delayedCallCount: 1,
			blockedByMutationCount: 1,
			cacheHitCount: 0,
		});
		expect(report.toolScheduling.topSerializationReasons).toEqual([
			{ reason: "blocked_by_mutation", count: 1 },
			{ reason: "single_read_only_call", count: 1 },
		]);
	});

	it("emits JSON serialization reason rollups from raw tool phase telemetry", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-telemetry-report-"));
		const logPath = join(dir, "telemetry.log");
		await writeFile(
			logPath,
			[
				JSON.stringify({
					type: "tool_phase_summary",
					modelToolCallCount: 1,
					schedulableWaveCount: 1,
					parallelizedCallCount: 0,
					serializedCallCount: 1,
					delayedCallCount: 0,
					blockedByMutationCount: 0,
					mcpOptInCallCount: 0,
					cacheHitCount: 0,
					totalToolWaitMs: 0,
					decisions: [
						{
							toolCallId: "call-1",
							toolName: "read",
							outcome: "serialized",
							reason: "single_read_only_call",
							waveIndex: 0,
							waitMs: 0,
						},
					],
				}),
			].join("\n"),
		);

		const { stdout } = await execFileAsync(
			process.execPath,
			["scripts/telemetry-report.js", logPath, "--json"],
			{ cwd: repoRoot },
		);
		const report = JSON.parse(stdout);

		expect(report.toolScheduling).toMatchObject({
			modelToolCallCount: 1,
			schedulableWaveCount: 1,
			parallelizedCallCount: 0,
			serializedCallCount: 1,
			delayedCallCount: 0,
			blockedByMutationCount: 0,
			cacheHitCount: 0,
		});
		expect(report.toolScheduling.topSerializationReasons).toEqual([
			{ reason: "single_read_only_call", count: 1 },
		]);
	});

	it("prints a compact operator scheduling summary in text output", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-telemetry-report-"));
		const logPath = join(dir, "telemetry.log");
		await writeFile(
			logPath,
			JSON.stringify({
				type: "tool_phase_summary",
				modelToolCallCount: 2,
				schedulableWaveCount: 1,
				parallelizedCallCount: 2,
				serializedCallCount: 0,
				delayedCallCount: 0,
				blockedByMutationCount: 0,
				mcpOptInCallCount: 0,
				cacheHitCount: 1,
				totalToolWaitMs: 0,
			}),
		);

		const { stdout } = await execFileAsync(
			process.execPath,
			["scripts/telemetry-report.js", logPath],
			{ cwd: repoRoot },
		);

		expect(stdout).toContain(
			"Tool scheduling summary: 2 calls, 1 wave, 2 parallelized, 0 serialized/delayed, 1 cache hit; next none",
		);
	});

	it("keeps raw phase summaries when canonical turns do not include scheduling rollups", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-telemetry-report-"));
		const logPath = join(dir, "telemetry.log");
		await writeFile(
			logPath,
			[
				JSON.stringify({
					type: "canonical-turn",
					turnId: "turn-1",
				}),
				JSON.stringify({
					type: "tool_phase_summary",
					turnId: "turn-1",
					modelToolCallCount: 1,
					schedulableWaveCount: 1,
					parallelizedCallCount: 0,
					serializedCallCount: 1,
					delayedCallCount: 0,
					blockedByMutationCount: 0,
					mcpOptInCallCount: 0,
					cacheHitCount: 0,
					totalToolWaitMs: 0,
					serializationReasons: {
						single_read_only_call: 1,
					},
				}),
			].join("\n"),
		);

		const { stdout } = await execFileAsync(
			process.execPath,
			["scripts/telemetry-report.js", logPath, "--json"],
			{ cwd: repoRoot },
		);
		const report = JSON.parse(stdout);

		expect(report.toolScheduling).toMatchObject({
			modelToolCallCount: 1,
			schedulableWaveCount: 1,
			parallelizedCallCount: 0,
			serializedCallCount: 1,
			delayedCallCount: 0,
			blockedByMutationCount: 0,
			cacheHitCount: 0,
		});
		expect(report.toolScheduling.topSerializationReasons).toEqual([
			{ reason: "single_read_only_call", count: 1 },
		]);
	});

	it("keeps raw phase summaries for turns without canonical scheduling rollups", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-telemetry-report-"));
		const logPath = join(dir, "telemetry.log");
		await writeFile(
			logPath,
			[
				JSON.stringify({
					type: "canonical-turn",
					turnId: "turn-1",
				}),
				JSON.stringify({
					type: "canonical-turn",
					turnId: "turn-2",
					toolScheduling: {
						modelToolCallCount: 2,
						schedulableWaveCount: 1,
						parallelizedCallCount: 2,
						serializedCallCount: 0,
						delayedCallCount: 0,
						blockedByMutationCount: 0,
						mcpOptInCallCount: 0,
						cacheHitCount: 0,
						totalToolWaitMs: 0,
					},
				}),
				JSON.stringify({
					type: "tool_phase_summary",
					turnId: "turn-1",
					modelToolCallCount: 1,
					schedulableWaveCount: 1,
					parallelizedCallCount: 0,
					serializedCallCount: 1,
					delayedCallCount: 0,
					blockedByMutationCount: 0,
					mcpOptInCallCount: 0,
					cacheHitCount: 0,
					totalToolWaitMs: 0,
					serializationReasons: {
						single_read_only_call: 1,
					},
				}),
				JSON.stringify({
					type: "tool_phase_summary",
					turnId: "turn-2",
					modelToolCallCount: 2,
					schedulableWaveCount: 1,
					parallelizedCallCount: 2,
					serializedCallCount: 0,
					delayedCallCount: 0,
					blockedByMutationCount: 0,
					mcpOptInCallCount: 0,
					cacheHitCount: 0,
					totalToolWaitMs: 0,
				}),
			].join("\n"),
		);

		const { stdout } = await execFileAsync(
			process.execPath,
			["scripts/telemetry-report.js", logPath, "--json"],
			{ cwd: repoRoot },
		);
		const report = JSON.parse(stdout);

		expect(report.toolScheduling).toMatchObject({
			modelToolCallCount: 3,
			schedulableWaveCount: 2,
			parallelizedCallCount: 2,
			serializedCallCount: 1,
			delayedCallCount: 0,
			blockedByMutationCount: 0,
			cacheHitCount: 0,
		});
		expect(report.toolScheduling.topSerializationReasons).toEqual([
			{ reason: "single_read_only_call", count: 1 },
		]);
	});

	it("reports no-scheduling telemetry as a collection gap", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-telemetry-report-"));
		const logPath = join(dir, "telemetry.log");
		await writeFile(
			logPath,
			[
				JSON.stringify({
					type: "canonical-turn",
					turnId: "turn-1",
					tools: [],
				}),
				JSON.stringify({
					type: "tool-execution",
					success: true,
					durationMs: 25,
				}),
			].join("\n"),
		);

		const { stdout } = await execFileAsync(
			process.execPath,
			["scripts/telemetry-report.js", logPath, "--json"],
			{ cwd: repoRoot },
		);
		const report = JSON.parse(stdout);

		expect(report.toolScheduling).toMatchObject({
			hasSchedulingData: false,
			schedulingCoverageRatio: 0,
		});
		expect(report.toolScheduling.nextActions).toEqual([
			{
				id: "collect_real_tool_phase_telemetry",
				reason:
					"No canonical toolScheduling or raw tool_phase_summary events were found.",
			},
		]);
	});

	it("aggregates telemetry directories without leaking tool args", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-telemetry-report-"));
		await writeFile(
			join(dir, "a.log"),
			[
				JSON.stringify({
					type: "tool_phase_summary",
					modelToolCallCount: 1,
					modelEmittedToolCallCount: 1,
					schedulableWaveCount: 1,
					parallelizedCallCount: 0,
					actuallyParallelizedCallCount: 0,
					serializedCallCount: 1,
					delayedCallCount: 0,
					blockedByMutationCount: 0,
					mcpOptInCallCount: 0,
					mcpOptInUseCount: 0,
					cacheHitCount: 0,
					totalToolWaitMs: 0,
					toolWaitTimeMs: 0,
					serializationReasons: {
						single_read_only_call: 1,
					},
					decisions: [
						{
							toolCallId: "call-1",
							toolName: "read",
							emittedIndex: 0,
							outcome: "serialized",
							decision: "serialized",
							reason: "single_read_only_call",
							waitMs: 0,
							schedulerWaitMs: 0,
							args: { file_path: "src/private.ts" },
						},
					],
				}),
			].join("\n"),
		);
		await writeFile(
			join(dir, "b.jsonl"),
			[
				JSON.stringify({
					type: "tool_phase_summary",
					modelToolCallCount: 2,
					modelEmittedToolCallCount: 2,
					schedulableWaveCount: 1,
					parallelizedCallCount: 2,
					actuallyParallelizedCallCount: 2,
					serializedCallCount: 0,
					delayedCallCount: 0,
					blockedByMutationCount: 0,
					mcpOptInCallCount: 0,
					mcpOptInUseCount: 0,
					cacheHitCount: 1,
					totalToolWaitMs: 0,
					toolWaitTimeMs: 0,
					serializationReasons: {},
					decisions: [],
				}),
			].join("\n"),
		);

		const { stdout } = await execFileAsync(
			process.execPath,
			["scripts/telemetry-report.js", dir, "--json"],
			{ cwd: repoRoot },
		);
		const report = JSON.parse(stdout);

		expect(report).toMatchObject({
			sourceCount: 2,
			lineCount: 2,
			parsedEventCount: 2,
		});
		expect(report.toolScheduling).toMatchObject({
			modelToolCallCount: 3,
			modelSingletonTurnCount: 1,
			modelMultiCallTurnCount: 1,
			avoidableSingletonCount: 1,
			cacheHitCount: 1,
		});
		expect(report.toolScheduling.nextActions[0]).toMatchObject({
			id: "batch_shaping_feedback",
		});
		expect(JSON.stringify(report)).not.toContain("file_path");
		expect(JSON.stringify(report)).not.toContain("src/private.ts");
	});
});
