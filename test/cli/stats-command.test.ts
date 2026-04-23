import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleStatsCommand } from "../../src/cli/commands/stats.js";
import { clearUsage, trackUsage } from "../../src/tracking/cost-tracker.js";

describe("handleStatsCommand", () => {
	let testDir: string;
	let originalUsageFile: string | undefined;
	let output: string[];

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "maestro-stats-test-"));
		originalUsageFile = process.env.MAESTRO_USAGE_FILE;
		process.env.MAESTRO_USAGE_FILE = join(testDir, "usage.json");
		clearUsage();
		output = [];
		vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
			output.push(String(message ?? ""));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalUsageFile === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_USAGE_FILE");
		} else {
			process.env.MAESTRO_USAGE_FILE = originalUsageFile;
		}
		rmSync(testDir, { recursive: true, force: true });
	});

	it("shows last seven days by default with session breakdown", async () => {
		trackUsage({
			sessionId: "session-a",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			tokensInput: 1000,
			tokensOutput: 500,
			cost: 0.015,
		});

		await handleStatsCommand();

		const text = output.join("\n");
		expect(text).toContain("Usage Stats (Last 7 Days)");
		expect(text).toContain("Requests");
		expect(text).toContain("Top Sessions");
		expect(text).toContain("session-a");
	});

	it("shows one session across all time by default", async () => {
		trackUsage({
			sessionId: "session-a",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			tokensInput: 1000,
			tokensOutput: 500,
			cost: 0.015,
		});
		trackUsage({
			sessionId: "session-b",
			provider: "openai",
			model: "gpt-4o",
			tokensInput: 200,
			tokensOutput: 100,
			cost: 0.003,
		});

		await handleStatsCommand(undefined, { sessionId: "session-a" });

		const text = output.join("\n");
		expect(text).toContain("Usage Stats (All Time, Session session-a)");
		expect(text).toContain("claude-sonnet-4-5");
		expect(text).not.toContain("gpt-4o");
		expect(text).not.toContain("Top Sessions");
	});

	it("exports session stats as json", async () => {
		trackUsage({
			sessionId: "session-a",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			tokensInput: 1000,
			tokensOutput: 500,
			cost: 0.015,
		});

		await handleStatsCommand(undefined, {
			sessionId: "session-a",
			format: "json",
		});

		const exported = JSON.parse(output.join("\n"));
		expect(exported.entries).toHaveLength(1);
		expect(exported.entries[0].sessionId).toBe("session-a");
	});
});
