import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = fileURLToPath(
	new URL(
		"../../scripts/check-guardrail-regression-suite.mjs",
		import.meta.url,
	),
);

describe("check-guardrail-regression-suite entrypoint", () => {
	it("runs main when invoked directly", () => {
		const output = execFileSync(process.execPath, [scriptPath], {
			cwd: repoRoot,
			encoding: "utf8",
		});

		expect(output).toContain("Guardrail regression suite covers");
	});
});
