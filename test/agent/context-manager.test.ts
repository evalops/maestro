import { describe, expect, it } from "vitest";
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
		const manager = new AgentContextManager({ sourceTimeoutMs: 20 });

		manager.addSource(makeSource("fast", async () => "fast-ok"));
		manager.addSource(
			makeSource(
				"slow",
				(signal) =>
					new Promise((resolve, reject) => {
						const timer = setTimeout(() => resolve("too late"), 1_000);
						if (signal) {
							signal.addEventListener("abort", () => {
								clearTimeout(timer);
								reject(signal.reason ?? new Error("aborted"));
							});
						}
					}),
			),
		);

		const result = await manager.getCombinedSystemPrompt();

		expect(result).toBe("fast-ok");
	});
});
