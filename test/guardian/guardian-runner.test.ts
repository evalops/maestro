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
				config?: { tools?: Record<string, boolean> };
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
				toolTimeoutMs: 120_000,
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

	it("respects inline disable flag for commit/push detection", () => {
		const result = shouldGuardCommand('MAESTRO_GUARDIAN=0 git commit -m "msg"');
		expect(result.shouldGuard).toBe(false);
	});

	it("detects destructive commands", () => {
		const commands = [
			"rm -rf /tmp/x",
			"sudo rm -r /tmp/y",
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

	it("does not flag rm without recursive flag", () => {
		const commands = ["rm -v /home/user/file.txt", "rm -i parent/child"];
		for (const cmd of commands) {
			const result = shouldGuardCommand(cmd);
			expect(result.shouldGuard).toBe(false);
		}
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
		});

		expect(result.status).toBe("passed");
		const semgrepScan = calls.find(
			(call) => call.cmd === "semgrep" && call.args.includes("scan"),
		);
		expect(semgrepScan?.args).toEqual(
			expect.arrayContaining(["--jobs", "1", "--metrics=off"]),
		);
		expect(semgrepScan?.env?.SEMGREP_SEND_METRICS).toBe("off");
		expect(semgrepScan?.timeout).toBe(120_000);
	});

	it("honors configured semgrep timeout", async () => {
		process.env.MAESTRO_GUARDIAN = "1";
		const mockResolve = vi.mocked(resolveGuardianConfig);
		mockResolve.mockReturnValueOnce({
			enabled: true,
			scanGitOperations: true,
			scanDestructiveCommands: true,
			customSecretPatterns: [],
			excludePatterns: [],
			tools: {
				semgrep: true,
				gitSecrets: false,
				trufflehog: false,
				heuristicScan: false,
				evidenceIntegrity: false,
			},
			toolTimeoutMs: 600_000,
			blockOnFindings: true,
		});

		const semgrepTimeouts: number[] = [];
		mockSpawn.mockImplementation(
			(
				cmd: string,
				args?: ReadonlyArray<string>,
				options?: { timeout?: number },
			) => {
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
					semgrepTimeouts.push(options?.timeout ?? 0);
					return { status: 0, stdout: "{}", stderr: "" };
				}
				return { status: 1, stdout: "", stderr: "" };
			},
		);

		const result = await runGuardian({
			target: "staged",
			trigger: "test",
		});

		expect(result.status).toBe("passed");
		expect(semgrepTimeouts).toEqual([600_000]);
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
});
