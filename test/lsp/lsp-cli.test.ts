import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("lsp cli", () => {
	it("uses maestro branding in help output", () => {
		const result = spawnSync("bun", ["run", "./src/lsp/cli.ts", "help"], {
			cwd: process.cwd(),
			encoding: "utf-8",
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("Usage: maestro-lsp <command> [options]");
		expect(result.stdout).toContain("maestro-lsp diagnostics src/main.ts");
		expect(result.stdout).not.toContain("composer-lsp");
	});
});
