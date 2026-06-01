import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageQueue } from "../src/utils/message-queue.js";

describe("MessageQueue", () => {
	let respondMock: ReturnType<typeof vi.fn>;
	let replaceMessageMock: ReturnType<typeof vi.fn>;
	let respondInThreadMock: ReturnType<typeof vi.fn>;
	let postMessageMock: ReturnType<typeof vi.fn>;
	let postThreadReplyMock: ReturnType<typeof vi.fn>;
	let updateStatusMock: ReturnType<typeof vi.fn>;
	let onErrorMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		respondMock = vi.fn().mockResolvedValue(undefined);
		replaceMessageMock = vi.fn().mockResolvedValue(undefined);
		respondInThreadMock = vi.fn().mockResolvedValue(undefined);
		postMessageMock = vi.fn().mockResolvedValue(undefined);
		postThreadReplyMock = vi.fn().mockResolvedValue(undefined);
		updateStatusMock = vi.fn().mockResolvedValue(undefined);
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
		expect(respondInThreadMock).toHaveBeenCalledWith(
			"_I hit a Slack delivery error: API error_",
		);
	});

	it("can surface delivery failures to tool callers", async () => {
		respondMock.mockRejectedValueOnce(new Error("API error"));
		const queue = new MessageQueue({
			handler: {
				respond: respondMock,
				respondInThread: respondInThreadMock,
			},
			onError: onErrorMock,
		});

		const failureCount = queue.deliveryFailures();
		queue.enqueueMessage("fails", "main", "send_message");

		await expect(
			queue.flushOrThrowIfDeliveryFailed(failureCount),
		).rejects.toThrow("send_message failed to deliver in Slack.");
		expect(queue.deliveryFailures()).toBe(failureCount + 1);
	});

	it("handles async operations sequentially", async () => {
		const events: string[] = [];
		const resolvers: {
			first: (() => void) | null;
			second: (() => void) | null;
		} = { first: null, second: null };
		const started: {
			first: Promise<void>;
			second: Promise<void>;
		} = {
			first: Promise.resolve(),
			second: Promise.resolve(),
		};
		const startedResolvers: {
			first: (() => void) | null;
			second: (() => void) | null;
		} = { first: null, second: null };
		started.first = new Promise<void>((resolve) => {
			startedResolvers.first = resolve;
		});
		started.second = new Promise<void>((resolve) => {
			startedResolvers.second = resolve;
		});

		const queue = new MessageQueue({
			handler: {
				respond: async (text) => {
					events.push(`start:${text}`);
					if (text === "first") {
						startedResolvers.first?.();
						await new Promise<void>((r) => {
							resolvers.first = r;
						});
					} else if (text === "second") {
						startedResolvers.second?.();
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

		await started.first;
		expect(events).toEqual(["start:first"]);

		resolvers.first?.();
		await started.second;
		expect(events).toEqual(["start:first", "end:first", "start:second"]);

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

	it("rate-limits short progress updates through the status surface", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1000);
		const onDelivery = vi.fn();
		const queue = new MessageQueue({
			handler: {
				respond: respondMock,
				respondInThread: respondInThreadMock,
				updateStatus: updateStatusMock,
			},
			onDelivery,
			progressMinIntervalMs: 15000,
			progressMaxLength: 32,
		});

		expect(queue.sendProgress("Checking the deployment now")).toBe(true);
		expect(queue.sendProgress("Still checking the deployment")).toBe(false);

		await queue.flush();
		expect(updateStatusMock).toHaveBeenCalledTimes(1);
		expect(updateStatusMock).toHaveBeenCalledWith(
			"Checking the deployment now",
		);
		expect(onDelivery).toHaveBeenCalledTimes(1);
		expect(onDelivery).toHaveBeenLastCalledWith({
			kind: "progress",
			target: "status",
			textLength: "Checking the deployment now".length,
		});

		now.mockReturnValue(16000);
		expect(
			queue.sendProgress(
				"Reading Kubernetes rollout, Argo revision, and Slack renderer state",
			),
		).toBe(true);
		await queue.flush();

		expect(updateStatusMock).toHaveBeenCalledTimes(2);
		expect(updateStatusMock.mock.calls[1]?.[0]).toBe(
			"Reading Kubernetes rollout, Argo revi...",
		);
		expect(onDelivery).toHaveBeenCalledTimes(2);
	});

	it("posts explicit channel messages separately from the primary response", async () => {
		const queue = new MessageQueue({
			handler: {
				respond: respondMock,
				respondInThread: respondInThreadMock,
				postMessage: postMessageMock,
			},
			splitText: (text) => [text.slice(0, 5), text.slice(5)],
		});

		queue.sendMessage("C999", "helloworld", false);
		await queue.flush();

		expect(postMessageMock).toHaveBeenNthCalledWith(1, "C999", "hello", false);
		expect(postMessageMock).toHaveBeenNthCalledWith(2, "C999", "world", false);
		expect(respondMock).not.toHaveBeenCalled();
	});

	it("posts explicit thread replies to the requested channel and thread", async () => {
		const queue = new MessageQueue({
			handler: {
				respond: respondMock,
				respondInThread: respondInThreadMock,
				postThreadReply: postThreadReplyMock,
			},
		});

		queue.sendThreadReply("C999", "1710000000.000100", "thread note", false);
		await queue.flush();

		expect(postThreadReplyMock).toHaveBeenCalledWith(
			"C999",
			"1710000000.000100",
			"thread note",
			false,
		);
		expect(respondInThreadMock).not.toHaveBeenCalled();
	});

	it("sends one final primary message and chunks overflow into the thread", async () => {
		const onDelivery = vi.fn();
		const queue = new MessageQueue({
			handler: {
				respond: respondMock,
				replaceMessage: replaceMessageMock,
				respondInThread: respondInThreadMock,
			},
			onDelivery,
			splitText: (text) => [
				text.slice(0, 5),
				text.slice(5, 10),
				text.slice(10),
			],
		});

		expect(queue.sendFinal("abcdefghijk")).toBe(true);
		expect(queue.sendFinal("ignored")).toBe(false);
		expect(queue.finalText()).toBe("");

		await queue.flush();
		expect(replaceMessageMock).toHaveBeenCalledTimes(1);
		expect(replaceMessageMock).toHaveBeenCalledWith(
			"abcde",
			true,
			"abcdefghijk",
		);
		expect(respondInThreadMock).toHaveBeenCalledTimes(2);
		expect(respondInThreadMock).toHaveBeenNthCalledWith(1, "fghij");
		expect(respondInThreadMock).toHaveBeenNthCalledWith(2, "k");
		expect(queue.finalText()).toBe("abcdefghijk");
		expect(queue.hasFinal()).toBe(true);
		expect(onDelivery).toHaveBeenCalledTimes(3);
		expect(onDelivery).toHaveBeenNthCalledWith(1, {
			kind: "final",
			target: "main",
			textLength: 5,
			chunkIndex: 0,
			chunkCount: 3,
		});
		expect(onDelivery).toHaveBeenNthCalledWith(2, {
			kind: "final_continuation",
			target: "thread",
			textLength: 5,
			chunkIndex: 1,
			chunkCount: 3,
		});
	});

	it("does not mark final sent when Slack delivery fails", async () => {
		replaceMessageMock.mockRejectedValueOnce(new Error("Slack API failed"));
		const queue = new MessageQueue({
			handler: {
				respond: respondMock,
				replaceMessage: replaceMessageMock,
				respondInThread: respondInThreadMock,
			},
			onError: onErrorMock,
		});

		expect(queue.sendFinal("not delivered")).toBe(true);
		await queue.flush();

		expect(onErrorMock).toHaveBeenCalledWith("send_final", "Slack API failed");
		expect(queue.finalText()).toBe("");
		expect(queue.hasFinal()).toBe(false);
		expect(queue.sendFinal("retry")).toBe(true);
	});

	it("posts errors and blockers as their own thread replies", async () => {
		const onDelivery = vi.fn();
		const queue = new MessageQueue({
			handler: {
				respond: respondMock,
				respondInThread: respondInThreadMock,
			},
			onDelivery,
			progressMaxLength: 40,
		});

		queue.sendError("GCP credentials are missing for this workspace");
		queue.sendBlocker("Need GCP credentials for this workspace");
		await queue.flush();

		expect(respondInThreadMock).toHaveBeenNthCalledWith(
			1,
			"_I hit an error: GCP credentials are missing for this..._",
			true,
		);
		expect(respondInThreadMock).toHaveBeenNthCalledWith(
			2,
			"_I'm blocked: Need GCP credentials for this workspace_",
			true,
		);
		expect(onDelivery).toHaveBeenNthCalledWith(1, {
			kind: "error",
			target: "thread",
			textLength: "GCP credentials are missing for this...".length,
		});
		expect(onDelivery).toHaveBeenNthCalledWith(2, {
			kind: "blocker",
			target: "thread",
			textLength: "Need GCP credentials for this workspace".length,
		});
	});

	it("posts user requests as their own thread reply", async () => {
		const onDelivery = vi.fn();
		const queue = new MessageQueue({
			handler: {
				respond: respondMock,
				respondInThread: respondInThreadMock,
			},
			onDelivery,
		});

		queue.sendRequest("Can I merge PR #123 after checks pass?");
		await queue.flush();

		expect(respondInThreadMock).toHaveBeenCalledWith(
			"_I need: Can I merge PR #123 after checks pass?_",
			true,
		);
		expect(onDelivery).toHaveBeenCalledWith({
			kind: "request",
			target: "thread",
			textLength: "Can I merge PR #123 after checks pass?".length,
		});
	});
});
