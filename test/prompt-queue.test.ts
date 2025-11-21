import { describe, expect, it } from "vitest";
import { PromptQueue } from "../src/tui/prompt-queue.js";

const waitForSettled = (queue: PromptQueue, expected: number) =>
	new Promise<void>((resolve) => {
		let settled = 0;
		queue.subscribe((event) => {
			if (event.type === "finish" || event.type === "error") {
				settled += 1;
				if (settled === expected) {
					resolve();
				}
			}
		});
	});

describe("PromptQueue", () => {
	it("runs prompts sequentially", async () => {
		const calls: string[] = [];
		const queue = new PromptQueue(async (text) => {
			calls.push(text);
		});
		const done = waitForSettled(queue, 2);
		queue.enqueue("first");
		queue.enqueue("second");
		await done;
		expect(calls).toEqual(["first", "second"]);
	});

	it("cancels pending prompts by id", async () => {
		const queue = new PromptQueue(async () => {});
		queue.enqueue("first");
		const second = queue.enqueue("second");
		const removed = queue.cancel(second.id);
		expect(removed?.id).toBe(second.id);
		const snapshot = queue.getSnapshot();
		expect(snapshot.pending.some((entry) => entry.id === second.id)).toBe(
			false,
		);
		await waitForSettled(queue, 1);
	});

	it("continues processing after runner errors", async () => {
		let shouldFail = true;
		const calls: string[] = [];
		const queue = new PromptQueue(async (text) => {
			calls.push(text);
			if (shouldFail) {
				shouldFail = false;
				throw new Error("boom");
			}
		});
		const done = waitForSettled(queue, 2);
		queue.enqueue("first");
		queue.enqueue("second");
		await done;
		expect(calls).toEqual(["first", "second"]);
		const snapshot = queue.getSnapshot();
		expect(snapshot.pending.length).toBe(0);
	});

	it("emits cancel events by default when calling cancelAll", async () => {
		// Use a blocking runner so prompts stay in pending
		let resolve: () => void;
		const blocker = new Promise<void>((r) => {
			resolve = r;
		});
		const queue = new PromptQueue(async () => {
			await blocker;
		});
		const cancelEvents: string[] = [];
		queue.subscribe((event) => {
			if (event.type === "cancel") {
				cancelEvents.push(event.entry.text);
			}
		});
		queue.enqueue("first"); // This starts running immediately
		queue.enqueue("second"); // This stays pending
		queue.enqueue("third"); // This stays pending
		queue.cancelAll(); // Should cancel pending only
		expect(cancelEvents).toEqual(["second", "third"]);
		resolve?.(); // Unblock the runner
	});

	it("suppresses cancel events when silent mode is enabled", () => {
		const queue = new PromptQueue(async () => {});
		const cancelEvents: string[] = [];
		queue.subscribe((event) => {
			if (event.type === "cancel") {
				cancelEvents.push(event.entry.text);
			}
		});
		queue.enqueue("first");
		queue.enqueue("second");
		queue.enqueue("third");
		queue.cancelAll({ silent: true });
		expect(cancelEvents).toEqual([]);
	});

	it("returns cancelled entries even in silent mode", () => {
		// Use a blocking runner so prompts stay in pending
		let resolve: () => void;
		const blocker = new Promise<void>((r) => {
			resolve = r;
		});
		const queue = new PromptQueue(async () => {
			await blocker;
		});
		queue.enqueue("first"); // This starts running immediately
		queue.enqueue("second"); // This stays pending
		const cancelled = queue.cancelAll({ silent: true });
		expect(cancelled.length).toBe(1); // Only pending are cancelled
		expect(cancelled.map((e) => e.text)).toEqual(["second"]);
		resolve?.(); // Unblock the runner
	});

	it("clearActive does not emit events", () => {
		const queue = new PromptQueue(async () => {});
		const events: string[] = [];
		queue.subscribe((event) => {
			events.push(event.type);
		});
		queue.enqueue("first");
		// Wait for it to start processing
		queue.clearActive();
		// Only enqueue and start events should be emitted, no cancel/finish
		expect(events).toEqual(["enqueue", "start"]);
	});
});
