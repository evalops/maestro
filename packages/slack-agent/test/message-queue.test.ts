import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageQueue } from "../src/utils/message-queue.js";

describe("MessageQueue", () => {
	let respondMock: ReturnType<typeof vi.fn>;
	let respondInThreadMock: ReturnType<typeof vi.fn>;
	let onErrorMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		respondMock = vi.fn().mockResolvedValue(undefined);
		respondInThreadMock = vi.fn().mockResolvedValue(undefined);
		onErrorMock = vi.fn();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("delivers messages in order", async () => {
		const order: string[] = [];
		respondMock.mockImplementation(async (text: string) => {
			order.push(text);
		});

		const queue = new MessageQueue({
			handler: {
				respond: respondMock,
				respondInThread: respondInThreadMock,
			},
		});

		queue.enqueueMessage("first", "main", "test");
		queue.enqueueMessage("second", "main", "test");
		queue.enqueueMessage("third", "main", "test");

		await queue.flush();

		expect(order).toEqual(["first", "second", "third"]);
	});

	it("sends to thread when target is thread", async () => {
		const queue = new MessageQueue({
			handler: {
				respond: respondMock,
				respondInThread: respondInThreadMock,
			},
		});

		queue.enqueueMessage("thread message", "thread", "test");
		await queue.flush();

		expect(respondInThreadMock).toHaveBeenCalledWith("thread message");
		expect(respondMock).not.toHaveBeenCalled();
	});

	it("sends to main when target is main", async () => {
		const queue = new MessageQueue({
			handler: {
				respond: respondMock,
				respondInThread: respondInThreadMock,
			},
		});

		queue.enqueueMessage("main message", "main", "test");
		await queue.flush();

		expect(respondMock).toHaveBeenCalledWith("main message", true);
		expect(respondInThreadMock).not.toHaveBeenCalled();
	});

	it("passes log parameter to respond", async () => {
		const queue = new MessageQueue({
			handler: {
				respond: respondMock,
				respondInThread: respondInThreadMock,
			},
		});

		queue.enqueueMessage("logged", "main", "test", true);
		queue.enqueueMessage("not logged", "main", "test", false);
		await queue.flush();

		expect(respondMock).toHaveBeenNthCalledWith(1, "logged", true);
		expect(respondMock).toHaveBeenNthCalledWith(2, "not logged", false);
	});

	it("splits long messages using splitText function", async () => {
		const queue = new MessageQueue({
			handler: {
				respond: respondMock,
				respondInThread: respondInThreadMock,
			},
			splitText: (text) => text.split("|"),
		});

		queue.enqueueMessage("part1|part2|part3", "main", "test");
		await queue.flush();

		expect(respondMock).toHaveBeenCalledTimes(3);
		expect(respondMock).toHaveBeenNthCalledWith(1, "part1", true);
		expect(respondMock).toHaveBeenNthCalledWith(2, "part2", true);
		expect(respondMock).toHaveBeenNthCalledWith(3, "part3", true);
	});

	it("continues on error and calls onError", async () => {
		respondMock
			.mockRejectedValueOnce(new Error("API error"))
			.mockResolvedValueOnce(undefined);

		const queue = new MessageQueue({
			handler: {
				respond: respondMock,
				respondInThread: respondInThreadMock,
			},
			onError: onErrorMock,
		});

		queue.enqueueMessage("fails", "main", "first call");
		queue.enqueueMessage("succeeds", "main", "second call");
		await queue.flush();

		expect(onErrorMock).toHaveBeenCalledWith("first call", "API error");
		expect(respondMock).toHaveBeenCalledTimes(2);
		expect(respondInThreadMock).toHaveBeenCalledWith("_Error: API error_");
	});

	it("handles async operations sequentially", async () => {
		const events: string[] = [];
		// Use objects to hold resolvers so TypeScript can track mutations
		const resolvers: {
			first: (() => void) | null;
			second: (() => void) | null;
		} = { first: null, second: null };

		const queue = new MessageQueue({
			handler: {
				respond: async (text) => {
					events.push(`start:${text}`);
					if (text === "first") {
						await new Promise<void>((r) => {
							resolvers.first = r;
						});
					} else if (text === "second") {
						await new Promise<void>((r) => {
							resolvers.second = r;
						});
					}
					events.push(`end:${text}`);
				},
				respondInThread: respondInThreadMock,
			},
		});

		queue.enqueueMessage("first", "main", "test");
		queue.enqueueMessage("second", "main", "test");
		queue.enqueueMessage("third", "main", "test");

		// Give time for first to start
		await new Promise((r) => setTimeout(r, 10));
		expect(events).toEqual(["start:first"]);

		// Resolve first, second should start
		resolvers.first?.();
		await new Promise((r) => setTimeout(r, 10));
		expect(events).toEqual(["start:first", "end:first", "start:second"]);

		// Resolve second, third should run to completion
		resolvers.second?.();
		await queue.flush();
		expect(events).toEqual([
			"start:first",
			"end:first",
			"start:second",
			"end:second",
			"start:third",
			"end:third",
		]);
	});

	it("enqueue allows arbitrary async operations", async () => {
		const queue = new MessageQueue({
			handler: {
				respond: respondMock,
				respondInThread: respondInThreadMock,
			},
		});

		const customOp = vi.fn().mockResolvedValue(undefined);
		queue.enqueue(customOp, "custom operation");
		await queue.flush();

		expect(customOp).toHaveBeenCalled();
	});

	it("flush returns immediately when queue is empty", async () => {
		const queue = new MessageQueue({
			handler: {
				respond: respondMock,
				respondInThread: respondInThreadMock,
			},
		});

		await queue.flush();

		expect(respondMock).not.toHaveBeenCalled();
		expect(respondInThreadMock).not.toHaveBeenCalled();
	});

	it("uses default splitText when not provided", async () => {
		const queue = new MessageQueue({
			handler: {
				respond: respondMock,
				respondInThread: respondInThreadMock,
			},
		});

		queue.enqueueMessage("single message", "main", "test");
		await queue.flush();

		expect(respondMock).toHaveBeenCalledTimes(1);
		expect(respondMock).toHaveBeenCalledWith("single message", true);
	});

	it("handles non-Error exceptions", async () => {
		respondMock.mockRejectedValueOnce("string error");

		const queue = new MessageQueue({
			handler: {
				respond: respondMock,
				respondInThread: respondInThreadMock,
			},
			onError: onErrorMock,
		});

		queue.enqueueMessage("fails", "main", "test");
		await queue.flush();

		expect(onErrorMock).toHaveBeenCalledWith("test", "string error");
	});
});
