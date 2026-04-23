import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import type {
	AgentEvent,
	AgentRunConfig,
	AgentTransport,
	AssistantMessage,
	Message,
	Model,
	ToolResultMessage,
} from "../../src/agent/types.js";
import {
	closeMaestroEventBusTransport,
	setMaestroEventBusTransportForTests,
} from "../../src/telemetry/maestro-event-bus.js";

const mockModel: Model<"openai-completions"> = {
	id: "mock",
	name: "Mock",
	provider: "mock",
	api: "openai-completions",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 8192,
	maxTokens: 2048,
};

function createAssistantToolCallMessage(toolCallId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: toolCallId,
				name: "Skill",
				arguments: { skill: "incident-review" },
			},
		],
		api: "openai-completions",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createAssistantTextMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createSkillToolResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "Skill",
		content: [{ type: "text", text: "# Skill: incident-review" }],
		isError: false,
		timestamp: Date.now(),
	};
}

class SkillSelectionTransport implements AgentTransport {
	constructor(private readonly shouldFailAfterSelection = false) {}

	async *continue(): AsyncGenerator<AgentEvent, void, unknown> {}

	async *run(
		_messages: Message[],
		userMessage: Message,
		_config: AgentRunConfig,
	): AsyncGenerator<AgentEvent, void, unknown> {
		yield { type: "message_start", message: userMessage };
		yield { type: "message_end", message: userMessage };

		const toolCallId = "tool-skill-1";
		const toolCallMessage = createAssistantToolCallMessage(toolCallId);
		yield { type: "message_start", message: toolCallMessage };
		yield { type: "message_end", message: toolCallMessage };
		yield {
			type: "tool_execution_start",
			toolCallId,
			toolName: "Skill",
			args: { skill: "incident-review" },
		};

		const toolResult = createSkillToolResult(toolCallId);
		yield { type: "message_start", message: toolResult };
		yield { type: "message_end", message: toolResult };
		yield {
			type: "tool_execution_end",
			toolCallId,
			toolName: "Skill",
			toolExecutionId: "exec_skill_1",
			skillMetadata: {
				name: "incident-review",
				artifactId: "skill_remote_1",
				version: "3",
				hash: "hash_skill_123",
				source: "service",
			},
			result: toolResult,
			isError: false,
		};

		if (this.shouldFailAfterSelection) {
			throw new Error("turn blew up");
		}

		const finalMessage = createAssistantTextMessage("Done");
		yield { type: "message_start", message: finalMessage };
		yield { type: "message_end", message: finalMessage };
	}
}

describe("skill outcome telemetry", () => {
	const originalEventBusUrl = process.env.MAESTRO_EVENT_BUS_URL;

	afterEach(async () => {
		if (originalEventBusUrl === undefined) {
			delete process.env.MAESTRO_EVENT_BUS_URL;
		} else {
			process.env.MAESTRO_EVENT_BUS_URL = originalEventBusUrl;
		}
		setMaestroEventBusTransportForTests(undefined);
		await closeMaestroEventBusTransport();
	});

	it("publishes invoked and succeeded skill events for selected skills", async () => {
		const published: Array<{ subject: string; payload: string }> = [];
		process.env.MAESTRO_EVENT_BUS_URL = "nats://bus.example:4222";
		setMaestroEventBusTransportForTests({
			async publish(subject, payload) {
				published.push({ subject, payload });
			},
		});

		const agent = new Agent({
			transport: new SkillSelectionTransport(),
			initialState: {
				model: mockModel,
				tools: [],
				session: {
					id: "session_123",
					startedAt: new Date("2026-04-23T18:00:00.000Z"),
				},
				promptMetadata: {
					name: "maestro-system",
					label: "production",
					surface: "maestro",
					version: 9,
					versionId: "ver_9",
					hash: "hash_prompt_123",
					source: "service",
				},
			},
		});

		await agent.prompt("load the incident review skill");

		const payloads = published.map(({ payload }) => JSON.parse(payload));
		expect(payloads.map((payload) => payload.type)).toEqual([
			"maestro.events.tool_call.attempted",
			"maestro.events.tool_call.completed",
			"maestro.events.skill.invoked",
			"maestro.events.skill.succeeded",
		]);
		expect(payloads[2]).toMatchObject({
			type: "maestro.events.skill.invoked",
			data: {
				tool_call_id: "tool-skill-1",
				skill_metadata: {
					name: "incident-review",
					artifactId: "skill_remote_1",
					version: "3",
					source: "service",
				},
				prompt_metadata: {
					name: "maestro-system",
					versionId: "ver_9",
				},
			},
		});
		expect(payloads[3]).toMatchObject({
			type: "maestro.events.skill.succeeded",
			data: {
				tool_call_id: "tool-skill-1",
				turn_status: "success",
				skill_metadata: {
					name: "incident-review",
					artifactId: "skill_remote_1",
				},
			},
		});
	});

	it("publishes failed skill outcomes when the turn errors after selection", async () => {
		const published: Array<{ subject: string; payload: string }> = [];
		process.env.MAESTRO_EVENT_BUS_URL = "nats://bus.example:4222";
		setMaestroEventBusTransportForTests({
			async publish(subject, payload) {
				published.push({ subject, payload });
			},
		});

		const agent = new Agent({
			transport: new SkillSelectionTransport(true),
			initialState: {
				model: mockModel,
				tools: [],
				session: {
					id: "session_123",
					startedAt: new Date("2026-04-23T18:00:00.000Z"),
				},
			},
		});

		await expect(
			agent.prompt("load the incident review skill"),
		).rejects.toThrow("turn blew up");

		const payloads = published.map(({ payload }) => JSON.parse(payload));
		expect(payloads.map((payload) => payload.type)).toContain(
			"maestro.events.skill.failed",
		);
		expect(
			payloads.find(
				(payload) => payload.type === "maestro.events.skill.failed",
			),
		).toMatchObject({
			data: {
				tool_call_id: "tool-skill-1",
				turn_status: "error",
				error_category: "runtime",
				error_message: "turn blew up",
				skill_metadata: {
					name: "incident-review",
					artifactId: "skill_remote_1",
				},
			},
		});
	});
});
