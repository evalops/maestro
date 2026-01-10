import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTool, Api, Message, Model } from "../../src/agent/types.js";

const imageProcessorMock = vi.hoisted(() => {
	return {
		isSharpAvailable: vi.fn(async () => true),
		getImageMetadata: vi.fn(async () => ({
			width: 9001,
			height: 10,
			format: "png",
			size: 123,
		})),
		processImage: vi.fn(async () => ({
			base64: "resized-base64",
			mimeType: "image/png",
			originalWidth: 9001,
			originalHeight: 10,
			width: 2000,
			height: 2,
			originalSize: 123,
			processedSize: 45,
			wasResized: true,
			wasCompressed: true,
		})),
	};
});

vi.mock("../../src/tools/image-processor.js", () => imageProcessorMock);

import { defaultPreprocessMessages } from "../../src/agent/preprocess-messages.js";

function createModel<TApi extends Api>(
	overrides: Partial<Model<TApi>>,
): Model<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions" as TApi,
		provider: "openai",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...overrides,
	} as Model<TApi>;
}

describe("defaultPreprocessMessages", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("strips images when target model does not support image input", async () => {
		const model = createModel({ input: ["text"] });

		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "image", data: "aaaa", mimeType: "image/png" },
					{ type: "image", data: "bbbb", mimeType: "image/png" },
				],
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "screenshot",
				content: [{ type: "image", data: "cccc", mimeType: "image/png" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const out = await defaultPreprocessMessages(
			messages,
			{ systemPrompt: "", tools: [] satisfies AgentTool[], model },
			undefined,
		);

		const user = out[0]!;
		expect(user.role).toBe("user");
		expect(Array.isArray(user.content)).toBe(true);
		if (Array.isArray(user.content)) {
			expect(user.content).toHaveLength(1);
			expect(user.content[0]!.type).toBe("text");
			expect(
				(user.content[0] as { type: "text"; text: string }).text,
			).toContain("does not support image");
		}

		const toolResult = out[1]!;
		expect(toolResult.role).toBe("toolResult");
		if (toolResult.role === "toolResult") {
			expect(toolResult.content).toHaveLength(1);
			expect((toolResult.content[0] as { type: string }).type).toBe("text");
		}
	});

	it("resizes anthropic images when session image count exceeds threshold", async () => {
		imageProcessorMock.isSharpAvailable.mockResolvedValueOnce(true);
		imageProcessorMock.getImageMetadata.mockResolvedValueOnce({
			width: 9001,
			height: 10,
			format: "png",
			size: 123,
		});

		const model = createModel({
			api: "anthropic-messages",
			provider: "anthropic",
			input: ["text", "image"],
		});

		const images = Array.from({ length: 21 }, (_, i) => ({
			type: "image" as const,
			data: `img-${i}`,
			mimeType: "image/png",
		}));

		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "hi" }, ...images],
				timestamp: Date.now(),
			},
		];

		const out = await defaultPreprocessMessages(messages, {
			systemPrompt: "",
			tools: [],
			model,
		});

		// All images get processed using the tightened 2000x2000 budget.
		expect(imageProcessorMock.processImage).toHaveBeenCalled();
		const lastCall = imageProcessorMock.processImage.mock.calls.at(-1) as
			| unknown[]
			| undefined;
		expect(lastCall?.[1]).toMatchObject({ maxWidth: 2000, maxHeight: 2000 });

		const user = out[0]!;
		expect(user.role).toBe("user");
		if (user.role === "user" && Array.isArray(user.content)) {
			const imageBlocks = user.content.filter((c) => c.type === "image");
			expect(imageBlocks).toHaveLength(21);
			for (const block of imageBlocks) {
				expect(block.data).toBe("resized-base64");
				expect(block.mimeType).toBe("image/png");
			}
		}
	});
});
