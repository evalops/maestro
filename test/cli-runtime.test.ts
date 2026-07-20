import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getDirectRuntimeCommand,
	getRuntimeCommand,
	shouldAttemptDirectRuntimeDispatch,
	shouldUseUnbundledMainRuntime,
} from "../src/cli/direct-runtime-command.js";
import { buildNativeHostedRunnerArgs } from "../src/cli/native-tui-launcher.js";
import { createLoadEnvModuleMock } from "./helpers/load-env-mock.js";

describe("cli-runtime direct command dispatch", () => {
	const originalExitCode = process.exitCode;
	it("preserves hosted-runner address overrides when applying a global port", () => {
		expect(buildNativeHostedRunnerArgs([], 8080)).toEqual([
			"hosted-runner",
			"--port",
			"8080",
		]);
		expect(
			buildNativeHostedRunnerArgs(["--listen", "0.0.0.0:9090"], 8080),
		).toEqual(["hosted-runner", "--listen", "0.0.0.0:9090"]);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
		vi.doUnmock("../src/cli/commands/skill.js");
		vi.doUnmock("../src/cli/commands/hosted-runner.js");
		vi.doUnmock("../src/cli/native-tui-launcher.js");
		vi.doUnmock("../src/load-env.js");
		Reflect.deleteProperty(process.env, "MAESTRO_PROFILE");
		process.exitCode = originalExitCode;
	});

	it("hands hosted-runner off to the native Rust runtime", async () => {
		const launchNativeCli = vi.fn(async () => 0);
		const handleHostedRunnerCommand = vi.fn(async () => undefined);

		vi.doMock("../src/cli/native-tui-launcher.js", () => ({
			buildNativeHostedRunnerArgs,
			launchNativeCli,
		}));
		vi.doMock("../src/cli/commands/hosted-runner.js", () => ({
			handleHostedRunnerCommand,
		}));
		vi.doMock("../src/load-env.js", () => createLoadEnvModuleMock());

		const { runCliCommandRuntime } = await import(
			"../src/cli-command-runtime.js"
		);

		expect(
			await runCliCommandRuntime([
				"hosted-runner",
				"--runner-session-id",
				"mrs_123",
				"--workspace-root",
				"/workspace",
				"--port",
				"9090",
			]),
		).toBe(true);
		expect(launchNativeCli).toHaveBeenCalledWith(
			[
				"hosted-runner",
				"--runner-session-id",
				"mrs_123",
				"--workspace-root",
				"/workspace",
				"--port",
				"9090",
			],
			{ forwardSignals: true },
		);
		expect(handleHostedRunnerCommand).not.toHaveBeenCalled();
	});

	it("preserves a nonzero native hosted-runner exit status", async () => {
		const launchNativeCli = vi.fn(async () => 143);
		vi.doMock("../src/cli/native-tui-launcher.js", () => ({
			buildNativeHostedRunnerArgs,
			launchNativeCli,
		}));
		vi.doMock("../src/load-env.js", () => createLoadEnvModuleMock());

		const { runCliCommandRuntime } = await import(
			"../src/cli-command-runtime.js"
		);

		expect(await runCliCommandRuntime(["hosted-runner"])).toBe(true);
		expect(process.exitCode).toBe(143);
	});

	it("detects early commands after global options", () => {
		expect(getDirectRuntimeCommand(["skill", "--help"])).toBe("skill");
		expect(
			getDirectRuntimeCommand([
				"--profile",
				"local",
				"--model",
				"gpt-5",
				"update",
				"--help",
			]),
		).toBe("update");
	});

	it("does not treat prompt text or global-help commands as the direct dispatch path", () => {
		expect(getDirectRuntimeCommand(["write", "a", "skill"])).toBeNull();
		expect(getDirectRuntimeCommand(["a2a", "--help"])).toBeNull();
		expect(getDirectRuntimeCommand(["context", "--help"])).toBeNull();
		expect(getDirectRuntimeCommand(["status", "--help"])).toBe("status");
	});

	it("hands native utility commands directly to Rust without loading the full runtime", async () => {
		const launchNativeCli = vi.fn(async () => 0);
		vi.doMock("../src/cli/native-tui-launcher.js", () => ({
			buildNativeHostedRunnerArgs,
			launchNativeCli,
		}));
		vi.doMock("../src/load-env.js", () => createLoadEnvModuleMock());

		const { runCliCommandRuntime } = await import(
			"../src/cli-command-runtime.js"
		);

		const cases: Array<[string[], string[]]> = [
			[["status"], ["status"]],
			[
				["hooks", "list"],
				["hooks", "list"],
			],
			[
				["sessions", "export", "session-1", "out.md", "--format", "md"],
				["sessions", "export", "session-1", "out.md", "--format", "md"],
			],
			[
				["export", "session-1", "out.json"],
				["export", "session-1", "out.json"],
			],
			[
				["import", "session.jsonl"],
				["import", "session.jsonl"],
			],
			[
				["cost", "week"],
				["cost", "week"],
			],
			[
				["stats", "month", "--json", "--session", "session-1"],
				["stats", "month", "--json", "--session", "session-1"],
			],
			[
				["--provider", "openai", "models", "providers"],
				["--provider", "openai", "models", "providers"],
			],
		];

		for (const [input, expected] of cases) {
			expect(await runCliCommandRuntime(input)).toBe(true);
			expect(launchNativeCli).toHaveBeenLastCalledWith(expected);
		}
	});

	it("preserves native utility exit status", async () => {
		const launchNativeCli = vi.fn(async () => 2);
		vi.doMock("../src/cli/native-tui-launcher.js", () => ({
			buildNativeHostedRunnerArgs,
			launchNativeCli,
		}));
		vi.doMock("../src/load-env.js", () => createLoadEnvModuleMock());

		const { runCliCommandRuntime } = await import(
			"../src/cli-command-runtime.js"
		);

		expect(await runCliCommandRuntime(["models", "providers"])).toBe(true);
		expect(process.exitCode).toBe(2);
	});

	it("detects exec as the unbundled package main runtime path", () => {
		expect(getRuntimeCommand(["exec", "--json", "Plan work"])).toBe("exec");
		expect(
			getRuntimeCommand([
				"--profile",
				"local",
				"--model",
				"gpt-5",
				"exec",
				"--json",
				"Plan work",
			]),
		).toBe("exec");
		expect(shouldUseUnbundledMainRuntime(["exec", "--json"])).toBe(true);
		expect(shouldUseUnbundledMainRuntime(["skill", "--help"])).toBe(false);
		expect(shouldUseUnbundledMainRuntime(["write", "exec docs"])).toBe(false);
	});

	it("falls back to the full runtime when startup telemetry is configured", () => {
		expect(
			shouldAttemptDirectRuntimeDispatch(["skill", "--help"], {
				MAESTRO_BEACON_FILE: "/tmp/maestro-beacon.jsonl",
			}),
		).toBe(false);
		expect(
			shouldAttemptDirectRuntimeDispatch(["skill", "--help"], {
				MAESTRO_TELEMETRY_ENDPOINT: "https://telemetry.example.test",
			}),
		).toBe(false);
		expect(shouldAttemptDirectRuntimeDispatch(["skill", "--help"], {})).toBe(
			true,
		);
	});

	it("falls back to the full runtime for retired auth flags", () => {
		expect(
			shouldAttemptDirectRuntimeDispatch(
				["hosted-runner", "--codex-api-key", "token"],
				{},
			),
		).toBe(false);
		expect(
			shouldAttemptDirectRuntimeDispatch(
				["skill", "--codex-api-key=token"],
				{},
			),
		).toBe(false);
		expect(
			shouldAttemptDirectRuntimeDispatch(["update", "--auth", "chatgpt"], {}),
		).toBe(false);
		expect(
			shouldAttemptDirectRuntimeDispatch(["init", "--auth=claude"], {}),
		).toBe(false);
		expect(shouldAttemptDirectRuntimeDispatch(["skill", "--help"], {})).toBe(
			true,
		);
	});

	it("keeps explicit CLI profiles authoritative through the skill fast path", async () => {
		const handleSkillCommand = vi.fn(async (..._args: unknown[]) => undefined);
		let profileAtInvocation: string | undefined;

		vi.doMock("../src/load-env.js", () =>
			createLoadEnvModuleMock({
				finalizeLoadedEnv: () => {
					Reflect.deleteProperty(process.env, "MAESTRO_PROFILE");
					return {
						loadedEnvKeys: [],
						scrubbedEnvKeys: ["MAESTRO_PROFILE"],
					};
				},
				getLoadedEnvKeys: () => ["MAESTRO_PROFILE"],
			}),
		);
		vi.doMock("../src/cli/commands/skill.js", () => ({
			handleSkillCommand: async (...args: unknown[]) => {
				profileAtInvocation = process.env.MAESTRO_PROFILE;
				return handleSkillCommand(...args);
			},
		}));

		process.env.MAESTRO_PROFILE = "dotenv-profile";

		const { runCliCommandRuntime } = await import(
			"../src/cli-command-runtime.js"
		);

		expect(
			await runCliCommandRuntime([
				"--profile",
				"cli-profile",
				"--config",
				"profile=override-profile",
				"skill",
				"list",
			]),
		).toBe(true);
		expect(profileAtInvocation).toBeUndefined();
		expect(handleSkillCommand).toHaveBeenCalledWith(
			"list",
			[],
			expect.objectContaining({
				profileName: "cli-profile",
				cliOverrides: expect.objectContaining({
					profile: "override-profile",
				}),
			}),
		);
	});
});
