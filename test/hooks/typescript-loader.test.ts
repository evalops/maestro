import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearHookConfigCache,
	clearLoadedTypeScriptHooks,
	discoverAndLoadTypeScriptHooks,
	executeHooks,
} from "../../src/hooks/index.js";
import type { SessionBeforeTreeHookInput } from "../../src/hooks/types.js";

describe("TypeScript hook loader", () => {
	let testDir: string;
	let previousHome: string | undefined;

	afterEach(() => {
		clearHookConfigCache();
		clearLoadedTypeScriptHooks();
		process.env.HOME = previousHome ?? "";
		delete process.env.MAESTRO_HOME;
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

	it("routes SessionBeforeTree TypeScript hook outputs through executeHooks", async () => {
		testDir = mkdtempSync(join(tmpdir(), "composer-ts-hooks-"));
		process.env.MAESTRO_HOME = join(testDir, ".maestro-home");

		const projectHooksDir = join(testDir, ".maestro", "hooks");
		mkdirSync(projectHooksDir, { recursive: true });
		writeFileSync(
			join(projectHooksDir, "session-before-tree.ts"),
			`export default function (pi) {
  pi.on("SessionBeforeTree", async () => ({
    cancel: true,
    summary: {
      summary: "Use the hook summary",
      details: { source: "ts" }
    }
  }));
}
`,
		);

		await discoverAndLoadTypeScriptHooks([], testDir);

		const input: SessionBeforeTreeHookInput = {
			hook_event_name: "SessionBeforeTree",
			cwd: testDir,
			session_id: "test-session",
			timestamp: new Date().toISOString(),
			preparation: {
				target_id: "target",
				old_leaf_id: "old",
				common_ancestor_id: null,
				entries_to_summarize: [],
				user_wants_summary: true,
			},
		};

		const results = await executeHooks(input, testDir);

		expect(results).toHaveLength(1);
		expect(results[0]?.hookSpecificOutput).toEqual({
			hookEventName: "SessionBeforeTree",
			cancel: true,
			summary: {
				summary: "Use the hook summary",
				details: { source: "ts" },
			},
		});
	});

	it("loads TypeScript hooks from configured package extensions", async () => {
		testDir = mkdtempSync(join(tmpdir(), "composer-ts-hooks-"));
		process.env.MAESTRO_HOME = join(testDir, ".maestro-home");

		const packageDir = join(testDir, "vendor", "hook-pack");
		const extensionDir = join(packageDir, "extensions", "package-hook");
		mkdirSync(extensionDir, { recursive: true });
		mkdirSync(join(testDir, ".maestro"), { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@test/hook-pack",
				keywords: ["maestro-package"],
				maestro: {
					extensions: ["./extensions"],
				},
			}),
		);
		writeFileSync(
			join(extensionDir, "session-start.ts"),
			`export default function (pi) {
  pi.on("SessionStart", async () => ({ continue: true }));
}
`,
		);
		writeFileSync(
			join(testDir, ".maestro", "config.toml"),
			'packages = ["../vendor/hook-pack"]\n',
		);

		const result = await discoverAndLoadTypeScriptHooks([], testDir);

		expect(result.errors).toEqual([]);
		expect(result.hooks).toHaveLength(1);
		expect(result.hooks[0]?.resolvedPath).toContain("session-start.ts");
	});
});
