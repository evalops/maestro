import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../src/cli/system-prompt.js";
import { clearConfigCache } from "../../src/config/index.js";

describe("buildSystemPrompt", () => {
	let originalCwd: string;
	let originalHome: string | undefined;
	let testDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		originalHome = process.env.MAESTRO_HOME;
		testDir = join(tmpdir(), `maestro-system-prompt-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		process.chdir(testDir);

		const maestroHome = join(testDir, "maestro-home");
		mkdirSync(maestroHome, { recursive: true });
		process.env.MAESTRO_HOME = maestroHome;
		clearConfigCache();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (originalHome === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_HOME");
		} else {
			process.env.MAESTRO_HOME = originalHome;
		}
		clearConfigCache();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("includes numeric length anchors in the default guidelines", () => {
		const prompt = buildSystemPrompt(undefined, []);

		expect(prompt).toContain(
			"Length limits: keep text between tool calls to <=25 words. Keep final responses to <=100 words unless the task requires more detail.",
		);
	});
});
