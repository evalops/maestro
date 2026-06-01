import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AgentRunConfig,
	AgentTool,
	AssistantMessage,
	AssistantMessageEvent,
	Message,
	Model,
} from "../../src/agent/types.js";

const childProcessMock = vi.hoisted(() => ({
	execFileSync: vi.fn(() => Buffer.from("")),
}));

const providerStreamMock = vi.hoisted(() => ({
	createProviderStream: vi.fn(async function* () {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "scripted-replay",
			provider: "scripted-replay",
			model: "maestro-replay-v1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		yield { type: "start", partial: message } satisfies AssistantMessageEvent;
		yield {
			type: "text_delta",
			contentIndex: 0,
			delta: "done",
			partial: message,
		} satisfies AssistantMessageEvent;
		yield {
			type: "done",
			reason: "stop",
			message,
		} satisfies AssistantMessageEvent;
	}),
}));

vi.mock("node:child_process", () => childProcessMock);
vi.mock(
	"../../src/agent/transport/create-provider-stream.js",
	() => providerStreamMock,
);

const { ProviderTransport } = await import("../../src/agent/transport.js");

const model: Model<"scripted-replay"> = {
	id: "maestro-replay-v1",
	name: "Maestro Replay",
	api: "scripted-replay",
	provider: "scripted-replay",
	baseUrl: "http://localhost/scripted-replay",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1024,
	maxTokens: 256,
};

const userMessage: Message = {
	role: "user",
	content: "hello",
	timestamp: 1,
};

function textStream(text = "done"): AsyncGenerator<AssistantMessageEvent> {
	return (async function* () {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "scripted-replay",
			provider: "scripted-replay",
			model: "maestro-replay-v1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		yield { type: "start", partial: message } satisfies AssistantMessageEvent;
		yield {
			type: "text_delta",
			contentIndex: 0,
			delta: text,
			partial: message,
		} satisfies AssistantMessageEvent;
		yield {
			type: "done",
			reason: "stop",
			message,
		} satisfies AssistantMessageEvent;
	})();
}

function mutatingToolStream(): AsyncGenerator<AssistantMessageEvent> {
	return (async function* () {
		const message: AssistantMessage = {
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
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		};
		yield { type: "start", partial: message } satisfies AssistantMessageEvent;
		yield {
			type: "toolcall_end",
			toolCall: {
				type: "toolCall",
				id: "mutating-tool-call",
				name: "mutating_probe",
				arguments: {},
			},
			partial: message,
		} satisfies AssistantMessageEvent;
		yield {
			type: "done",
			reason: "toolUse",
			message,
		} satisfies AssistantMessageEvent;
	})();
}

function toolCallStream(
	toolName: string,
): AsyncGenerator<AssistantMessageEvent> {
	return (async function* () {
		const message: AssistantMessage = {
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
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		};
		yield { type: "start", partial: message } satisfies AssistantMessageEvent;
		yield {
			type: "toolcall_end",
			toolCall: {
				type: "toolCall",
				id: `${toolName}-call`,
				name: toolName,
				arguments: {},
			},
			partial: message,
		} satisfies AssistantMessageEvent;
		yield {
			type: "done",
			reason: "toolUse",
			message,
		} satisfies AssistantMessageEvent;
	})();
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
	for await (const _event of iterable) {
		// Drain the transport run.
	}
}

afterEach(() => {
	childProcessMock.execFileSync.mockClear();
	providerStreamMock.createProviderStream.mockClear();
});

describe("ProviderTransport reusable snapshot timing", () => {
	it("does not compute a git snapshot before a provider turn that has no tool calls", async () => {
		const transport = new ProviderTransport({ cwd: process.cwd() });
		const config: AgentRunConfig = {
			systemPrompt: "Test",
			tools: [],
			model,
		};

		await drain(transport.run([userMessage], userMessage, config));

		expect(providerStreamMock.createProviderStream).toHaveBeenCalledOnce();
		expect(childProcessMock.execFileSync).not.toHaveBeenCalled();
	});

	it("clears stale run-scoped cache state before deciding to refresh eagerly", async () => {
		const transport = new ProviderTransport({ cwd: process.cwd() });
		const readOnlyTool: AgentTool = {
			name: "run_probe",
			description: "Read-only run-scoped cache probe.",
			parameters: Type.Object({}),
			annotations: { readOnlyHint: true },
			execute: async () => ({
				content: [{ type: "text", text: "read" }],
			}),
		};
		providerStreamMock.createProviderStream
			.mockImplementationOnce(() => toolCallStream("run_probe"))
			.mockImplementationOnce(() => textStream("after read"));

		await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Test",
				tools: [readOnlyTool],
				model,
			}),
		);

		expect(childProcessMock.execFileSync).toHaveBeenCalled();
		childProcessMock.execFileSync.mockClear();
		providerStreamMock.createProviderStream.mockClear();
		providerStreamMock.createProviderStream.mockImplementationOnce(() =>
			textStream("next turn"),
		);

		await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Test",
				tools: [readOnlyTool],
				model,
			}),
		);

		expect(providerStreamMock.createProviderStream).toHaveBeenCalledOnce();
		expect(childProcessMock.execFileSync).not.toHaveBeenCalled();
	});

	it("does not treat an empty previous snapshot as reusable state", async () => {
		const transport = new ProviderTransport({ cwd: process.cwd() });
		const mutatingTool: AgentTool = {
			name: "mutating_probe",
			description: "Mutates state and therefore is not reusable.",
			parameters: Type.Object({}),
			annotations: { destructiveHint: true, readOnlyHint: false },
			execute: async () => ({
				content: [{ type: "text", text: "mutated" }],
			}),
		};
		providerStreamMock.createProviderStream
			.mockImplementationOnce(mutatingToolStream)
			.mockImplementationOnce(() => textStream("after mutation"));

		await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Test",
				tools: [mutatingTool],
				model,
			}),
		);

		expect(childProcessMock.execFileSync).toHaveBeenCalled();
		childProcessMock.execFileSync.mockClear();
		providerStreamMock.createProviderStream.mockClear();
		providerStreamMock.createProviderStream.mockImplementationOnce(() =>
			textStream("next turn"),
		);

		await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Test",
				tools: [mutatingTool],
				model,
			}),
		);

		expect(providerStreamMock.createProviderStream).toHaveBeenCalledOnce();
		expect(childProcessMock.execFileSync).not.toHaveBeenCalled();
	});
});
