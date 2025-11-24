import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderTransport } from "../../src/agent/transport.js";
import type { AgentTool, Message, Model } from "../../src/agent/types.js";

const openaiMock = vi.hoisted(() => {
	let invocation = 0;
	let nextToolArgs: Record<string, any> = {};

	const reset = () => {
		invocation = 0;
		nextToolArgs = {};
	};

	const setArgs = (args: Record<string, any>) => {
		nextToolArgs = args;
	};

	const streamOpenAI = vi.fn(async function* () {
		invocation += 1;
		const includeTool = invocation === 1;

		const toolCall = includeTool
			? {
					type: "toolCall" as const,
					id: "tc-1",
					name: "write_file",
					arguments: nextToolArgs,
				}
			: null;

		const message = {
			role: "assistant" as const,
			content: toolCall ? [toolCall] : [],
			api: "openai-completions" as const,
			provider: "openai",
			model: "gpt-mock",
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
			stopReason: includeTool ? "toolUse" : "stop",
			timestamp: Date.now(),
		};

		yield { type: "start" as const, partial: message };
		if (toolCall) {
			yield {
				type: "toolcall_end" as const,
				contentIndex: 0,
				toolCall,
				partial: message,
			};
		}
		yield {
			type: "done" as const,
			reason: includeTool ? "toolUse" : "stop",
			message,
		};
	});

	return {
		streamOpenAI,
		__resetStreamState: reset,
		__setNextToolArgs: setArgs,
	};
}) as {
	streamOpenAI: ReturnType<typeof vi.fn>;
	__resetStreamState: () => void;
	__setNextToolArgs: (args: Record<string, any>) => void;
};

vi.mock("../../src/agent/providers/openai.js", () => openaiMock);

const model: Model<"openai-completions"> = {
	id: "gpt-mock",
	name: "Mock GPT",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://example.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1024,
	maxTokens: 256,
};

const toolSchema = Type.Object({
	path: Type.String({ minLength: 1 }),
});

const createUserMessage = (): Message => ({
	role: "user",
	content: "hello",
	timestamp: Date.now(),
});

describe("ProviderTransport tool validation", () => {
	const executeSpy = vi.fn();

	const tool: AgentTool<typeof toolSchema> = {
		name: "write_file",
		description: "Write to disk",
		parameters: toolSchema,
		execute: executeSpy,
	};

	const transport = new ProviderTransport({
		getApiKey: () => "test-key",
	});

	beforeEach(() => {
		executeSpy.mockReset();
		openaiMock.streamOpenAI.mockClear();
		openaiMock.__resetStreamState();
		openaiMock.__setNextToolArgs({});
	});

	it("returns validation errors and does not execute the tool", async () => {
		openaiMock.__setNextToolArgs({}); // Missing required path

		const events: any[] = [];
		for await (const event of transport.run(
			[createUserMessage()],
			createUserMessage(),
			{
				systemPrompt: "",
				tools: [tool],
				model,
				reasoning: undefined,
			},
		)) {
			events.push(event);
		}

		const endEvent = events.find((e) => e.type === "tool_execution_end") as any;
		expect(endEvent).toBeDefined();
		expect(endEvent.isError).toBe(true);

		const resultContent = (endEvent.result.content[0] as any).text;
		expect(resultContent).toContain('Validation failed for tool "write_file"');
		expect(resultContent).toContain("path");
		expect(executeSpy).not.toHaveBeenCalled();
	});

	it("passes validated arguments to the tool when schema matches", async () => {
		openaiMock.__setNextToolArgs({ path: "/tmp/file.ts" });
		executeSpy.mockResolvedValue({
			content: [{ type: "text", text: "ok" }],
			isError: false,
		});

		const events: any[] = [];
		for await (const event of transport.run(
			[createUserMessage()],
			createUserMessage(),
			{
				systemPrompt: "",
				tools: [tool],
				model,
				reasoning: undefined,
			},
		)) {
			events.push(event);
		}

		expect(executeSpy).toHaveBeenCalledTimes(1);
		expect(executeSpy).toHaveBeenCalledWith(
			"tc-1",
			{ path: "/tmp/file.ts" },
			undefined,
		);

		const endEvent = events.find((e) => e.type === "tool_execution_end") as any;
		expect(endEvent.isError).toBe(false);
		const resultContent = (endEvent.result.content[0] as any).text;
		expect(resultContent).toBe("ok");

		// Under the hood, run should stop after the second turn (no tool calls)
		expect(
			openaiMock.streamOpenAI.mock.calls.length,
			"stream invoked twice (tool turn + normal turn)",
		).toBe(2);
	});

	it("treats array arguments as invalid input", async () => {
		openaiMock.__setNextToolArgs([
			{ path: "/tmp/file.ts" },
		] as unknown as Record<string, any>);

		const events: any[] = [];
		for await (const event of transport.run(
			[createUserMessage()],
			createUserMessage(),
			{
				systemPrompt: "",
				tools: [tool],
				model,
				reasoning: undefined,
			},
		)) {
			events.push(event);
		}

		const endEvent = events.find((e) => e.type === "tool_execution_end") as any;
		expect(endEvent).toBeDefined();
		expect(endEvent.isError).toBe(true);
		expect(executeSpy).not.toHaveBeenCalled();
		const resultContent = (endEvent.result.content[0] as any).text;
		expect(resultContent).toContain("path");
	});
});
