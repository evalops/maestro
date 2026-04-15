import { describe, expect, it, vi } from "vitest";
import { runGuardianCli } from "../../src/guardian/cli.js";

describe("guardian cli", () => {
	it("prints maestro-branded help", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await expect(runGuardianCli(["--help"])).resolves.toBe(0);
		const combined = logSpy.mock.calls
			.map((args) => args.map((arg) => String(arg)).join(" "))
			.join("\n");
		expect(combined).toContain("Maestro Guardian");
		expect(combined).not.toContain("Composer Guardian");
		logSpy.mockRestore();
	});
});
