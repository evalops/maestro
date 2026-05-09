import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildFileCitationPromptFragment,
	buildSystemPrompt,
	detectRuntimeConstraintContext,
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

	it("injects file citation guidance into bundled and custom prompts", () => {
		const projectDir = join(testDir, "citation-project");
		mkdirSync(projectDir, { recursive: true });

		const customPrompt = finalizeSystemPrompt(
			"custom base prompt",
			undefined,
			projectDir,
		);
		const exampleUri = `${
			pathToFileURL(join(projectDir, "src/auth/middleware.ts")).href
		}#L42`;

		expect(buildSystemPrompt(undefined, [], undefined, {})).toContain(
			"# File Citations",
		);
		expect(customPrompt).toContain("# File Citations");
		expect(customPrompt).toContain("[src/auth/middleware.ts]");
		expect(customPrompt).toContain(exampleUri);
		expect(customPrompt).not.toContain("file:///workspace/");
		expect(customPrompt).toContain("Bad: See src/auth/middleware.ts");
	});

	it("keeps file citation guidance compact and URI-oriented", () => {
		const fragment = buildFileCitationPromptFragment(testDir);

		expect(fragment).toContain("Markdown");
		expect(fragment).toContain("`file:///` URI");
		expect(fragment).toContain("percent-encode spaces");
		expect(fragment).toContain("repository blob URLs");
		expect(fragment).toContain("#L42-L48");
		expect(fragment.length - testDir.length).toBeLessThan(900);
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

	it("injects sandbox shallow-git runtime guidance", () => {
		const projectDir = join(testDir, "shallow-project");
		mkdirSync(join(projectDir, ".git"), { recursive: true });
		writeFileSync(join(projectDir, ".git", "shallow"), "abc123\n");

		const runtimeConstraints = detectRuntimeConstraintContext({
			cwd: projectDir,
			sandboxMode: "workspace-write",
			env: {},
		});
		const prompt = finalizeSystemPrompt("base prompt", undefined, projectDir, {
			runtimeConstraints,
		});

		expect(prompt).toContain("# Runtime Constraints");
		expect(prompt).toContain("sandbox.shallow-git");
		expect(prompt).toContain("git fetch --unshallow");
	});

	it("detects shallow git checkouts from repository subdirectories", () => {
		const projectDir = join(testDir, "nested-shallow-project");
		const subdir = join(projectDir, "packages", "cli");
		mkdirSync(join(projectDir, ".git"), { recursive: true });
		mkdirSync(subdir, { recursive: true });
		writeFileSync(join(projectDir, ".git", "shallow"), "abc123\n");

		const runtimeConstraints = detectRuntimeConstraintContext({
			cwd: subdir,
			sandboxMode: "workspace-write",
			env: {},
		});

		expect(runtimeConstraints.isShallowGitCheckout).toBe(true);
		expect(
			finalizeSystemPrompt("base prompt", undefined, subdir, {
				runtimeConstraints,
			}),
		).toContain("git fetch --unshallow");
	});

	it("detects shallow git checkouts from linked worktree common dirs", () => {
		const projectDir = join(testDir, "linked-worktree-project");
		const commonGitDir = join(testDir, "common-git");
		const worktreeGitDir = join(commonGitDir, "worktrees", "linked");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(worktreeGitDir, { recursive: true });
		writeFileSync(join(projectDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
		writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
		writeFileSync(join(commonGitDir, "shallow"), "abc123\n");

		const runtimeConstraints = detectRuntimeConstraintContext({
			cwd: projectDir,
			sandboxMode: "workspace-write",
			env: {},
		});

		expect(runtimeConstraints.isShallowGitCheckout).toBe(true);
		expect(
			finalizeSystemPrompt("base prompt", undefined, projectDir, {
				runtimeConstraints,
			}),
		).toContain("git fetch --unshallow");
	});

	it("trims trailing whitespace from gitdir worktree files", () => {
		const projectDir = join(testDir, "spaced-worktree-project");
		const commonGitDir = join(testDir, "spaced-common-git");
		const worktreeGitDir = join(commonGitDir, "worktrees", "spaced");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(worktreeGitDir, { recursive: true });
		writeFileSync(join(projectDir, ".git"), `gitdir: ${worktreeGitDir} \t\n`);
		writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
		writeFileSync(join(commonGitDir, "shallow"), "abc123\n");

		expect(
			detectRuntimeConstraintContext({
				cwd: projectDir,
				sandboxMode: "workspace-write",
				env: {},
			}).isShallowGitCheckout,
		).toBe(true);
	});

	it("honors MAESTRO_SANDBOX_MODE when detecting sandbox constraints", () => {
		const projectDir = join(testDir, "env-sandbox-project");
		mkdirSync(projectDir, { recursive: true });

		const runtimeConstraints = detectRuntimeConstraintContext({
			cwd: projectDir,
			env: { MAESTRO_SANDBOX_MODE: "workspace-write" },
		});

		expect(runtimeConstraints.sandboxMode).toBe("workspace-write");
		expect(
			finalizeSystemPrompt("base prompt", undefined, projectDir, {
				runtimeConstraints,
			}),
		).toContain("sandbox.filesystem");
	});

	it("prefers sandbox policy env over backend marker env", () => {
		const projectDir = join(testDir, "policy-env-project");
		mkdirSync(projectDir, { recursive: true });

		const runtimeConstraints = detectRuntimeConstraintContext({
			cwd: projectDir,
			env: {
				MAESTRO_SANDBOX: "seatbelt",
				MAESTRO_SANDBOX_MODE: "read-only",
			},
		});

		expect(runtimeConstraints.sandboxMode).toBe("read-only");
		expect(
			finalizeSystemPrompt("base prompt", undefined, projectDir, {
				runtimeConstraints,
			}),
		).toContain("checkout.read-only");
	});

	it("preserves explicit no-sandbox state over sandbox env fallback", () => {
		const projectDir = join(testDir, "resolved-none-project");
		mkdirSync(projectDir, { recursive: true });

		const runtimeConstraints = detectRuntimeConstraintContext({
			cwd: projectDir,
			sandboxMode: "none",
			sandboxEnabled: false,
			env: { MAESTRO_SANDBOX_MODE: "read-only" },
		});

		const prompt = finalizeSystemPrompt("base prompt", undefined, projectDir, {
			runtimeConstraints,
		});

		expect(runtimeConstraints.sandboxMode).toBe("none");
		expect(prompt).not.toContain("checkout.read-only");
		expect(prompt).not.toContain("# Runtime Constraints");
	});

	it("injects offline-eval runtime guidance and skips fragments by default", () => {
		const projectDir = join(testDir, "offline-project");
		mkdirSync(projectDir, { recursive: true });

		const offlinePrompt = finalizeSystemPrompt(
			"base prompt",
			undefined,
			projectDir,
			{
				runtimeConstraints: detectRuntimeConstraintContext({
					cwd: projectDir,
					env: { MAESTRO_OFFLINE_EVAL: "1" },
				}),
			},
		);
		const defaultPrompt = finalizeSystemPrompt(
			"base prompt",
			undefined,
			projectDir,
			{
				runtimeConstraints: detectRuntimeConstraintContext({
					cwd: projectDir,
					env: {},
				}),
			},
		);

		expect(offlinePrompt).toContain("network.offline");
		expect(offlinePrompt).toContain("skip web search");
		expect(offlinePrompt).toContain("network requests are expected to fail");
		expect(defaultPrompt).not.toContain("# Runtime Constraints");
	});
});
