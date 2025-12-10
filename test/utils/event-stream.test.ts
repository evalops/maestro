import { describe, expect, it } from "vitest";
import {
	EventStream,
	createEventStream,
} from "../../src/utils/event-stream.js";

interface TestEvent {
	type: "data" | "done" | "error";
	value?: number;
	result?: string;
	error?: string;
}

function createTestStream() {
	return new EventStream<TestEvent, string>(
		(event) => event.type === "done" || event.type === "error",
		(event) => {
			if (event.type === "done") return event.result || "";
			if (event.type === "error") return `error: ${event.error}`;
			return "";
		},
	);
}

describe("EventStream", () => {
	describe("basic iteration", () => {
		it("yields pushed events in order", async () => {
			const stream = createTestStream();

			stream.push({ type: "data", value: 1 });
			stream.push({ type: "data", value: 2 });
			stream.push({ type: "done", result: "complete" });

			const events: TestEvent[] = [];
			for await (const event of stream) {
				events.push(event);
			}

			expect(events).toHaveLength(3);
			expect(events[0]).toEqual({ type: "data", value: 1 });
			expect(events[1]).toEqual({ type: "data", value: 2 });
			expect(events[2]).toEqual({ type: "done", result: "complete" });
		});

		it("handles events pushed after iteration starts", async () => {
			const stream = createTestStream();
			const events: TestEvent[] = [];

			const iterationPromise = (async () => {
				for await (const event of stream) {
					events.push(event);
				}
			})();

			// Push events asynchronously
			await Promise.resolve();
			stream.push({ type: "data", value: 1 });
			await Promise.resolve();
			stream.push({ type: "done", result: "async" });

			await iterationPromise;

			expect(events).toHaveLength(2);
			expect(events[0]).toEqual({ type: "data", value: 1 });
			expect(events[1]).toEqual({ type: "done", result: "async" });
		});
	});

	describe("result()", () => {
		it("resolves with extracted result when stream completes", async () => {
			const stream = createTestStream();

			stream.push({ type: "data", value: 1 });
			stream.push({ type: "done", result: "final result" });

			const result = await stream.result();
			expect(result).toBe("final result");
		});

		it("resolves with result from end() if provided", async () => {
			const stream = createTestStream();

			stream.push({ type: "data", value: 1 });
			stream.end("manual end");

			const result = await stream.result();
			expect(result).toBe("manual end");
		});
	});

	describe("end()", () => {
		it("stops iteration", async () => {
			const stream = createTestStream();
			const events: TestEvent[] = [];

			const iterationPromise = (async () => {
				for await (const event of stream) {
					events.push(event);
				}
			})();

			stream.push({ type: "data", value: 1 });
			stream.end();

			await iterationPromise;

			expect(events).toHaveLength(1);
		});

		it("ignores pushes after end", async () => {
			const stream = createTestStream();

			stream.push({ type: "data", value: 1 });
			stream.end();
			stream.push({ type: "data", value: 2 }); // Should be ignored

			const events: TestEvent[] = [];
			for await (const event of stream) {
				events.push(event);
			}

			expect(events).toHaveLength(1);
		});
	});

	describe("error()", () => {
		it("rejects result() promise with error", async () => {
			const stream = createTestStream();

			stream.push({ type: "data", value: 1 });
			stream.error(new Error("Stream failed"));

			await expect(stream.result()).rejects.toThrow("Stream failed");
		});

		it("stops iteration on error", async () => {
			const stream = createTestStream();
			const events: TestEvent[] = [];

			const iterationPromise = (async () => {
				for await (const event of stream) {
					events.push(event);
				}
			})();

			stream.push({ type: "data", value: 1 });
			await Promise.resolve();
			stream.error(new Error("Boom"));

			await iterationPromise;
			// Catch the rejected promise to avoid unhandled rejection
			await stream.result().catch(() => {});

			expect(events).toHaveLength(1);
		});
	});

	describe("isDone", () => {
		it("returns false initially", () => {
			const stream = createTestStream();
			expect(stream.isDone).toBe(false);
		});

		it("returns true after completion event", () => {
			const stream = createTestStream();
			stream.push({ type: "done", result: "done" });
			expect(stream.isDone).toBe(true);
		});

		it("returns true after end()", () => {
			const stream = createTestStream();
			stream.end();
			expect(stream.isDone).toBe(true);
		});

		it("returns true after error()", async () => {
			const stream = createTestStream();
			stream.error(new Error("test"));
			expect(stream.isDone).toBe(true);
			// Catch the rejected promise to avoid unhandled rejection
			await stream.result().catch(() => {});
		});
	});
});

describe("createEventStream", () => {
	it("creates a stream where result is the completion event", async () => {
		const stream = createEventStream<TestEvent>(
			(event) => event.type === "done",
		);

		stream.push({ type: "data", value: 1 });
		stream.push({ type: "done", result: "final" });

		const result = await stream.result();
		expect(result).toEqual({ type: "done", result: "final" });
	});
});
