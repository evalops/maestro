import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("interactive startup errors", () => {
	it("prints native TUI binary resolution errors to stderr", () => {
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", "./src/cli.ts", "--provider", "openai"],
			{
				cwd: repoRoot,
				env: {
					...process.env,
					NO_COLOR: "1",
					// Force a missing override so interactive handoff fails fast
					// without requiring a built maestro-tui or network auth.
					MAESTRO_TUI_BIN: "/nonexistent/maestro-tui-for-tests",
				},
				encoding: "utf8",
				timeout: 60000,
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("MAESTRO_TUI_BIN is set");
		expect(result.stderr).toContain("/nonexistent/maestro-tui-for-tests");
	});
});
