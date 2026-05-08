import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildSystemPrompt,
	finalizeSystemPrompt,
	resolveExplicitSystemPromptSourcePaths,
} from "../../src/cli/system-prompt.js";
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

	it("returns exact paths for explicit prompt files only", () => {
		const promptsDir = join(testDir, "prompts");
		const systemPromptPath = join(promptsDir, "system.md");
		const appendPromptPath = join(promptsDir, "append.md");
		mkdirSync(promptsDir, { recursive: true });
		writeFileSync(systemPromptPath, "custom system prompt");
		writeFileSync(appendPromptPath, "append system prompt");

		expect(
			resolveExplicitSystemPromptSourcePaths(
				systemPromptPath,
				appendPromptPath,
			),
		).toEqual([systemPromptPath, appendPromptPath]);
		expect(
			resolveExplicitSystemPromptSourcePaths(
				"inline instructions",
				appendPromptPath,
			),
		).toEqual([appendPromptPath]);
	});

	it("loads project context files from the provided cwd", () => {
		const projectDir = join(testDir, "project");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "AGENTS.md"), "project specific context");

		const prompt = finalizeSystemPrompt("base prompt", undefined, projectDir);

		expect(prompt).toContain("project specific context");
		expect(prompt).toContain(`Current working directory: ${projectDir}`);
	});

	it("warns the agent when the workspace contains guarded path categories", () => {
		const projectDir = join(testDir, "guarded-project");
		mkdirSync(join(projectDir, ".idea"), { recursive: true });
		mkdirSync(join(projectDir, ".ssh"), { recursive: true });
		writeFileSync(join(projectDir, ".idea", "workspace.xml"), "<project />");
		writeFileSync(join(projectDir, ".ssh", "id_ed25519"), "private key");

		const prompt = finalizeSystemPrompt("base prompt", undefined, projectDir);

		expect(prompt).toContain("# Guarded Workspace Paths");
		expect(prompt).toContain("JetBrains project configuration");
		expect(prompt).toContain("SSH and GPG keys");
		expect(prompt).toContain("Ask for explicit user approval");
		expect(prompt).not.toContain("workspace.xml");
		expect(prompt).not.toContain("id_ed25519");
		expect(prompt).not.toContain("**/.ssh/**");
	});

	it("omits guarded workspace guidance when no guarded paths are present", () => {
		const projectDir = join(testDir, "ordinary-project");
		mkdirSync(join(projectDir, "src"), { recursive: true });
		writeFileSync(join(projectDir, "src", "index.ts"), "export {};");

		const prompt = finalizeSystemPrompt("base prompt", undefined, projectDir);

		expect(prompt).not.toContain("# Guarded Workspace Paths");
	});
});
