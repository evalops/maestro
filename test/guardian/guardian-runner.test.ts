vi.mock("node:child_process", () => {
	return {
		spawnSync: vi.fn(),
	};
});

vi.mock("../../src/guardian/config.js", () => {
	const DEFAULT_TOOLS = {
		semgrep: true,
		gitSecrets: true,
		trufflehog: true,
		heuristicScan: true,
	};
	return {
		resolveGuardianConfig: vi.fn(
			(options?: {
				config?: { toolTimeoutMs?: number; tools?: Record<string, boolean> };
			}) => ({
				enabled: true,
				scanGitOperations: true,
				scanDestructiveCommands: true,
				customSecretPatterns: [],
				excludePatterns: [],
				tools: {
					...DEFAULT_TOOLS,
					...(options?.config?.tools ?? {}),
				},
				toolTimeoutMs: options?.config?.toolTimeoutMs ?? 120_000,
				blockOnFindings: true,
			}),
		),
	};
});

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { resolveGuardianConfig } from "../../src/guardian/config.js";

type GuardianRunnerModule = typeof import("../../src/guardian/runner.js");

let runGuardian: GuardianRunnerModule["runGuardian"];
let shouldGuardCommand: GuardianRunnerModule["shouldGuardCommand"];

const tempDir = mkdtempSync(path.join(os.tmpdir(), "guardian-test-"));
const tempState = path.join(tempDir, "guardian-state.json");

beforeAll(async () => {
	process.env.MAESTRO_GUARDIAN_STATE = tempState;
	({ runGuardian, shouldGuardCommand } = await import(
		"../../src/guardian/runner.js"
	));
});

afterAll(() => {
	Reflect.deleteProperty(process.env, "MAESTRO_GUARDIAN_STATE");
	rmSync(tempDir, { recursive: true, force: true });
});

describe("guardian runner", () => {
	const mockSpawn = spawnSync as ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockSpawn.mockImplementation(
			(cmd: string, args?: ReadonlyArray<string>) => {
				const joined = Array.isArray(args) ? args.join(" ") : "";
				if (cmd === "git" && joined.includes("diff --name-only --cached")) {
					return {
						status: 0,
						stdout: "",
						stderr: "",
					};
				}
				return {
					status: 1,
					stdout: "",
					stderr: "",
				};
			},
		);
	});

	afterEach(() => {
		mockSpawn.mockReset();
		Reflect.deleteProperty(process.env, "MAESTRO_GUARDIAN");
	});

	it("ignores inline disable text for commit/push detection", () => {
		const commented = shouldGuardCommand(
			"git push origin main # MAESTRO_GUARDIAN=0",
		);
		expect(commented.shouldGuard).toBe(true);
		expect(commented.trigger).toBe("git push");

		const assignment = shouldGuardCommand(
			'MAESTRO_GUARDIAN=0 git commit -m "msg"',
		);
		expect(assignment.shouldGuard).toBe(true);
		expect(assignment.trigger).toBe("git commit");
	});

	it("detects wrapped git commands", () => {
		const cases = [
			{ command: "git -C packages/tui-rs push", trigger: "git push" },
			{ command: "command git push origin main", trigger: "git push" },
			{ command: 'command -- git commit -m "msg"', trigger: "git commit" },
			{ command: 'sudo -- git commit -m "msg"', trigger: "git commit" },
			{ command: "sudo -u root -- git push origin main", trigger: "git push" },
			{ command: "/usr/bin/git push origin main", trigger: "git push" },
			{ command: '( git commit -m "msg" )', trigger: "git commit" },
			{ command: 'echo "$(git commit -m msg)"', trigger: "git commit" },
			{ command: "echo $(git push origin main)", trigger: "git push" },
			{ command: "echo `git push origin main`", trigger: "git push" },
			{ command: "cat <(git push origin main)", trigger: "git push" },
			{ command: "diff <(echo ok) <(rm -rf /tmp/x)", trigger: "rm -rf" },
			{ command: "echo $(rm -rf /tmp/x)", trigger: "rm -rf" },
			{ command: "echo `rm -r /tmp/x`", trigger: "rm -r" },
			{ command: "echo $(echo $(git push origin main))", trigger: "git push" },
			{ command: "echo $(echo $(rm -rf /tmp/x))", trigger: "rm -rf" },
			{ command: "eval 'git push origin main'", trigger: "git push" },
			{ command: 'eval "rm -rf /tmp/x"', trigger: "rm -rf" },
			{
				command: 'env GIT_CONFIG_GLOBAL=/tmp/gitconfig git commit -m "msg"',
				trigger: "git commit",
			},
		];

		for (const { command, trigger } of cases) {
			const result = shouldGuardCommand(command);
			expect(result.shouldGuard).toBe(true);
			expect(result.trigger).toBe(trigger);
		}
	});

	it("detects guarded commands past shallow substitution nesting", () => {
		let gitCommand = "git push origin main";
		let rmCommand = "rm -rf /tmp/x";
		for (let index = 0; index < 12; index += 1) {
			gitCommand = `echo $(${gitCommand})`;
			rmCommand = `echo $(${rmCommand})`;
		}

		expect(shouldGuardCommand(gitCommand)).toEqual({
			shouldGuard: true,
			trigger: "git push",
		});
		expect(shouldGuardCommand(rmCommand)).toEqual({
			shouldGuard: true,
			trigger: "rm -rf",
		});
	});

	it("detects later guarded git commands in a token sequence", () => {
		const cases = [
			{
				command: "git submodule foreach git commit -m update",
				trigger: "git commit",
			},
			{
				command: `sh -c 'git status
git commit -m "msg"'`,
				trigger: "git commit",
			},
		];

		for (const { command, trigger } of cases) {
			const result = shouldGuardCommand(command);
			expect(result.shouldGuard).toBe(true);
			expect(result.trigger).toBe(trigger);
		}
	});

	it("detects guarded commands inside shell -c scripts", () => {
		const cases = [
			{ command: `sh -c 'git commit -m "msg"'`, trigger: "git commit" },
			{ command: `sh -c'git push origin main'`, trigger: "git push" },
			{ command: `sh.exe -c 'git push origin main'`, trigger: "git push" },
			{ command: `bash -lc 'git push origin main'`, trigger: "git push" },
			{ command: `bash -lc'git push origin main'`, trigger: "git push" },
			{ command: `fish -c 'git push origin main'`, trigger: "git push" },
			{
				command: `bash -norc -c 'git push origin main'`,
				trigger: "git push",
			},
			{ command: `su -c 'git push origin main'`, trigger: "git push" },
			{
				command: `docker run image sh -c 'git push origin main'`,
				trigger: "git push",
			},
			{
				command: `docker run --rm ubuntu sh -c 'git commit -m "msg"'`,
				trigger: "git commit",
			},
			{ command: `bash -c 'rm -rf /tmp/x'`, trigger: "rm -rf" },
			{ command: `sh -c'rm -rf /tmp/x'`, trigger: "rm -rf" },
			{ command: `sh -c -- 'rm -rf /tmp/x'`, trigger: "rm -rf" },
			{ command: `sh -ec 'rm -r /tmp/y'`, trigger: "rm -r" },
			{ command: `sh -cx 'git push origin main'`, trigger: "git push" },
			{ command: `bash -xce 'git commit -m "msg"'`, trigger: "git commit" },
			{ command: `fish -c 'git push origin main'`, trigger: "git push" },
			{ command: `su -c 'git push origin main'`, trigger: "git push" },
			{ command: `su root -c 'git commit -m "msg"'`, trigger: "git commit" },
			{
				command: `ssh deploy@example.com 'git push origin main'`,
				trigger: "git push",
			},
			{
				command: `ssh deploy@example.com'git push origin main'`,
				trigger: "git push",
			},
			{
				command: `ssh -p 2222 host 'git commit -m "msg"'`,
				trigger: "git commit",
			},
			{ command: `ssh host 'rm -rf /tmp/x'`, trigger: "rm -rf" },
			{ command: `sh -c 'echo $(git push origin main)'`, trigger: "git push" },
			{ command: `eval 'echo $(rm -rf /tmp/x)'`, trigger: "rm -rf" },
		];

		for (const { command, trigger } of cases) {
			const result = shouldGuardCommand(command);
			expect(result.shouldGuard).toBe(true);
			expect(result.trigger).toBe(trigger);
		}
	});

	it("detects guarded substitutions inside inline shell scripts", () => {
		const cases = [
			{
				command: `sh -c 'echo $(git push origin main)'`,
				trigger: "git push",
			},
			{
				command: `bash -lc 'echo $(git commit -m "msg")'`,
				trigger: "git commit",
			},
			{
				command: `eval 'echo $(rm -rf /tmp/x)'`,
				trigger: "rm -rf",
			},
		];

		for (const { command, trigger } of cases) {
			const result = shouldGuardCommand(command);
			expect(result.shouldGuard).toBe(true);
			expect(result.trigger).toBe(trigger);
		}
	});

	it("detects guarded quoted command args for non-shell launchers", () => {
		const cases = [
			{
				command: `ssh host 'git push origin main'`,
				trigger: "git push",
			},
			{
				command: `runuser -u deploy -- 'git commit -m "msg"'`,
				trigger: "git commit",
			},
			{
				command: `script -qc 'rm -rf /tmp/x' /dev/null`,
				trigger: "rm -rf",
			},
		];

		for (const { command, trigger } of cases) {
			const result = shouldGuardCommand(command);
			expect(result.shouldGuard).toBe(true);
			expect(result.trigger).toBe(trigger);
		}
	});

	it("detects destructive commands", () => {
		const commands = [
			"rm -rf /tmp/x",
			"/usr/bin/rm -rf /tmp/x",
			"rm -fr /tmp/x",
			"rm --recursive --force /tmp/x",
			"sudo rm -r /tmp/y",
			"find . -exec rm -rf {} ;",
			"find . -delete",
			"chmod 000 secret",
			"dd if=/dev/zero of=/dev/sda",
			"mkfs.ext4 /dev/sdb1",
			"truncate -s 0 file.txt",
		];
		for (const cmd of commands) {
			const result = shouldGuardCommand(cmd);
			expect(result.shouldGuard).toBe(true);
		}
	});

	it("does not merge destructive regexes across command separators", () => {
		const commands = ["find; echo -delete", "chmod; 000"];

		for (const cmd of commands) {
			const result = shouldGuardCommand(cmd);
			expect(result.shouldGuard).toBe(false);
			expect(result.trigger).toBeNull();
		}
	});

	it("does not flag rm without recursive flag", () => {
		const commands = [
			"rm -v /home/user/file.txt",
			"rm -i parent/child",
			"rm -- -rf",
			"rm -- --recursive --force",
		];
		for (const cmd of commands) {
			const result = shouldGuardCommand(cmd);
			expect(result.shouldGuard).toBe(false);
		}
	});

	it("stops parsing rm options at double dash", () => {
		const result = shouldGuardCommand("rm -r -- -f");

		expect(result.shouldGuard).toBe(true);
		expect(result.trigger).toBe("rm -r");
	});

	it("does not flag literal git commands in single-quoted strings", () => {
		const result = shouldGuardCommand("echo '$(git push origin main)'");

		expect(result.shouldGuard).toBe(false);
	});

	it("skips when MAESTRO_GUARDIAN=0 env is set", async () => {
		process.env.MAESTRO_GUARDIAN = "0";
		const result = await runGuardian({ target: "staged", trigger: "test" });
		expect(result.status).toBe("skipped");
		expect(result.exitCode).toBe(0);
	});

	it("returns skipped when no staged files are present", async () => {
		process.env.MAESTRO_GUARDIAN = "1";
		const result = await runGuardian({ target: "staged", trigger: "test" });
		expect(result.status).toBe("skipped");
		expect(result.summary.toLowerCase()).toContain("no files");
	});

	it("skips tools disabled via config", async () => {
		process.env.MAESTRO_GUARDIAN = "1";
		// Return a staged file so the guardian actually runs tools
		mockSpawn.mockImplementation(
			(cmd: string, args?: ReadonlyArray<string>) => {
				const joined = Array.isArray(args) ? args.join(" ") : "";
				if (cmd === "git" && joined.includes("diff --name-only --cached")) {
					return { status: 0, stdout: "src/index.ts\n", stderr: "" };
				}
				if (cmd === "git" && joined.includes("show :")) {
					return { status: 0, stdout: "export const x = 1;\n", stderr: "" };
				}
				// All tool binaries "not found"
				return { status: 1, stdout: "", stderr: "" };
			},
		);

		const mockResolve = vi.mocked(resolveGuardianConfig);

		// Disable semgrep via config
		mockResolve.mockReturnValueOnce({
			enabled: true,
			scanGitOperations: true,
			scanDestructiveCommands: true,
			customSecretPatterns: [],
			excludePatterns: [],
			tools: {
				semgrep: false,
				gitSecrets: true,
				trufflehog: true,
				heuristicScan: true,
			},
			toolTimeoutMs: 120_000,
			blockOnFindings: true,
		});

		const result = await runGuardian({
			target: "staged",
			trigger: "test",
		});

		// semgrep should not appear in tool results at all
		const toolNames = result.toolResults.map((t) => t.tool);
		expect(toolNames).not.toContain("semgrep");
	});

	it("runs semgrep with bounded concurrency and metrics disabled", async () => {
		process.env.MAESTRO_GUARDIAN = "1";
		const calls: Array<{
			cmd: string;
			args: readonly string[];
			env?: NodeJS.ProcessEnv;
			timeout?: number;
		}> = [];
		mockSpawn.mockImplementation(
			(
				cmd: string,
				args?: ReadonlyArray<string>,
				options?: { env?: NodeJS.ProcessEnv; timeout?: number },
			) => {
				const normalizedArgs = args ?? [];
				calls.push({
					cmd,
					args: normalizedArgs,
					env: options?.env,
					timeout: options?.timeout,
				});
				const joined = normalizedArgs.join(" ");
				if (cmd === "git" && joined.includes("diff --name-only --cached")) {
					return { status: 0, stdout: "src/index.ts\n", stderr: "" };
				}
				if (cmd === "git" && joined.includes("show :")) {
					return { status: 0, stdout: "export const x = 1;\n", stderr: "" };
				}
				if (cmd === "semgrep" && joined.includes("--version")) {
					return { status: 0, stdout: "1.145.0\n", stderr: "" };
				}
				if (cmd === "semgrep" && joined.includes("scan")) {
					return { status: 0, stdout: "{}", stderr: "" };
				}
				return { status: 1, stdout: "", stderr: "" };
			},
		);

		const result = await runGuardian({
			target: "staged",
			trigger: "test",
			config: {
				toolTimeoutMs: 600_000,
			},
		});

		expect(result.status).toBe("passed");
		const semgrepScan = calls.find(
			(call) => call.cmd === "semgrep" && call.args.includes("scan"),
		);
		expect(semgrepScan?.args).toEqual(
			expect.arrayContaining(["--jobs", "1", "--metrics=off"]),
		);
		expect(semgrepScan?.env?.SEMGREP_SEND_METRICS).toBe("off");
		expect(semgrepScan?.timeout).toBe(600_000);
	});

	it("classifies timed-out scanner commands as runtime errors", async () => {
		process.env.MAESTRO_GUARDIAN = "1";
		const timeoutError = Object.assign(
			new Error("spawnSync semgrep ETIMEDOUT"),
			{ code: "ETIMEDOUT" },
		);
		mockSpawn.mockImplementation(
			(cmd: string, args?: ReadonlyArray<string>) => {
				const joined = Array.isArray(args) ? args.join(" ") : "";
				if (cmd === "git" && joined.includes("diff --name-only --cached")) {
					return { status: 0, stdout: "src/index.ts\n", stderr: "" };
				}
				if (cmd === "git" && joined.includes("show :")) {
					return { status: 0, stdout: "export const x = 1;\n", stderr: "" };
				}
				if (cmd === "semgrep" && joined.includes("--version")) {
					return { status: 0, stdout: "1.145.0\n", stderr: "" };
				}
				if (cmd === "semgrep" && joined.includes("scan")) {
					return {
						status: null,
						signal: "SIGTERM",
						error: timeoutError,
						stdout: "",
						stderr: "",
					};
				}
				return { status: 1, stdout: "", stderr: "" };
			},
		);

		const result = await runGuardian({
			target: "staged",
			trigger: "test",
		});

		const semgrep = result.toolResults.find((tool) => tool.tool === "semgrep");
		expect(result.status).toBe("error");
		expect(result.exitCode).toBe(124);
		expect(semgrep?.exitCode).toBe(124);
		expect(semgrep?.stderr).toContain("ETIMEDOUT");
	});

	it("preserves POSIX-style exit codes for signaled scanner commands", async () => {
		process.env.MAESTRO_GUARDIAN = "1";
		mockSpawn.mockImplementation(
			(cmd: string, args?: ReadonlyArray<string>) => {
				const joined = Array.isArray(args) ? args.join(" ") : "";
				if (cmd === "git" && joined.includes("diff --name-only --cached")) {
					return { status: 0, stdout: "src/index.ts\n", stderr: "" };
				}
				if (cmd === "git" && joined.includes("show :")) {
					return { status: 0, stdout: "export const x = 1;\n", stderr: "" };
				}
				if (cmd === "semgrep" && joined.includes("--version")) {
					return { status: 0, stdout: "1.145.0\n", stderr: "" };
				}
				if (cmd === "semgrep" && joined.includes("scan")) {
					return {
						status: null,
						signal: "SIGKILL",
						stdout: "",
						stderr: "",
					};
				}
				return { status: 1, stdout: "", stderr: "" };
			},
		);

		const result = await runGuardian({
			target: "staged",
			trigger: "test",
		});

		const semgrep = result.toolResults.find((tool) => tool.tool === "semgrep");
		expect(result.status).toBe("error");
		expect(result.exitCode).toBe(137);
		expect(semgrep?.exitCode).toBe(137);
	});

	it("passes configured tool timeout to semgrep", async () => {
		process.env.MAESTRO_GUARDIAN = "1";
		const calls: Array<{
			cmd: string;
			args: readonly string[];
			timeout?: number;
		}> = [];
		mockSpawn.mockImplementation(
			(
				cmd: string,
				args?: ReadonlyArray<string>,
				options?: { timeout?: number },
			) => {
				const normalizedArgs = args ?? [];
				calls.push({
					cmd,
					args: normalizedArgs,
					timeout: options?.timeout,
				});
				const joined = normalizedArgs.join(" ");
				if (cmd === "git" && joined.includes("diff --name-only --cached")) {
					return { status: 0, stdout: "src/index.ts\n", stderr: "" };
				}
				if (cmd === "git" && joined.includes("show :")) {
					return { status: 0, stdout: "export const x = 1;\n", stderr: "" };
				}
				if (cmd === "semgrep" && joined.includes("--version")) {
					return { status: 0, stdout: "1.145.0\n", stderr: "" };
				}
				if (cmd === "semgrep" && joined.includes("scan")) {
					return { status: 0, stdout: "{}", stderr: "" };
				}
				return { status: 1, stdout: "", stderr: "" };
			},
		);

		await runGuardian({
			config: { toolTimeoutMs: 240_000 },
			target: "staged",
			trigger: "test",
		});

		const semgrepScan = calls.find(
			(call) => call.cmd === "semgrep" && call.args.includes("scan"),
		);
		expect(semgrepScan?.timeout).toBe(240_000);
	});

	it("classifies timed out semgrep scans as Guardian errors", async () => {
		process.env.MAESTRO_GUARDIAN = "1";
		mockSpawn.mockImplementation(
			(cmd: string, args?: ReadonlyArray<string>) => {
				const normalizedArgs = args ?? [];
				const joined = normalizedArgs.join(" ");
				if (cmd === "git" && joined.includes("diff --name-only --cached")) {
					return { status: 0, stdout: "src/index.ts\n", stderr: "" };
				}
				if (cmd === "git" && joined.includes("show :")) {
					return { status: 0, stdout: "export const x = 1;\n", stderr: "" };
				}
				if (cmd === "semgrep" && joined.includes("--version")) {
					return { status: 0, stdout: "1.144.0\n", stderr: "" };
				}
				if (cmd === "semgrep" && joined.includes("scan")) {
					const error = Object.assign(
						new Error("spawnSync semgrep ETIMEDOUT"),
						{
							code: "ETIMEDOUT",
						},
					);
					return {
						status: null,
						signal: "SIGTERM",
						error,
						stdout: "",
						stderr: "Scan Status",
					};
				}
				return { status: 1, stdout: "", stderr: "" };
			},
		);

		const result = await runGuardian({
			config: {
				toolTimeoutMs: 240_000,
				tools: { gitSecrets: false, trufflehog: false, heuristicScan: false },
			},
			target: "staged",
			trigger: "test",
		});

		const semgrepResult = result.toolResults.find(
			(tool) => tool.tool === "semgrep",
		);
		expect(result.status).toBe("error");
		expect(result.exitCode).toBe(124);
		expect(semgrepResult?.exitCode).toBe(124);
		expect(semgrepResult?.stderr).toContain("semgrep timed out after 240000ms");
	});

	it("reports timed-out tools as guardian runtime errors", async () => {
		process.env.MAESTRO_GUARDIAN = "1";
		const timeoutError = Object.assign(
			new Error("spawnSync semgrep ETIMEDOUT"),
			{ code: "ETIMEDOUT" },
		);
		mockSpawn.mockImplementation(
			(cmd: string, args?: ReadonlyArray<string>) => {
				const joined = Array.isArray(args) ? args.join(" ") : "";
				if (cmd === "git" && joined.includes("diff --name-only --cached")) {
					return { status: 0, stdout: "src/index.ts\n", stderr: "" };
				}
				if (cmd === "git" && joined.includes("show :")) {
					return { status: 0, stdout: "export const x = 1;\n", stderr: "" };
				}
				if (cmd === "semgrep" && joined.includes("--version")) {
					return { status: 0, stdout: "1.145.0\n", stderr: "" };
				}
				if (cmd === "semgrep" && joined.includes("scan")) {
					return {
						status: null,
						stdout: "",
						stderr: "",
						error: timeoutError,
					};
				}
				return { status: 1, stdout: "", stderr: "" };
			},
		);

		const result = await runGuardian({
			target: "staged",
			trigger: "test",
			config: {
				tools: {
					gitSecrets: false,
					trufflehog: false,
					heuristicScan: false,
				},
			},
		});

		const semgrep = result.toolResults.find((tool) => tool.tool === "semgrep");
		expect(result.status).toBe("error");
		expect(result.exitCode).toBe(124);
		expect(semgrep?.exitCode).toBe(124);
		expect(semgrep?.stderr).toContain("ETIMEDOUT");
	});

	it("reports signal-terminated tools as guardian runtime errors", async () => {
		process.env.MAESTRO_GUARDIAN = "1";
		mockSpawn.mockImplementation(
			(cmd: string, args?: ReadonlyArray<string>) => {
				const joined = Array.isArray(args) ? args.join(" ") : "";
				if (cmd === "git" && joined.includes("diff --name-only --cached")) {
					return { status: 0, stdout: "src/index.ts\n", stderr: "" };
				}
				if (cmd === "git" && joined.includes("show :")) {
					return { status: 0, stdout: "export const x = 1;\n", stderr: "" };
				}
				if (cmd === "semgrep" && joined.includes("--version")) {
					return { status: 0, stdout: "1.145.0\n", stderr: "" };
				}
				if (cmd === "semgrep" && joined.includes("scan")) {
					return {
						status: null,
						signal: "SIGKILL",
						stdout: "",
						stderr: "killed",
					};
				}
				return { status: 1, stdout: "", stderr: "" };
			},
		);

		const result = await runGuardian({
			target: "staged",
			trigger: "test",
			config: {
				tools: {
					gitSecrets: false,
					trufflehog: false,
					heuristicScan: false,
				},
			},
		});

		const semgrep = result.toolResults.find((tool) => tool.tool === "semgrep");
		expect(result.status).toBe("error");
		expect(result.exitCode).toBe(137);
		expect(semgrep?.exitCode).toBe(137);
	});
});
