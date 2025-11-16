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
});
