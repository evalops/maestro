import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../../src/agent/providers/openai-codex-responses.js";
import type { Context, Model } from "../../src/agent/types.js";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.5",
	name: "GPT-5.5 (Codex)",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	toolUse: true,
	input: ["text", "image"],
	cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
};

const context: Context = {
	systemPrompt: "You are Maestro.",
	messages: [{ role: "user", content: "Hello", timestamp: 1 }],
	tools: [
		{
			name: "read",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			} as never,
		},
	],
};

function encodeBase64Url(value: unknown): string {
	return Buffer.from(JSON.stringify(value))
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function fakeCodexToken(accountId = "acct_chatgpt"): string {
	return [
		encodeBase64Url({ alg: "none" }),
		encodeBase64Url({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
		}),
		"sig",
	].join(".");
}

function sseResponse(events: unknown[]): Response {
	const body = events
		.map((event) => `data: ${JSON.stringify(event)}\n\n`)
		.join("");
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(body));
				controller.close();
			},
		}),
		{
			status: 200,
			headers: { "content-type": "text/event-stream" },
		},
	);
}

describe("OpenAI Codex Responses provider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("streams text from the ChatGPT Codex responses backend", async () => {
		let requestUrl: string | undefined;
		let requestHeaders: Headers | undefined;
		let requestBody: Record<string, unknown> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async (url: string | URL | Request, init?: RequestInit) => {
				requestUrl = String(url);
				requestHeaders = new Headers(init?.headers);
				requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return sseResponse([
					{
						type: "response.output_item.added",
						item: { type: "message", id: "msg_1", content: [] },
					},
					{ type: "response.output_text.delta", delta: "Hello Codex" },
					{
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_1",
							content: [{ type: "output_text", text: "Hello Codex" }],
						},
					},
					{
						type: "response.completed",
						response: {
							status: "completed",
							usage: {
								input_tokens: 12,
								output_tokens: 3,
								input_tokens_details: { cached_tokens: 2 },
							},
						},
					},
				]);
			},
		);

		const events = [];
		for await (const event of streamOpenAICodexResponses(model, context, {
			apiKey: fakeCodexToken(),
			reasoningEffort: "ultra",
			reasoningSummary: "auto",
			sessionId: "session_123",
		})) {
			events.push(event);
		}

		expect(requestUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(requestHeaders?.get("authorization")).toMatch(/^Bearer /);
		expect(requestHeaders?.get("chatgpt-account-id")).toBe("acct_chatgpt");
		expect(requestHeaders?.get("openai-beta")).toBe("responses=experimental");
		expect(requestHeaders?.get("session_id")).toBe("session_123");
		expect(requestBody).toMatchObject({
			model: "gpt-5.5",
			store: false,
			stream: true,
			instructions: "You are Maestro.",
			include: ["reasoning.encrypted_content"],
			prompt_cache_key: "session_123",
			tool_choice: "auto",
			parallel_tool_calls: true,
			reasoning: { effort: "xhigh", summary: "auto" },
		});
		expect(requestBody?.input).toEqual([
			{
				role: "user",
				content: [{ type: "input_text", text: "Hello" }],
			},
		]);
		expect(requestBody?.tools).toEqual([
			{
				type: "function",
				name: "read",
				description: "Read a file",
				parameters: context.tools?.[0]?.parameters,
				strict: null,
			},
		]);
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type === "done") {
			expect(done.message.content).toEqual([
				{ type: "text", text: "Hello Codex" },
			]);
			expect(done.message.usage.input).toBe(10);
			expect(done.message.usage.cacheRead).toBe(2);
			expect(done.message.usage.output).toBe(3);
		}
	});

	it("omits tool fields when no tools are available", async () => {
		let requestBody: Record<string, unknown> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async (_url: string | URL | Request, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return sseResponse([
					{
						type: "response.completed",
						response: { status: "completed" },
					},
				]);
			},
		);

		for await (const _event of streamOpenAICodexResponses(
			model,
			{ ...context, tools: [] },
			{ apiKey: fakeCodexToken() },
		)) {
			// Drain the stream so the request is issued.
		}

		expect(requestBody?.tools).toBeUndefined();
		expect(requestBody?.tool_choice).toBeUndefined();
		expect(requestBody?.parallel_tool_calls).toBeUndefined();
	});
});
