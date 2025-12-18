import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearHookConfigCache,
	getMatchingHooks,
	loadHookConfiguration,
} from "../../src/hooks/index.js";
import type { PreToolUseHookInput } from "../../src/hooks/types.js";

describe("hooks/config extends", () => {
	const originalHome = process.env.HOME;
	let homeDir: string;
	let workspaceDir: string;

	beforeEach(() => {
		clearHookConfigCache();
		vi.unstubAllEnvs();

		homeDir = join(tmpdir(), `composer-hooks-home-${Date.now()}`);
		workspaceDir = join(tmpdir(), `composer-hooks-workspace-${Date.now()}`);
		process.env.HOME = homeDir;
		mkdirSync(join(homeDir, ".composer"), { recursive: true });
		mkdirSync(join(workspaceDir, ".composer"), { recursive: true });
	});

	afterEach(() => {
		clearHookConfigCache();
		process.env.HOME = originalHome;
		if (existsSync(homeDir)) rmSync(homeDir, { recursive: true, force: true });
		if (existsSync(workspaceDir))
			rmSync(workspaceDir, { recursive: true, force: true });
	});

	function matchInput(): PreToolUseHookInput {
		return {
			hook_event_name: "PreToolUse",
			cwd: workspaceDir,
			timestamp: new Date().toISOString(),
			tool_name: "bash",
			tool_call_id: "1",
			tool_input: {},
		};
	}

	function normalizeDarwinTmpPath(path: string): string {
		return path.replace(/^\/private(\/var\/)/, "/var/");
	}

	it("resolves local extends and allows later overrides by matcher", () => {
		const projectDir = join(workspaceDir, ".composer");

		writeFileSync(
			join(projectDir, "preset.json"),
			JSON.stringify(
				{
					hooks: {
						PreToolUse: [
							{
								matcher: "*",
								hooks: [{ type: "command", command: "./scripts/preset.sh" }],
							},
						],
					},
				},
				null,
				2,
			),
		);

		writeFileSync(
			join(projectDir, "hooks.json"),
			JSON.stringify(
				{
					extends: ["./preset.json"],
					hooks: {
						PreToolUse: [
							{
								matcher: "*",
								hooks: [{ type: "command", command: "./scripts/override.sh" }],
							},
						],
					},
				},
				null,
				2,
			),
		);

		const config = loadHookConfiguration(workspaceDir);
		const hooks = getMatchingHooks(config, matchInput());
		expect(hooks).toHaveLength(1);
		expect(hooks[0].type).toBe("command");
		expect(hooks[0].command).toBe(resolve(projectDir, "scripts/override.sh"));
	});

	it("resolves extends from a node module package (hooks.json in package root)", () => {
		const nodeModules = join(workspaceDir, "node_modules", "test-hook-preset");
		mkdirSync(nodeModules, { recursive: true });

		writeFileSync(
			join(nodeModules, "package.json"),
			JSON.stringify({ name: "test-hook-preset", version: "1.0.0" }),
		);
		writeFileSync(
			join(nodeModules, "hooks.json"),
			JSON.stringify(
				{
					hooks: {
						PreToolUse: [
							{
								matcher: "bash",
								hooks: [{ type: "command", command: "./scripts/preset.sh" }],
							},
						],
					},
				},
				null,
				2,
			),
		);

		writeFileSync(
			join(workspaceDir, ".composer", "hooks.json"),
			JSON.stringify(
				{
					extends: ["test-hook-preset"],
				},
				null,
				2,
			),
		);

		const config = loadHookConfiguration(workspaceDir);
		const hooks = getMatchingHooks(config, matchInput());
		expect(hooks).toHaveLength(1);
		expect(hooks[0].type).toBe("command");
		expect(normalizeDarwinTmpPath(hooks[0].command)).toBe(
			normalizeDarwinTmpPath(resolve(nodeModules, "scripts/preset.sh")),
		);
	});

	it("user hooks.json overrides env hooks when matcher collides", () => {
		vi.stubEnv("COMPOSER_HOOKS_PRE_TOOL_USE", "env.sh");

		writeFileSync(
			join(homeDir, ".composer", "hooks.json"),
			JSON.stringify(
				{
					hooks: {
						PreToolUse: [
							{
								matcher: "*",
								hooks: [{ type: "command", command: "user.sh" }],
							},
						],
					},
				},
				null,
				2,
			),
		);

		const config = loadHookConfiguration(workspaceDir);
		const hooks = getMatchingHooks(config, matchInput());
		expect(hooks).toHaveLength(1);
		expect(hooks[0].type).toBe("command");
		expect(hooks[0].command).toBe("user.sh");
	});
});
