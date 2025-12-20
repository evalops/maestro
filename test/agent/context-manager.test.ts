import { describe, expect, it, vi } from "vitest";
import { AgentContextManager } from "../../src/agent/context-manager.js";

const makeSource = (
	name: string,
	fn: (signal?: AbortSignal) => Promise<string | null>,
) => ({
	name,
	getSystemPromptAdditions: ({ signal }: { signal?: AbortSignal } = {}) =>
		fn(signal),
});

describe("AgentContextManager", () => {
	it("combines enabled sources and skips disabled ones", async () => {
		const manager = new AgentContextManager({
			enabledSources: ["keep"],
		});
		manager.addSource(makeSource("keep", async () => "kept"));
		manager.addSource(makeSource("skip", async () => "skipped"));

		const result = await manager.getCombinedSystemPrompt();

		expect(result).toContain("kept");
		expect(result).not.toContain("skipped");
	});

	it("truncates sources without exceeding maxCharsPerSource", async () => {
		const long = "a".repeat(120);
		const maxCharsPerSource = 50;

		const manager = new AgentContextManager({ maxCharsPerSource });
		manager.addSource(makeSource("long", async () => long));

		const result = await manager.getCombinedSystemPrompt();

		expect(result.length).toBeLessThanOrEqual(maxCharsPerSource);
		expect(result).toContain("[truncated ");
	});

	it("times out slow sources and still returns other results", async () => {
		vi.useFakeTimers();
		try {
			const manager = new AgentContextManager({ sourceTimeoutMs: 100 });

			manager.addSource(makeSource("fast", async () => "fast-ok"));
			manager.addSource(
				makeSource(
					"slow",
					(signal) =>
						new Promise((resolve, reject) => {
							const timer = setTimeout(() => resolve("too late"), 5_000);
							if (signal) {
								signal.addEventListener("abort", () => {
									clearTimeout(timer);
									reject(signal.reason ?? new Error("aborted"));
								});
							}
						}),
				),
			);

			const resultPromise = manager.getCombinedSystemPrompt();
			await vi.advanceTimersByTimeAsync(100);
			const result = await resultPromise;

			expect(result).toBe("fast-ok");
		} finally {
			vi.useRealTimers();
		}
	});
});
