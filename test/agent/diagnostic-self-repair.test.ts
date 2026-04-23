import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import type {
	AgentEvent,
	AgentRunConfig,
	AgentTransport,
	AppMessage,
	AssistantMessage,
	Message,
	Model,
	QueuedMessage,
	ToolResultMessage,
} from "../../src/agent/types.js";
import { buildDiagnosticDeltaToolSummary } from "../../src/lsp/diagnostic-repair.js";
import type { LspDiagnostic } from "../../src/lsp/types.js";

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

function diagnostic(message: string): LspDiagnostic {
	return {
		message,
		severity: 1,
		source: "typescript",
		range: {
			start: { line: 1, character: 4 },
			end: { line: 1, character: 12 },
		},
	};
}

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-completions",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

class DiagnosticDeltaTransport implements AgentTransport {
	followUpBatches: QueuedMessage<AppMessage>[][] = [];

	constructor(private readonly result: ToolResultMessage) {}

	async *run(
		_messages: Message[],
		_userMessage: Message,
		config: AgentRunConfig,
	): AsyncIterable<AgentEvent> {
		yield {
			type: "tool_execution_start",
			toolCallId: this.result.toolCallId,
			toolName: this.result.toolName,
			args: { path: "src/foo.ts" },
		};
		yield { type: "message_start", message: this.result };
		yield { type: "message_end", message: this.result };
		yield {
			type: "tool_execution_end",
			toolCallId: this.result.toolCallId,
			toolName: this.result.toolName,
			result: this.result,
			isError: false,
		};
		yield {
			type: "turn_end",
			message: assistantMessage(),
			toolResults: [this.result],
		};
		this.followUpBatches.push(
			(await config.getFollowUpMessages?.<AppMessage>()) ?? [],
		);
	}

	async *continue(): AsyncIterable<AgentEvent> {}
}

function toolResult(message = "new diagnostic"): ToolResultMessage {
	const introduced = diagnostic(message);
	return {
		role: "toolResult",
		toolCallId: "call_write",
		toolName: "write",
		content: [{ type: "text", text: "Successfully wrote file" }],
		details: {
			diagnosticDelta: buildDiagnosticDeltaToolSummary({
				file: "/repo/src/foo.ts",
				displayPath: "src/foo.ts",
				result: {
					allDiagnostics: { "/repo/src/foo.ts": [introduced] },
					fileDiagnostics: [introduced],
					newDiagnostics: [introduced],
					repairedDiagnostics: [],
					usedDelta: true,
					validatorDiagnostics: { "/repo/src/foo.ts": [introduced] },
				},
			}),
		},
		isError: false,
		timestamp: Date.now(),
	};
}

describe("diagnostic self-repair follow-ups", () => {
	it("queues a bounded follow-up when a tool introduces diagnostics", async () => {
		const events: AgentEvent[] = [];
		const transport = new DiagnosticDeltaTransport(toolResult());
		const agent = new Agent({
			transport,
			initialState: { model: mockModel, tools: [] },
		});
		agent.subscribe((event) => events.push(event));

		await agent.prompt("write the file");

		expect(
			events.find((event) => event.type === "diagnostic_delta"),
		).toMatchObject({
			willAutoFollowUp: true,
			introducedCount: 1,
			repairAttempt: 1,
		});
		expect(transport.followUpBatches[0]).toHaveLength(1);
		expect(
			JSON.stringify(transport.followUpBatches[0]?.[0]?.original.content),
		).toContain("Automatic diagnostic repair attempt 1/2");
	});

	it("does not queue a follow-up when the user opts out", async () => {
		const events: AgentEvent[] = [];
		const transport = new DiagnosticDeltaTransport(toolResult());
		const agent = new Agent({
			transport,
			initialState: { model: mockModel, tools: [] },
		});
		agent.subscribe((event) => events.push(event));

		await agent.prompt("write the file but do not continue");

		expect(
			events.find((event) => event.type === "diagnostic_delta"),
		).toMatchObject({
			willAutoFollowUp: false,
			reason: "User asked Maestro not to continue or repair automatically.",
		});
		expect(transport.followUpBatches[0]).toEqual([]);
	});

	it("stops queueing repair follow-ups after unchanged attempts", async () => {
		const transport = new DiagnosticDeltaTransport(
			toolResult("same diagnostic"),
		);
		const agent = new Agent({
			transport,
			initialState: { model: mockModel, tools: [] },
		});

		await agent.prompt("first edit");
		await agent.prompt("second edit");
		await agent.prompt("third edit");

		expect(transport.followUpBatches[0]).toHaveLength(1);
		expect(transport.followUpBatches[1]).toHaveLength(1);
		expect(transport.followUpBatches[2]).toEqual([]);
	});
});
