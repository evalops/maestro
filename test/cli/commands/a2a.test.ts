import { describe, expect, it } from "vitest";
import {
	isA2AWaitCompletionState,
	parseA2AArgs,
} from "../../../src/cli/commands/a2a.js";

describe("A2A CLI command helpers", () => {
	it("preserves unknown -- tokens as message text", () => {
		const parsed = parseA2AArgs([
			"send",
			"mac-mini",
			"review",
			"--help",
			"and",
			"--dry-run",
		]);

		expect(parsed.positionals).toEqual([
			"send",
			"mac-mini",
			"review",
			"--help",
			"and",
			"--dry-run",
		]);
		expect(parsed.flags.has("--help")).toBe(false);
		expect(parsed.flags.has("--dry-run")).toBe(false);
	});

	it("preserves known option-looking text after an explicit delimiter", () => {
		const parsed = parseA2AArgs([
			"send",
			"mac-mini",
			"--",
			"--wait",
			"--timeout-ms=1000",
		]);

		expect(parsed.positionals).toEqual([
			"send",
			"mac-mini",
			"--wait",
			"--timeout-ms=1000",
		]);
		expect(parsed.flags.size).toBe(0);
	});

	it("still parses known send flags", () => {
		const parsed = parseA2AArgs([
			"send",
			"mac-mini",
			"ping",
			"--wait",
			"--timeout-ms",
			"1000",
		]);

		expect(parsed.positionals).toEqual(["send", "mac-mini", "ping"]);
		expect(parsed.flags.get("--wait")).toBe(true);
		expect(parsed.flags.get("--timeout-ms")).toBe("1000");
	});

	it("treats actionable A2A states as wait completion", () => {
		expect(isA2AWaitCompletionState("completed")).toBe(true);
		expect(isA2AWaitCompletionState("input-required")).toBe(true);
		expect(isA2AWaitCompletionState("AUTH_REQUIRED")).toBe(true);
		expect(isA2AWaitCompletionState("working")).toBe(false);
		expect(isA2AWaitCompletionState("submitted")).toBe(false);
	});
});
