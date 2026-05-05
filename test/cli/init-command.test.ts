import { describe, expect, it } from "vitest";
import { formatInitHelp, parseInitArgs } from "../../src/cli/commands/init.js";

describe("maestro init command", () => {
	it("renders command-specific help for the one-flow EvalOps bootstrap", () => {
		const help = formatInitHelp();

		expect(help).toContain("maestro init");
		expect(help).toContain(
			"Login, create or reuse an API key, and register this agent",
		);
		expect(help).toContain("--rotate-key");
		expect(help).toContain("--mcp-url <url>");
		expect(help).toContain("--json");
	});

	it("still rejects unknown bootstrap options", () => {
		expect(() => parseInitArgs(["--bogus"])).toThrow(
			"Unknown maestro init option: --bogus",
		);
	});
});
