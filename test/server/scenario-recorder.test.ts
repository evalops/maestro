import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadScriptedScenario } from "../../src/agent/providers/scripted.js";
import type { AssistantMessage } from "../../src/agent/types.js";
import { ScriptedScenarioRecorder } from "../../src/server/scenario-recorder.js";

let tempDir: string | undefined;

function createTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "maestro-scenario-recorder-"));
	return tempDir;
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5-20250929",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason,
		timestamp: 1,
	};
}

describe("scripted scenario recorder", () => {
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("writes replayable scenario frames from assistant messages", () => {
		const outPath = join(createTempDir(), "recorded-replay.json");
		const recorder = new ScriptedScenarioRecorder({
			outPath,
			recordedAt: "2026-05-10T00:00:00.000Z",
			recordedFrom: () => "session-123",
		});

		recorder.recordAssistantMessage(
			assistantMessage(
				[
					{ type: "text", text: "I will inspect package.json." },
					{
						type: "toolCall",
						id: "toolu-read-1",
						name: "read",
						arguments: { file_path: "package.json" },
					},
				],
				"toolUse",
			),
		);
		recorder.recordAssistantMessage(
			assistantMessage([{ type: "text", text: "Done." }]),
		);

		const parsed = JSON.parse(readFileSync(outPath, "utf8"));
		expect(parsed).toMatchObject({
			schemaVersion: "evalops.maestro.scripted-scenario.v1",
			id: "recorded-replay",
			metadata: {
				recordedFrom: "session-123",
				recordedAt: "2026-05-10T00:00:00.000Z",
				modelOriginal: "anthropic/claude-sonnet-4-5-20250929",
				toolsExpected: ["read"],
			},
			frames: [
				{
					index: 0,
					statements: [
						{ kind: "text", text: "I will inspect package.json." },
						{
							kind: "tool_call",
							id: "toolu-read-1",
							tool: "read",
							input: { file_path: "package.json" },
							expectedResult: "any",
						},
					],
				},
				{
					index: 1,
					statements: [
						{ kind: "text", text: "Done." },
						{ kind: "end", reason: "complete" },
					],
				},
			],
		});
		expect(loadScriptedScenario(outPath).frames).toHaveLength(2);
	});

	it("records a stable acceptance-shape replay fixture", () => {
		const dir = createTempDir();
		const outPath = join(dir, "ten-turn-replay.json");
		const recorder = new ScriptedScenarioRecorder({
			outPath,
			recordedAt: "2026-05-10T00:00:00.000Z",
			recordedFrom: () => "session-acceptance",
		});

		const toolTurns = [
			["read", { file_path: "package.json" }],
			["bash", { command: "pwd" }],
			["list", { path: "src" }],
			["grep", { pattern: "scenario", path: "src" }],
			["write", { file_path: "tmp/replay-side-effect.txt", content: "ok" }],
		] as const;
		for (let index = 0; index < 10; index++) {
			const content: AssistantMessage["content"] = [
				{ type: "text", text: `Turn ${index + 1}` },
			];
			const tool = toolTurns[index];
			if (tool) {
				content.push({
					type: "toolCall",
					id: `toolu-${tool[0]}-${index + 1}`,
					name: tool[0],
					arguments: tool[1],
				});
			}
			recorder.recordAssistantMessage(
				assistantMessage(content, tool ? "toolUse" : "stop"),
			);
		}

		const firstWrite = readFileSync(outPath, "utf8");
		const parsed = JSON.parse(firstWrite);
		parsed.assertions = [
			{ id: "write-tool-called", kind: "tool_called", tool: "write" },
			{
				id: "write-side-effect-byte-identical",
				kind: "file_contents",
				path: "tmp/replay-side-effect.txt",
				equals: "ok",
			},
		];
		const withAssertions = `${JSON.stringify(parsed, null, 2)}\n`;
		writeFileSync(outPath, withAssertions);

		const scenario = loadScriptedScenario(outPath);
		expect(scenario.frames).toHaveLength(10);
		expect(scenario.metadata.toolsExpected).toEqual([
			"read",
			"bash",
			"list",
			"grep",
			"write",
		]);
		expect(
			scenario.frames.flatMap((frame) =>
				frame.statements.filter((statement) => statement.kind === "tool_call"),
			),
		).toHaveLength(5);
		expect(`${JSON.stringify(scenario, null, 2)}\n`).toBe(withAssertions);
	});

	it("records error stop reasons as replay errors", () => {
		const outPath = join(createTempDir(), "error-replay.json");
		const recorder = new ScriptedScenarioRecorder({
			outPath,
			recordedAt: "2026-05-10T00:00:00.000Z",
		});

		recorder.recordAssistantMessage({
			...assistantMessage([], "error"),
			errorMessage: "Provider failed after partial output",
		});

		const parsed = JSON.parse(readFileSync(outPath, "utf8"));
		expect(parsed.frames[0].statements).toEqual([
			{
				kind: "error",
				type: "fatal",
				message: "Provider failed after partial output",
			},
		]);
	});

	it("preserves explicit stop semantics for tool-call frames", () => {
		const outPath = join(createTempDir(), "stop-with-tool-replay.json");
		const recorder = new ScriptedScenarioRecorder({
			outPath,
			recordedAt: "2026-05-10T00:00:00.000Z",
		});

		recorder.recordAssistantMessage(
			assistantMessage(
				[
					{ type: "text", text: "Here is the call, but I am done." },
					{
						type: "toolCall",
						id: "toolu-read-stop",
						name: "read",
						arguments: { file_path: "package.json" },
					},
				],
				"stop",
			),
		);

		const parsed = JSON.parse(readFileSync(outPath, "utf8"));
		expect(parsed.frames[0].statements.at(-1)).toEqual({
			kind: "end",
			reason: "complete",
		});
	});
});
