import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ResponseStateConfig,
	createResponseHandlers,
} from "../src/slack/response-state.js";

// Mock dependencies
const mockWebClient = {
	chat: {
		postMessage: vi.fn(),
		update: vi.fn(),
	},
	files: {
		uploadV2: vi.fn(),
	},
};

const mockStore = {
	logBotResponse: vi.fn(),
};

function createMockConfig(
	overrides: Partial<ResponseStateConfig> = {},
): ResponseStateConfig {
	return {
		channelId: "C123456",
		webClient: mockWebClient as unknown as ResponseStateConfig["webClient"],
		store: mockStore as unknown as ResponseStateConfig["store"],
		callSlack: async <T>(fn: () => Promise<T>) => fn(),
		...overrides,
	};
}

describe("createResponseHandlers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockWebClient.chat.postMessage.mockResolvedValue({
			ts: "1234567890.123456",
		});
		mockWebClient.chat.update.mockResolvedValue({ ok: true });
		mockWebClient.files.uploadV2.mockResolvedValue({ ok: true });
	});

	describe("respond", () => {
		it("posts initial message with working indicator", async () => {
			const handlers = createResponseHandlers(createMockConfig());

			await handlers.respond("Hello world");

			expect(mockWebClient.chat.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					channel: "C123456",
					text: "Hello world ...",
				}),
			);
		});

		it("updates existing message on subsequent calls", async () => {
			const handlers = createResponseHandlers(createMockConfig());

			await handlers.respond("First");
			await handlers.respond("Second");

			expect(mockWebClient.chat.postMessage).toHaveBeenCalledTimes(1);
			expect(mockWebClient.chat.update).toHaveBeenCalledWith(
				expect.objectContaining({
					channel: "C123456",
					ts: "1234567890.123456",
					text: "First\nSecond ...",
				}),
			);
		});

		it("logs bot response to store", async () => {
			const handlers = createResponseHandlers(createMockConfig());

			await handlers.respond("Test message");

			expect(mockStore.logBotResponse).toHaveBeenCalledWith(
				"C123456",
				"Test message",
				"1234567890.123456",
			);
		});

		it("does not log when log=false", async () => {
			const handlers = createResponseHandlers(createMockConfig());

			await handlers.respond("Test message", false);

			expect(mockStore.logBotResponse).not.toHaveBeenCalled();
		});

		it("includes thread_ts when provided", async () => {
			const handlers = createResponseHandlers(
				createMockConfig({ threadTs: "9999999999.999999" }),
			);

			await handlers.respond("Thread reply");

			expect(mockWebClient.chat.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					thread_ts: "9999999999.999999",
				}),
			);
		});

		it("includes reply_broadcast when provided", async () => {
			const handlers = createResponseHandlers(
				createMockConfig({ replyBroadcast: true }),
			);

			await handlers.respond("Broadcast reply");

			expect(mockWebClient.chat.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					reply_broadcast: true,
				}),
			);
		});
	});

	describe("replaceMessage", () => {
		it("replaces accumulated text entirely", async () => {
			const handlers = createResponseHandlers(createMockConfig());

			await handlers.respond("Initial");
			await handlers.replaceMessage("Replaced");

			expect(mockWebClient.chat.update).toHaveBeenLastCalledWith(
				expect.objectContaining({
					text: "Replaced ...",
				}),
			);
		});

		it("posts new message if none exists", async () => {
			const handlers = createResponseHandlers(createMockConfig());

			await handlers.replaceMessage("Brand new");

			expect(mockWebClient.chat.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					text: "Brand new ...",
				}),
			);
		});
	});

	describe("respondInThread", () => {
		it("posts message as thread reply", async () => {
			const handlers = createResponseHandlers(createMockConfig());

			await handlers.respond("Main message");
			await handlers.respondInThread("Thread reply");

			expect(mockWebClient.chat.postMessage).toHaveBeenLastCalledWith(
				expect.objectContaining({
					channel: "C123456",
					thread_ts: "1234567890.123456",
					text: "Thread reply",
				}),
			);
		});

		it("does nothing if no main message exists", async () => {
			const handlers = createResponseHandlers(createMockConfig());

			await handlers.respondInThread("Orphan reply");

			// Should only have not called postMessage for thread
			expect(mockWebClient.chat.postMessage).not.toHaveBeenCalled();
		});

		it("applies obfuscateUsernames to thread text", async () => {
			const handlers = createResponseHandlers(
				createMockConfig({
					obfuscateUsernames: (text) => text.replace(/@\w+/g, "@[redacted]"),
				}),
			);

			await handlers.respond("Main");
			await handlers.respondInThread("Hello @user123");

			expect(mockWebClient.chat.postMessage).toHaveBeenLastCalledWith(
				expect.objectContaining({
					text: "Hello @[redacted]",
				}),
			);
		});
	});

	describe("setTyping", () => {
		it("posts thinking message when starting to type", async () => {
			const handlers = createResponseHandlers(createMockConfig());

			await handlers.setTyping(true);

			expect(mockWebClient.chat.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					text: "_Thinking_",
				}),
			);
		});

		it("does nothing when already has a message", async () => {
			const handlers = createResponseHandlers(createMockConfig());

			await handlers.respond("Already posted");
			mockWebClient.chat.postMessage.mockClear();

			await handlers.setTyping(true);

			expect(mockWebClient.chat.postMessage).not.toHaveBeenCalled();
		});
	});

	describe("setWorking", () => {
		it("adds working indicator when set to true", async () => {
			const handlers = createResponseHandlers(createMockConfig());

			await handlers.respond("Working");
			mockWebClient.chat.update.mockClear();

			await handlers.setWorking(true);

			expect(mockWebClient.chat.update).toHaveBeenCalledWith(
				expect.objectContaining({
					text: "Working ...",
				}),
			);
		});

		it("removes working indicator when set to false", async () => {
			const handlers = createResponseHandlers(createMockConfig());

			await handlers.respond("Done");
			await handlers.setWorking(false);

			expect(mockWebClient.chat.update).toHaveBeenLastCalledWith(
				expect.objectContaining({
					text: "Done",
				}),
			);
		});
	});

	describe("updateStatus", () => {
		it("appends status to message while working", async () => {
			const handlers = createResponseHandlers(createMockConfig());

			await handlers.respond("Processing");
			await handlers.updateStatus("50% complete");

			expect(mockWebClient.chat.update).toHaveBeenLastCalledWith(
				expect.objectContaining({
					text: "Processing\n_50% complete_ ...",
				}),
			);
		});

		it("does nothing when not working", async () => {
			const handlers = createResponseHandlers(createMockConfig());

			await handlers.respond("Done");
			await handlers.setWorking(false);
			mockWebClient.chat.update.mockClear();

			await handlers.updateStatus("Status update");

			expect(mockWebClient.chat.update).not.toHaveBeenCalled();
		});
	});

	describe("uploadFile", () => {
		it("uploads file to channel", async () => {
			const handlers = createResponseHandlers(createMockConfig());

			// Mock readFile
			vi.mock("node:fs/promises", () => ({
				readFile: vi.fn().mockResolvedValue(Buffer.from("file content")),
			}));

			await handlers.uploadFile("/path/to/file.txt", "My File");

			expect(mockWebClient.files.uploadV2).toHaveBeenCalledWith(
				expect.objectContaining({
					channel_id: "C123456",
					filename: "My File",
					title: "My File",
				}),
			);
		});
	});

	describe("sequential updates", () => {
		it("processes updates in order despite async operations", async () => {
			const handlers = createResponseHandlers(createMockConfig());
			const updateOrder: string[] = [];

			mockWebClient.chat.postMessage.mockImplementation(async (args) => {
				updateOrder.push(`post:${args.text}`);
				await new Promise((r) => setTimeout(r, 10));
				return { ts: "1234567890.123456" };
			});

			mockWebClient.chat.update.mockImplementation(async (args) => {
				updateOrder.push(`update:${args.text}`);
				await new Promise((r) => setTimeout(r, 5));
				return { ok: true };
			});

			// Fire multiple updates concurrently
			await Promise.all([
				handlers.respond("First"),
				handlers.respond("Second"),
				handlers.respond("Third"),
			]);

			// Should process in order
			expect(updateOrder[0]).toContain("First");
		});
	});
});
