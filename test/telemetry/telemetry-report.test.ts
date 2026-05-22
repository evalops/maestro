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
});
