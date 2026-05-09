import { afterEach, describe, expect, it, vi } from "vitest";
import { printHelp } from "../../src/cli/help.js";

describe("printHelp", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not show hidden support flags by default", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		printHelp("0.0.0");

		const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
		expect(output).not.toContain("--legacy-runtime");
		expect(output).not.toContain("Hidden Support Flags");
	});

	it("does not expose internal cutover controls in hidden help", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		printHelp("0.0.0", { hidden: true });

		const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
		expect(output).not.toContain("Hidden Support Flags");
		expect(output).not.toContain("--legacy-runtime");
	});
});
