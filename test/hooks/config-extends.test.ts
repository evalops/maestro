import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearHookConfigCache,
	getMatchingHooks,
	loadHookConfiguration,
} from "../../src/hooks/index.js";
import type { PreToolUseHookInput } from "../../src/hooks/types.js";
import { withEnv } from "../utils/env.js";

describe("hooks/config extends", () => {
	const originalPreToolUse = process.env.MAESTRO_HOOKS_PRE_TOOL_USE;
	let homeDir: string;
	let workspaceDir: string;

	beforeEach(() => {
		clearHookConfigCache();
		homeDir = join(tmpdir(), `composer-hooks-home-${Date.now()}`);
		workspaceDir = join(tmpdir(), `composer-hooks-workspace-${Date.now()}`);
		mkdirSync(join(homeDir, ".maestro"), { recursive: true });
		mkdirSync(join(workspaceDir, ".maestro"), { recursive: true });
	});

	afterEach(() => {
		clearHookConfigCache();
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

	it("resolves local extends and allows later overrides by matcher", () =>
		withEnv(
			{
				HOME: homeDir,
				MAESTRO_HOOKS_PRE_TOOL_USE: originalPreToolUse,
			},
			() => {
				const projectDir = join(workspaceDir, ".maestro");

				writeFileSync(
					join(projectDir, "preset.json"),
					JSON.stringify(
						{
							hooks: {
								PreToolUse: [
									{
										matcher: "*",
										hooks: [
											{ type: "command", command: "./scripts/preset.sh" },
										],
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
										hooks: [
											{ type: "command", command: "./scripts/override.sh" },
										],
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
				expect(hooks[0]!.type).toBe("command");
				const hook = hooks[0] as { type: "command"; command: string };
				expect(hook.command).toBe(resolve(projectDir, "scripts/override.sh"));
			},
		));

	it("resolves extends from a node module package (hooks.json in package root)", () =>
		withEnv(
			{
				HOME: homeDir,
				MAESTRO_HOOKS_PRE_TOOL_USE: originalPreToolUse,
			},
			() => {
				const nodeModules = join(
					workspaceDir,
					"node_modules",
					"test-hook-preset",
				);
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
										hooks: [
											{ type: "command", command: "./scripts/preset.sh" },
										],
									},
								],
							},
						},
						null,
						2,
					),
				);

				writeFileSync(
					join(workspaceDir, ".maestro", "hooks.json"),
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
				expect(hooks[0]!.type).toBe("command");
				const hook = hooks[0] as { type: "command"; command: string };
				expect(normalizeDarwinTmpPath(hook.command)).toBe(
					normalizeDarwinTmpPath(resolve(nodeModules, "scripts/preset.sh")),
				);
			},
		));

	it("user hooks.json overrides env hooks when matcher collides", () =>
		withEnv(
			{
				HOME: homeDir,
				MAESTRO_HOOKS_PRE_TOOL_USE: "env.sh",
			},
			() => {
				writeFileSync(
					join(homeDir, ".maestro", "hooks.json"),
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
				expect(hooks[0]!.type).toBe("command");
				const hook = hooks[0] as { type: "command"; command: string };
				expect(hook.command).toBe("user.sh");
			},
		));
});
