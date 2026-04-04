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

	it("respects maxCharsPerSource even when the suffix is longer", async () => {
		const long = "a".repeat(120);
		const maxCharsPerSource = 5;

		const manager = new AgentContextManager({ maxCharsPerSource });
		manager.addSource(makeSource("tiny", async () => long));

		const result = await manager.getCombinedSystemPrompt();

		expect(result.length).toBeLessThanOrEqual(maxCharsPerSource);
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

	it("caches session-scoped sources across calls", async () => {
		const load = vi.fn(async () => "stable-context");
		const manager = new AgentContextManager();
		manager.addSource({
			name: "stable",
			cacheScope: "session",
			getSystemPromptAdditions: () => load(),
		});

		const first = await manager.getCombinedSystemPromptWithStatus();
		const second = await manager.getCombinedSystemPromptWithStatus();

		expect(first.prompt).toBe("stable-context");
		expect(second.prompt).toBe("stable-context");
		expect(load).toHaveBeenCalledTimes(1);
		expect(second.sourceStatuses[0]).toMatchObject({
			name: "stable",
			status: "success",
			cached: true,
			durationMs: 0,
		});
	});

	it("caches null results for session-scoped sources", async () => {
		const load = vi.fn(async () => null);
		const manager = new AgentContextManager();
		manager.addSource({
			name: "empty-stable",
			cacheScope: "session",
			getSystemPromptAdditions: () => load(),
		});

		const first = await manager.getCombinedSystemPromptWithStatus();
		const second = await manager.getCombinedSystemPromptWithStatus();

		expect(first.prompt).toBe("");
		expect(second.prompt).toBe("");
		expect(load).toHaveBeenCalledTimes(1);
		expect(second.sourceStatuses[0]).toMatchObject({
			name: "empty-stable",
			status: "empty",
			cached: true,
			durationMs: 0,
		});
	});

	it("does not cache session-scoped source failures", async () => {
		const load = vi
			.fn<() => Promise<string | null>>()
			.mockRejectedValueOnce(new Error("transient failure"))
			.mockResolvedValueOnce("recovered-context");
		const manager = new AgentContextManager();
		manager.addSource({
			name: "unstable",
			cacheScope: "session",
			getSystemPromptAdditions: () => load(),
		});

		const first = await manager.getCombinedSystemPromptWithStatus();
		const second = await manager.getCombinedSystemPromptWithStatus();

		expect(first.prompt).toBe("");
		expect(first.failureCount).toBe(1);
		expect(first.sourceStatuses[0]).toMatchObject({
			name: "unstable",
			status: "error",
			cached: false,
		});
		expect(second.prompt).toBe("recovered-context");
		expect(second.sourceStatuses[0]).toMatchObject({
			name: "unstable",
			status: "success",
			cached: false,
		});
		expect(load).toHaveBeenCalledTimes(2);
	});
});
