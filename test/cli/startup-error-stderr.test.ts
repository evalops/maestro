import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("interactive startup errors", () => {
	it("prints fatal startup errors to stderr after TUI log redirection", () => {
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"./src/cli.ts",
				"--provider",
				"definitely-missing-provider",
			],
			{
				cwd: repoRoot,
				env: {
					...process.env,
					NO_COLOR: "1",
				},
				encoding: "utf8",
				timeout: 60000,
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			'Unknown provider "definitely-missing-provider"',
		);
	});
});
