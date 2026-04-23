import { describe, expect, it } from "vitest";
import {
	createCheckpointProfiler,
	createQueryProfilerFromEnv,
	createStartupProfilerFromEnv,
} from "../../src/utils/checkpoint-profiler.js";

describe("checkpoint profiler", () => {
	it("is a no-op when disabled", () => {
		const lines: string[] = [];
		const profiler = createCheckpointProfiler({
			scope: "query",
			enabled: false,
			sink: (line) => lines.push(line),
		});

		profiler.checkpoint("input:received");
		profiler.terminal("turn:complete");

		expect(profiler.enabled).toBe(false);
		expect(lines).toEqual([]);
	});

	it("formats ordered checkpoint elapsed and delta timings", () => {
		const lines: string[] = [];
		let now = 100;
		const profiler = createCheckpointProfiler({
			scope: "query",
			enabled: true,
			now: () => now,
			sink: (line) => lines.push(line),
		});

		profiler.checkpoint("input:received");
		now = 112;
		profiler.checkpoint("context:loaded");
		now = 139;
		profiler.terminal("turn:complete", { tool_results: 2 });

		expect(lines).toEqual([
			"[query] 0ms input:received",
			"[query] 12ms context:loaded (+12ms)",
			"[query] 39ms turn:complete (+27ms, tool_results=2)",
		]);
	});

	it("emits a terminal checkpoint only once", () => {
		const lines: string[] = [];
		let now = 0;
		const profiler = createCheckpointProfiler({
			scope: "query",
			enabled: true,
			now: () => now,
			sink: (line) => lines.push(line),
		});

		profiler.checkpoint("input:received");
		now = 5;
		profiler.terminal("turn:error");
		now = 10;
		profiler.terminal("turn:complete");

		expect(lines).toEqual([
			"[query] 0ms input:received",
			"[query] 5ms turn:error (+5ms)",
		]);
	});

	it("includes optional memory snapshots for startup profiling", () => {
		const lines: string[] = [];
		const profiler = createStartupProfilerFromEnv({
			env: { MAESTRO_STARTUP_PROFILE: "1" },
			now: () => 0,
			memoryUsage: () => ({ rss: 64 * 1024 * 1024 }),
			sink: (line) => lines.push(line),
		});

		profiler.checkpoint("process:start");

		expect(lines).toEqual(["[startup] 0ms process:start (rss=64.0MiB)"]);
	});

	it("redacts prompt, token, and free-form detail values", () => {
		const lines: string[] = [];
		const profiler = createCheckpointProfiler({
			scope: "query",
			enabled: true,
			now: () => 0,
			sink: (line) => lines.push(line),
		});

		profiler.checkpoint("prompt:assembled", {
			model: "gpt-5.4",
			prompt: "ship the private thing",
			token: "npm_secret",
			freeform: "contains whitespace user text",
		});

		expect(lines[0]).toContain("model=gpt-5.4");
		expect(lines[0]).toContain("prompt=[redacted]");
		expect(lines[0]).toContain("token=[redacted]");
		expect(lines[0]).toContain("freeform=[redacted]");
		expect(lines[0]).not.toContain("ship the private thing");
		expect(lines[0]).not.toContain("npm_secret");
		expect(lines[0]).not.toContain("contains whitespace user text");
	});

	it("uses MAESTRO_QUERY_PROFILE to enable query profiling", () => {
		const lines: string[] = [];
		const profiler = createQueryProfilerFromEnv({
			env: { MAESTRO_QUERY_PROFILE: "yes" },
			now: () => 0,
			sink: (line) => lines.push(line),
		});

		profiler.checkpoint("input:received");

		expect(profiler.enabled).toBe(true);
		expect(lines).toEqual(["[query] 0ms input:received"]);
	});
});
