import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	TypedEmitter,
	createSlackAgentEmitter,
	createTypedEmitter,
} from "../src/utils/typed-emitter.js";

type TestEvents = {
	message: { text: string };
	count: number;
	empty: undefined;
	error: Error;
};

describe("TypedEmitter", () => {
	let emitter: TypedEmitter<TestEvents>;

	beforeEach(() => {
		emitter = new TypedEmitter<TestEvents>();
	});

	afterEach(() => {
		emitter.removeAllListeners();
	});

	describe("on and emit", () => {
		it("handles events with data", () => {
			const messages: string[] = [];

			emitter.on("message", (data) => {
				messages.push(data.text);
			});

			emitter.emit("message", { text: "hello" });
			emitter.emit("message", { text: "world" });

			expect(messages).toEqual(["hello", "world"]);
		});

		it("handles events with void payload", () => {
			let called = false;

			emitter.on("empty", () => {
				called = true;
			});

			emitter.emit("empty");

			expect(called).toBe(true);
		});

		it("handles events with primitive payload", () => {
			const counts: number[] = [];

			emitter.on("count", (n) => {
				counts.push(n);
			});

			emitter.emit("count", 1);
			emitter.emit("count", 2);
			emitter.emit("count", 3);

			expect(counts).toEqual([1, 2, 3]);
		});

		it("supports multiple handlers for same event", () => {
			const results: string[] = [];

			emitter.on("message", () => results.push("handler1"));
			emitter.on("message", () => results.push("handler2"));

			emitter.emit("message", { text: "test" });

			expect(results).toEqual(["handler1", "handler2"]);
		});

		it("emit returns true when there are listeners", () => {
			emitter.on("message", () => {});
			expect(emitter.emit("message", { text: "test" })).toBe(true);
		});

		it("emit returns false when no listeners", () => {
			expect(emitter.emit("message", { text: "test" })).toBe(false);
		});
	});

	describe("once", () => {
		it("calls handler only once", () => {
			let callCount = 0;

			emitter.once("count", () => {
				callCount++;
			});

			emitter.emit("count", 1);
			emitter.emit("count", 2);
			emitter.emit("count", 3);

			expect(callCount).toBe(1);
		});
	});

	describe("off", () => {
		it("removes specific handler", () => {
			const results: string[] = [];
			const handler1 = () => results.push("handler1");
			const handler2 = () => results.push("handler2");

			emitter.on("message", handler1);
			emitter.on("message", handler2);

			emitter.off("message", handler1);

			emitter.emit("message", { text: "test" });

			expect(results).toEqual(["handler2"]);
		});
	});

	describe("removeAllListeners", () => {
		it("removes all listeners for specific event", () => {
			emitter.on("message", () => {});
			emitter.on("message", () => {});
			emitter.on("count", () => {});

			emitter.removeAllListeners("message");

			expect(emitter.listenerCount("message")).toBe(0);
			expect(emitter.listenerCount("count")).toBe(1);
		});

		it("removes all listeners when no event specified", () => {
			emitter.on("message", () => {});
			emitter.on("count", () => {});

			emitter.removeAllListeners();

			expect(emitter.listenerCount("message")).toBe(0);
			expect(emitter.listenerCount("count")).toBe(0);
		});
	});

	describe("listenerCount", () => {
		it("returns correct count", () => {
			expect(emitter.listenerCount("message")).toBe(0);

			emitter.on("message", () => {});
			expect(emitter.listenerCount("message")).toBe(1);

			emitter.on("message", () => {});
			expect(emitter.listenerCount("message")).toBe(2);
		});
	});

	describe("eventNames", () => {
		it("returns events with listeners", () => {
			emitter.on("message", () => {});
			emitter.on("count", () => {});

			const names = emitter.eventNames();

			expect(names).toContain("message");
			expect(names).toContain("count");
		});
	});

	describe("waitFor", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("resolves when event is emitted", async () => {
			const promise = emitter.waitFor("message");

			// Emit after a delay
			setTimeout(() => {
				emitter.emit("message", { text: "awaited" });
			}, 10);

			await vi.advanceTimersByTimeAsync(10);
			const result = await promise;
			expect(result).toEqual({ text: "awaited" });
		});

		it("rejects on timeout", async () => {
			const promise = emitter.waitFor("message", { timeout: 50 });
			const rejection = expect(promise).rejects.toThrow(
				"Timeout waiting for event",
			);

			await vi.advanceTimersByTimeAsync(50);
			await rejection;
		});

		it("cleans up handler after resolution", async () => {
			const promise = emitter.waitFor("count");

			setTimeout(() => emitter.emit("count", 42), 5);

			await vi.advanceTimersByTimeAsync(5);
			await promise;

			// Listener should be removed
			expect(emitter.listenerCount("count")).toBe(0);
		});
	});

	describe("waitForAny", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("resolves when any event is emitted", async () => {
			const promise = emitter.waitForAny(["message", "count"]);

			setTimeout(() => emitter.emit("count", 42), 5);

			await vi.advanceTimersByTimeAsync(5);
			const result = await promise;
			expect(result).toEqual({ event: "count", data: 42 });
		});

		it("returns the first event emitted", async () => {
			const promise = emitter.waitForAny(["message", "count"]);

			setTimeout(() => emitter.emit("message", { text: "first" }), 5);
			setTimeout(() => emitter.emit("count", 1), 10);

			await vi.advanceTimersByTimeAsync(10);
			const result = await promise;
			expect(result.event).toBe("message");
		});

		it("cleans up handlers after resolution", async () => {
			const promise = emitter.waitForAny(["message", "count"]);

			setTimeout(() => emitter.emit("count", 42), 5);

			await vi.advanceTimersByTimeAsync(5);
			await promise;

			expect(emitter.listenerCount("message")).toBe(0);
			expect(emitter.listenerCount("count")).toBe(0);
		});

		it("rejects on timeout", async () => {
			// Use a fresh emitter to avoid interference from other tests
			const freshEmitter = new TypedEmitter<TestEvents>();
			const promise = freshEmitter.waitForAny(["message", "count"], {
				timeout: 20,
			});
			const rejection = expect(promise).rejects.toThrow(
				"Timeout waiting for events",
			);

			await vi.advanceTimersByTimeAsync(20);
			await rejection;
		});
	});

	describe("pipe", () => {
		it("forwards events to target emitter", () => {
			const target = new TypedEmitter<TestEvents>();
			const received: string[] = [];

			target.on("message", (data) => received.push(data.text));

			const unpipe = emitter.pipe("message", target);

			emitter.emit("message", { text: "piped" });

			expect(received).toEqual(["piped"]);

			// Test unpipe
			unpipe();
			emitter.emit("message", { text: "ignored" });

			expect(received).toEqual(["piped"]);
		});
	});

	describe("chaining", () => {
		it("supports method chaining", () => {
			const results: string[] = [];

			emitter
				.on("message", () => results.push("msg"))
				.on("count", () => results.push("cnt"))
				.once("empty", () => results.push("empty"));

			emitter.emit("message", { text: "" });
			emitter.emit("count", 1);
			emitter.emit("empty");

			expect(results).toEqual(["msg", "cnt", "empty"]);
		});
	});
});

describe("createTypedEmitter", () => {
	it("creates a new typed emitter", () => {
		const emitter = createTypedEmitter<TestEvents>();
		expect(emitter).toBeInstanceOf(TypedEmitter);
	});
});

describe("createSlackAgentEmitter", () => {
	it("creates emitter with Slack agent events", () => {
		const emitter = createSlackAgentEmitter();
		expect(emitter).toBeInstanceOf(TypedEmitter);
	});

	it("handles connected event", () => {
		const emitter = createSlackAgentEmitter();
		let connected = false;

		emitter.on("connected", () => {
			connected = true;
		});

		emitter.emit("connected");

		expect(connected).toBe(true);
	});

	it("handles message event with data", () => {
		const emitter = createSlackAgentEmitter();
		// Use object to track callback assignment
		const state: { received: { text: string; channel: string } | null } = {
			received: null,
		};

		emitter.on("message", (msg) => {
			state.received = msg;
		});

		emitter.emit("message", {
			text: "hello",
			channel: "C123",
			user: "U456",
			ts: "1234567890.123456",
		});

		expect(state.received?.text).toBe("hello");
		expect(state.received?.channel).toBe("C123");
	});

	it("handles error event", () => {
		const emitter = createSlackAgentEmitter();
		let caught: Error | null = null;

		emitter.on("error", (data) => {
			caught = data.error;
		});

		const error = new Error("test error");
		emitter.emit("error", { error, context: "testing" });

		expect(caught).toBe(error);
	});
});
