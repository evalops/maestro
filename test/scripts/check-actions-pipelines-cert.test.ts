import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("check-actions-pipelines-cert", () => {
	it("runs and prints JSON summary for the pipelines host", () => {
		const result = spawnSync(
			process.execPath,
			[
				"scripts/check-actions-pipelines-cert.mjs",
				"--warn-days",
				"3650",
				"--fail-days",
				"0",
			],
			{ cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
		);
		// Exit 0 (ok), 1 (near expiry), or 2 (expired) are all "script worked"
		expect([0, 1, 2]).toContain(result.status ?? -1);
		expect(result.stdout + result.stderr).toMatch(
			/pipelines\.actions\.githubusercontent\.com|notAfter|daysLeft/,
		);
	});
});
