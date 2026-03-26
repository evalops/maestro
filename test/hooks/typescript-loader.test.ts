import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearLoadedTypeScriptHooks,
	discoverAndLoadTypeScriptHooks,
} from "../../src/hooks/index.js";

describe("TypeScript hook loader", () => {
	let testDir: string;
	let previousHome: string | undefined;

	afterEach(() => {
		clearLoadedTypeScriptHooks();
		process.env.HOME = previousHome ?? "";
		if (testDir) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("normalizes unicode spaces in configured hook paths", async () => {
		testDir = mkdtempSync(join(tmpdir(), "composer-ts-hooks-"));

		// Prevent reading real user hooks from ~/.maestro/hooks.
		previousHome = process.env.HOME;
		process.env.HOME = testDir;

		const hookPath = join(testDir, "my hook.ts");
		writeFileSync(
			hookPath,
			`export default function (pi) {
  pi.on("SessionStart", async () => ({ continue: true }));
}
`,
		);

		const hookPathWithNbsp = join(testDir, "my\u00A0hook.ts");
		const result = await discoverAndLoadTypeScriptHooks(
			[hookPathWithNbsp],
			testDir,
		);

		expect(result.errors).toEqual([]);
		expect(result.hooks).toHaveLength(1);
		expect(result.hooks[0]?.path).toBe(hookPathWithNbsp);
	});
});
