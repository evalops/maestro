import { getEventListeners } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAESTRO_SCRIPTED_SCENARIO_SCHEMA } from "@evalops/contracts";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { ActionApprovalService } from "../../src/agent/action-approval.js";
import { Agent } from "../../src/agent/agent.js";
import { isRetryableError } from "../../src/agent/context-overflow.js";
import {
	loadScriptedScenario,
	loadScriptedScenarioFromSource,
	streamScriptedReplay,
} from "../../src/agent/providers/scripted.js";
import { ProviderTransport } from "../../src/agent/transport.js";
import type {
	AgentEvent,
	AgentTool,
	AssistantMessageEvent,
	Context,
	Model,
	StreamOptions,
} from "../../src/agent/types.js";
import { getModel } from "../../src/models/builtin.js";
import { evaluateScriptedScenario } from "../../src/server/scripted-scenario-runner.js";

const fixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"scripted-replay",
);
const originalScenarioPath = process.env.MAESTRO_SCENARIO_PATH;
let tempDir: string | undefined;

function writeScenarioFixture(scenario: unknown): string {
	const value =
		scenario && typeof scenario === "object" && !Array.isArray(scenario)
			? {
					metadata: {
						recordedAt: "2026-05-10T00:00:00.000Z",
						toolsExpected: [],
					},
					...scenario,
				}
			: scenario;
	tempDir = mkdtempSync(join(tmpdir(), "maestro-scripted-replay-"));
	const scenarioPath = join(tempDir, "scenario.json");
	writeFileSync(scenarioPath, JSON.stringify(value, null, 2));
	return scenarioPath;
}

function writeRawScenarioFixture(scenario: unknown): string {
	tempDir = mkdtempSync(join(tmpdir(), "maestro-scripted-replay-"));
	const scenarioPath = join(tempDir, "scenario.json");
	writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2));
	return scenarioPath;
}

async function collectEvents(
	model: Model<"scripted-replay">,
	context: Context,
	options: StreamOptions = {},
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of streamScriptedReplay(model, context, options)) {
		events.push(event);
	}
	return events;
}

describe("scripted replay provider", () => {
	afterEach(() => {
		if (originalScenarioPath === undefined) {
			delete process.env.MAESTRO_SCENARIO_PATH;
		} else {
			process.env.MAESTRO_SCENARIO_PATH = originalScenarioPath;
		}
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("streams deterministic text and tool calls with zero cost", async () => {
		process.env.MAESTRO_SCENARIO_PATH = join(
			fixturesDir,
			"basic-tool-call.json",
		);
		const model = getModel("scripted-replay", "maestro-replay-v1");

		expect(model).toMatchObject({
			api: "scripted-replay",
			provider: "scripted-replay",
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
		});

		const events = await collectEvents(model as Model<"scripted-replay">, {
			messages: [{ role: "user", content: "Replay the fixture", timestamp: 1 }],
		});

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			...Array.from("I will inspect the package manifest.").map(
				() => "text_delta",
			),
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(events.find((event) => event.type === "toolcall_end")).toMatchObject(
			{
				toolCall: {
					id: "call-read-package-json",
					name: "read",
					arguments: {
						file_path: "package.json",
					},
				},
			},
		);
		expect(events.at(-1)).toMatchObject({
			type: "done",
			reason: "toolUse",
			message: {
				api: "scripted-replay",
				provider: "scripted-replay",
				model: "maestro-replay-v1",
				stopReason: "toolUse",
				usage: {
					input: 0,
					output: 0,
					cost: {
						total: 0,
					},
				},
			},
		});
	});

	it("caches remote scripted scenarios after the first fetch", async () => {
		const fixture = readFileSync(
			join(fixturesDir, "basic-tool-call.json"),
			"utf8",
		);
		let fetches = 0;
		const source = `http://fixture.invalid/basic-tool-call-${Date.now()}.json`;
		const fetchStub = globalThis.fetch;
		globalThis.fetch = (async () => {
			fetches += 1;
			return new Response(fixture, {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

		try {
			const first = await loadScriptedScenarioFromSource(source);
			const second = await loadScriptedScenarioFromSource(source);

			expect(first.id).toBe("basic-tool-call");
			expect(second.id).toBe("basic-tool-call");
			expect(fetches).toBe(1);
		} finally {
			globalThis.fetch = fetchStub;
		}
	});

	it("redacts signed URL query strings from remote schema validation errors", async () => {
		const source =
			"https://fixture.invalid/scenario.json?X-Goog-Signature=secret";
		const fetchStub = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					schemaVersion: MAESTRO_SCRIPTED_SCENARIO_SCHEMA,
					id: "invalid-remote",
					description: "Invalid remote fixture",
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			)) as typeof fetch;

		try {
			let error: unknown;
			try {
				await loadScriptedScenarioFromSource(source);
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).toContain(
				"Replay scenario https://fixture.invalid/scenario.json must contain frames",
			);
			expect(String(error)).not.toContain("secret");
		} finally {
			globalThis.fetch = fetchStub;
		}
	});

	it("replays a ten-frame acceptance scenario with real tool side effects under budget", async () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-scripted-replay-e2e-"));
		tempDir = dir;
		const sideEffectPath = "tmp/replay-side-effect.txt";
		const originalWallTimeMs = 30_000;
		const scenarioPath = join(dir, "ten-frame-acceptance.json");
		const toolTurns = [
			["read", { file_path: "package.json" }],
			["bash", { command: "printf acceptance" }],
			["list", { path: "src" }],
			["grep", { pattern: "scenario", path: "src" }],
			["write", { file_path: sideEffectPath, content: "ok" }],
		] as const;
		writeFileSync(
			scenarioPath,
			`${JSON.stringify(
				{
					schemaVersion: MAESTRO_SCRIPTED_SCENARIO_SCHEMA,
					id: "ten-frame-acceptance",
					description:
						"Acceptance replay covering ten frames, five tool calls, one file write, and zero-cost execution.",
					metadata: {
						recordedFrom: "acceptance-test",
						recordedAt: "2026-05-10T00:00:00.000Z",
						modelOriginal: "anthropic/claude-sonnet-4-5-20250929",
						toolsExpected: ["read", "bash", "list", "grep", "write"],
						auditEvents: ["maestro.scenario.replay.ready"],
						originalWallTimeMs,
					},
					frames: Array.from({ length: 10 }, (_, index) => {
						const tool = toolTurns[index];
						return {
							index,
							statements: [
								{ kind: "text", text: `Turn ${index + 1}` },
								...(tool
									? [
											{
												kind: "tool_call",
												id: `acceptance-${tool[0]}-${index + 1}`,
												tool: tool[0],
												input: tool[1],
												expectedResult: "success",
											},
										]
									: [{ kind: "end", reason: "complete" }]),
							],
						};
					}),
					assertions: [
						{ id: "write-tool-called", kind: "tool_called", tool: "write" },
						{
							id: "side-effect-byte-identical",
							kind: "file_contents",
							path: sideEffectPath,
							equals: "ok",
						},
						{
							id: "audit-event-tagged",
							kind: "audit_event_emitted",
							eventType: "maestro.scenario.replay.ready",
						},
					],
				},
				null,
				2,
			)}\n`,
		);
		process.env.MAESTRO_SCENARIO_PATH = scenarioPath;
		const toolExecutions: string[] = [];
		const textTool = (
			name: string,
			text: string,
			parameters: AgentTool["parameters"] = Type.Object(
				{},
				{ additionalProperties: true },
			),
		): AgentTool => ({
			name,
			description: `Acceptance ${name} tool`,
			parameters,
			execute: async () => {
				toolExecutions.push(name);
				return { content: [{ type: "text", text }] };
			},
		});
		const tools: AgentTool[] = [
			textTool(
				"read",
				readFileSync("package.json", "utf8"),
				Type.Object({
					file_path: Type.String(),
				}),
			),
			textTool("bash", "acceptance", Type.Object({ command: Type.String() })),
			textTool(
				"list",
				"src\npackage.json",
				Type.Object({ path: Type.String() }),
			),
			textTool(
				"grep",
				"src/agent/providers/scripted.ts",
				Type.Object({ pattern: Type.String(), path: Type.String() }),
			),
			{
				name: "write",
				description: "Acceptance write tool",
				parameters: Type.Object({
					file_path: Type.String(),
					content: Type.String(),
				}),
				execute: async (_toolCallId, params) => {
					toolExecutions.push("write");
					const outputPath = join(dir, String(params.file_path));
					mkdirSync(dirname(outputPath), { recursive: true });
					writeFileSync(outputPath, String(params.content));
					return { content: [{ type: "text", text: "written" }] };
				},
			},
		];
		const events: AgentEvent[] = [];
		const agent = new Agent({
			transport: new ProviderTransport({
				approvalService: new ActionApprovalService("auto"),
				cwd: dir,
				platformToolExecutionBridge: false,
			}),
			initialState: {
				model: getModel("scripted-replay", "maestro-replay-v1"),
				tools,
				thinkingLevel: "off",
				systemPrompt: "",
			},
		});
		agent.subscribe((event) => events.push(event));

		const startedAt = Date.now();
		for (let promptIndex = 0; promptIndex < 10; promptIndex++) {
			const replayedFrames = agent.state.messages.filter(
				(message) =>
					message.role === "assistant" &&
					message.provider === "scripted-replay" &&
					message.content.some(
						(block) => block.type === "text" && block.text.startsWith("Turn "),
					),
			).length;
			if (replayedFrames >= 10) break;
			await agent.prompt(`Replay acceptance frame ${promptIndex + 1}`);
		}
		const elapsedMs = Date.now() - startedAt;
		const assistantMessages = agent.state.messages.filter(
			(message) =>
				message.role === "assistant" &&
				message.provider === "scripted-replay" &&
				message.content.some(
					(block) => block.type === "text" && block.text.startsWith("Turn "),
				),
		);
		const result = evaluateScriptedScenario(
			loadScriptedScenario(scenarioPath),
			{ baseDir: dir },
		);

		expect(assistantMessages).toHaveLength(10);
		expect(toolExecutions).toEqual(["read", "bash", "list", "grep", "write"]);
		expect(
			events.filter((event) => event.type === "tool_execution_end"),
		).toHaveLength(5);
		expect(readFileSync(join(dir, sideEffectPath), "utf8")).toBe("ok");
		expect(
			assistantMessages.reduce(
				(total, message) => total + message.usage.cost.total,
				0,
			),
		).toBe(0);
		expect(result.counts).toMatchObject({
			assertions: 3,
			failed: 0,
		});
		expect(elapsedMs).toBeLessThan(originalWallTimeMs * 0.2);
	});

	it("advances frames from prior scripted assistant messages", async () => {
		process.env.MAESTRO_SCENARIO_PATH = join(
			fixturesDir,
			"basic-tool-call.json",
		);
		const model = getModel(
			"scripted-replay",
			"maestro-replay-v1",
		) as Model<"scripted-replay">;

		const events = await collectEvents(model, {
			messages: [
				{ role: "user", content: "Replay the fixture", timestamp: 1 },
				{
					role: "assistant",
					content: [],
					api: "scripted-replay",
					provider: "scripted-replay",
					model: "maestro-replay-v1",
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
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-read-package-json",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 3,
				},
			],
		});

		expect(events.find((event) => event.type === "text_end")).toMatchObject({
			content: "The manifest has been inspected.",
		});
		expect(events.at(-1)).toMatchObject({
			type: "done",
			reason: "stop",
		});
	});

	it("does not advance when expected tool results are missing", async () => {
		process.env.MAESTRO_SCENARIO_PATH = join(
			fixturesDir,
			"basic-tool-call.json",
		);
		const model = getModel(
			"scripted-replay",
			"maestro-replay-v1",
		) as Model<"scripted-replay">;

		const events = await collectEvents(model, {
			messages: [
				{ role: "user", content: "Replay the fixture", timestamp: 1 },
				{
					role: "assistant",
					content: [],
					api: "scripted-replay",
					provider: "scripted-replay",
					model: "maestro-replay-v1",
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
					stopReason: "toolUse",
					timestamp: 2,
				},
			],
		});

		expect(events.at(-1)).toMatchObject({
			type: "error",
			reason: "error",
			error: {
				errorMessage: expect.stringContaining("no matching tool result"),
			},
		});
	});

	it("does not advance when expected tool results have the wrong status", async () => {
		process.env.MAESTRO_SCENARIO_PATH = join(
			fixturesDir,
			"basic-tool-call.json",
		);
		const model = getModel(
			"scripted-replay",
			"maestro-replay-v1",
		) as Model<"scripted-replay">;

		const events = await collectEvents(model, {
			messages: [
				{ role: "user", content: "Replay the fixture", timestamp: 1 },
				{
					role: "assistant",
					content: [],
					api: "scripted-replay",
					provider: "scripted-replay",
					model: "maestro-replay-v1",
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
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-read-package-json",
					toolName: "read",
					content: [{ type: "text", text: "denied" }],
					isError: true,
					timestamp: 3,
				},
			],
		});

		expect(events.at(-1)).toMatchObject({
			type: "error",
			reason: "error",
			error: {
				errorMessage: expect.stringContaining("observed error"),
			},
		});
	});

	it("matches the latest tool result when explicit ids are reused", async () => {
		process.env.MAESTRO_SCENARIO_PATH = join(
			fixturesDir,
			"basic-tool-call.json",
		);
		const model = getModel(
			"scripted-replay",
			"maestro-replay-v1",
		) as Model<"scripted-replay">;

		const events = await collectEvents(model, {
			messages: [
				{ role: "user", content: "Replay the fixture", timestamp: 1 },
				{
					role: "assistant",
					content: [],
					api: "scripted-replay",
					provider: "scripted-replay",
					model: "maestro-replay-v1",
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
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-read-package-json",
					toolName: "read",
					content: [{ type: "text", text: "older failure" }],
					isError: true,
					timestamp: 3,
				},
				{
					role: "toolResult",
					toolCallId: "call-read-package-json",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 4,
				},
			],
		});

		expect(events.find((event) => event.type === "text_end")).toMatchObject({
			content: "The manifest has been inspected.",
		});
		expect(events.at(-1)).toMatchObject({
			type: "done",
			reason: "stop",
		});
	});

	it("preserves explicit limit stop reasons when tool calls are replayed", async () => {
		process.env.MAESTRO_SCENARIO_PATH = writeScenarioFixture({
			schemaVersion: MAESTRO_SCRIPTED_SCENARIO_SCHEMA,
			id: "length-with-tool-call",
			description: "Replay a truncated tool-use response faithfully.",
			frames: [
				{
					index: 0,
					statements: [
						{ kind: "text", text: "Let me check that." },
						{
							kind: "tool_call",
							id: "toolu-read-1",
							tool: "read",
							input: { file_path: "package.json" },
						},
						{ kind: "end", reason: "limit_exceeded" },
					],
				},
			],
		});
		const model = getModel(
			"scripted-replay",
			"maestro-replay-v1",
		) as Model<"scripted-replay">;

		const events = await collectEvents(model, {
			messages: [{ role: "user", content: "Replay the fixture", timestamp: 1 }],
		});

		expect(events.at(-1)).toMatchObject({
			type: "done",
			reason: "length",
			message: {
				stopReason: "length",
			},
		});
	});

	it("rejects duplicate or skipped frame indexes", () => {
		const duplicatePath = writeScenarioFixture({
			schemaVersion: MAESTRO_SCRIPTED_SCENARIO_SCHEMA,
			id: "duplicate-frame-index",
			description: "Reject duplicate frame indexes.",
			frames: [
				{ index: 0, statements: [{ kind: "end", reason: "complete" }] },
				{ index: 0, statements: [{ kind: "end", reason: "complete" }] },
			],
		});

		expect(() => loadScriptedScenario(duplicatePath)).toThrow(
			/contiguous, unique, and start at 0/,
		);

		const skippedPath = writeScenarioFixture({
			schemaVersion: MAESTRO_SCRIPTED_SCENARIO_SCHEMA,
			id: "skipped-frame-index",
			description: "Reject skipped frame indexes.",
			frames: [
				{ index: 0, statements: [{ kind: "end", reason: "complete" }] },
				{ index: 2, statements: [{ kind: "end", reason: "complete" }] },
			],
		});

		expect(() => loadScriptedScenario(skippedPath)).toThrow(
			/contiguous, unique, and start at 0/,
		);
	});

	it("rejects missing scripted metadata during validation", () => {
		const missingMetadataPath = writeRawScenarioFixture({
			schemaVersion: MAESTRO_SCRIPTED_SCENARIO_SCHEMA,
			id: "missing-metadata",
			description: "Reject missing metadata.",
			frames: [],
		});

		expect(() => loadScriptedScenario(missingMetadataPath)).toThrow(
			/must contain metadata/,
		);
	});

	it("rejects invalid scripted error statement types", () => {
		const invalidErrorPath = writeScenarioFixture({
			schemaVersion: MAESTRO_SCRIPTED_SCENARIO_SCHEMA,
			id: "invalid-error-type",
			description: "Reject invalid error types.",
			frames: [
				{
					index: 0,
					statements: [{ kind: "error", type: "unexpected", message: "boom" }],
				},
			],
		});

		expect(() => loadScriptedScenario(invalidErrorPath)).toThrow(
			/error type must be transient or fatal/,
		);
	});

	it("keeps scripted transient errors retryable", async () => {
		process.env.MAESTRO_SCENARIO_PATH = writeScenarioFixture({
			schemaVersion: MAESTRO_SCRIPTED_SCENARIO_SCHEMA,
			id: "transient-error",
			description:
				"Surface transient replay failures as retryable provider errors.",
			frames: [
				{
					index: 0,
					statements: [
						{
							kind: "error",
							type: "transient",
							message: "Replay fixture temporarily unavailable.",
						},
					],
				},
			],
		});
		const model = getModel(
			"scripted-replay",
			"maestro-replay-v1",
		) as Model<"scripted-replay">;

		const events = await collectEvents(model, {
			messages: [{ role: "user", content: "Replay the fixture", timestamp: 1 }],
		});
		const errorEvent = events.find((event) => event.type === "error");

		expect(errorEvent).toMatchObject({
			type: "error",
			error: {
				stopReason: "error",
				errorMessage: "Replay fixture temporarily unavailable. Try again.",
			},
		});
		if (errorEvent?.type !== "error") {
			throw new Error("Expected scripted replay to emit an error event.");
		}
		expect(isRetryableError(errorEvent.error)).toBe(true);
	});

	it("rejects invalid scripted tool-call expectations", () => {
		const invalidExpectedResultPath = writeScenarioFixture({
			schemaVersion: MAESTRO_SCRIPTED_SCENARIO_SCHEMA,
			id: "invalid-tool-expectation",
			description: "Reject misspelled expectedResult values.",
			frames: [
				{
					index: 0,
					statements: [
						{
							kind: "tool_call",
							tool: "read",
							input: { file_path: "package.json" },
							expectedResult: "sucess",
						},
					],
				},
			],
		});

		expect(() => loadScriptedScenario(invalidExpectedResultPath)).toThrow(
			/expectedResult must be success, error, or any/,
		);

		const emptyToolNamePath = writeScenarioFixture({
			schemaVersion: MAESTRO_SCRIPTED_SCENARIO_SCHEMA,
			id: "empty-tool-name",
			description: "Reject empty tool names.",
			frames: [
				{
					index: 0,
					statements: [{ kind: "tool_call", tool: "", input: {} }],
				},
			],
		});

		expect(() => loadScriptedScenario(emptyToolNamePath)).toThrow(
			/tool_call tool must be a non-empty string/,
		);

		const numericToolIdPath = writeScenarioFixture({
			schemaVersion: MAESTRO_SCRIPTED_SCENARIO_SCHEMA,
			id: "numeric-tool-id",
			description: "Reject non-string tool call IDs.",
			frames: [
				{
					index: 0,
					statements: [
						{
							kind: "tool_call",
							id: 123,
							tool: "read",
							input: { file_path: "package.json" },
						},
					],
				},
			],
		});

		expect(() => loadScriptedScenario(numericToolIdPath)).toThrow(
			/tool_call id must be a string/,
		);
	});

	it("cleans up abort listeners after streamed text completes", async () => {
		process.env.MAESTRO_SCENARIO_PATH = writeScenarioFixture({
			schemaVersion: MAESTRO_SCRIPTED_SCENARIO_SCHEMA,
			id: "streamed-text",
			description: "Stream text with delays and finish cleanly.",
			frames: [
				{
					index: 0,
					statements: [
						{ kind: "text", text: "abcd", streamMs: 40 },
						{ kind: "end", reason: "complete" },
					],
				},
			],
		});
		const model = getModel(
			"scripted-replay",
			"maestro-replay-v1",
		) as Model<"scripted-replay">;
		const controller = new AbortController();

		await collectEvents(
			model,
			{
				messages: [
					{ role: "user", content: "Replay the fixture", timestamp: 1 },
				],
			},
			{ signal: controller.signal },
		);

		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
});
