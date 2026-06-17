import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "../../src/sandbox/types.js";

const childProcessMock = vi.hoisted(() => ({
	spawn: vi.fn(),
}));
const shellEnvMock = vi.hoisted(() => ({
	resolveShellEnvironment: vi.fn(),
}));
const shellUtilsMock = vi.hoisted(() => ({
	killProcessTree: vi.fn(),
}));
const execpolicyMock = vi.hoisted(() => ({
	checkCommand: vi.fn(),
}));
const safeModeMock = vi.hoisted(() => ({
	requirePlanCheck: vi.fn(),
}));
const bashToolMock = vi.hoisted(() => ({
	execute: vi.fn(),
}));

vi.mock("node:child_process", () => childProcessMock);
vi.mock("../../src/utils/shell-env.js", () => shellEnvMock);
vi.mock("../../src/tools/shell-utils.js", () => shellUtilsMock);
vi.mock("../../src/safety/execpolicy.js", () => execpolicyMock);
vi.mock("../../src/safety/safe-mode.js", () => safeModeMock);

vi.mock("../../src/tools/bash.js", () => ({ bashTool: bashToolMock }));

import {
	checkGhCliAvailable,
	executeGhCommand,
} from "../../src/tools/gh-helpers.js";

type MockChildProcess = EventEmitter & {
	pid?: number;
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill: ReturnType<typeof vi.fn>;
};

function createMockChildProcess(): MockChildProcess {
	const child = new EventEmitter() as MockChildProcess;
	child.pid = 1234;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn();
	return child;
}

function getTextOutput(
	result: Awaited<ReturnType<typeof executeGhCommand>>,
): string {
	const first = result.content[0];
	return first && "text" in first ? first.text : "";
}

describe("executeGhCommand", () => {
	beforeEach(() => {
		vi.useRealTimers();
		childProcessMock.spawn.mockReset();
		shellEnvMock.resolveShellEnvironment.mockReset();
		shellEnvMock.resolveShellEnvironment.mockReturnValue({ PATH: "/mock-bin" });
		shellUtilsMock.killProcessTree.mockReset();
		execpolicyMock.checkCommand.mockReset();
		execpolicyMock.checkCommand.mockReturnValue({
			decision: "allow",
			matchedRules: [],
		});
		safeModeMock.requirePlanCheck.mockReset();
		bashToolMock.execute.mockReset();
	});

	it("passes gh arguments without a shell", async () => {
		const child = createMockChildProcess();
		childProcessMock.spawn.mockReturnValueOnce(child);

		const promise = executeGhCommand("gh-argv", [
			"pr",
			"view",
			"1; touch /tmp/pwned",
		]);
		child.stdout.emit("data", Buffer.from("ok"));
		child.emit("close", 0);

		const result = await promise;

		expect(childProcessMock.spawn).toHaveBeenCalledWith(
			"gh",
			["pr", "view", "1; touch /tmp/pwned"],
			{
				detached: true,
				env: { PATH: "/mock-bin" },
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
			},
		);
		expect(execpolicyMock.checkCommand).toHaveBeenCalledWith(
			"gh pr view '1; touch /tmp/pwned'",
			process.cwd(),
		);
		expect(shellEnvMock.resolveShellEnvironment).toHaveBeenCalledWith(
			undefined,
			{
				workspaceDir: process.cwd(),
			},
		);
		expect(getTextOutput(result)).toBe("ok");
	});

	it("blocks gh argv commands forbidden by execpolicy", async () => {
		execpolicyMock.checkCommand.mockReturnValueOnce({
			decision: "forbidden",
			matchedRules: [
				{
					type: "prefix",
					matchedPrefix: ["gh", "repo", "clone"],
				},
			],
		});

		const result = await executeGhCommand("gh-policy", [
			"repo",
			"clone",
			"owner/repo",
		]);

		expect(childProcessMock.spawn).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(getTextOutput(result)).toContain("Command blocked by execpolicy");
		expect(getTextOutput(result)).toContain("prefix: gh repo clone");
	});

	it("executes gh through the sandbox when one is provided", async () => {
		const sandbox = {
			exec: vi.fn(),
			execWithArgs: vi.fn().mockResolvedValue({
				stdout: "sandbox ok",
				stderr: "",
				exitCode: 0,
			}),
			readFile: vi.fn(),
			writeFile: vi.fn(),
			exists: vi.fn(),
			dispose: vi.fn(),
		};

		const result = await executeGhCommand(
			"gh-sandbox",
			["repo", "clone", "owner/repo$(touch /tmp/pwned)`whoami`"],
			undefined,
			sandbox as unknown as Sandbox,
		);

		expect(childProcessMock.spawn).not.toHaveBeenCalled();
		expect(sandbox.exec).not.toHaveBeenCalled();
		expect(sandbox.execWithArgs).toHaveBeenCalledWith(
			"gh",
			["repo", "clone", "owner/repo$(touch /tmp/pwned)`whoami`"],
			{
				env: { PATH: "/mock-bin" },
				maxBuffer: 40 * 1024 + 1,
				signal: expect.any(AbortSignal),
			},
		);
		expect(getTextOutput(result)).toBe("sandbox ok");
	});

	it("cleans up sandbox abort listeners after successful execution", async () => {
		const listeners = new Set<() => void>();
		const signal = {
			aborted: false,
			reason: undefined,
			addEventListener: vi.fn(
				(_event: string, listener: EventListenerOrEventListenerObject) => {
					if (typeof listener === "function") {
						listeners.add(listener);
					}
				},
			),
			removeEventListener: vi.fn(
				(_event: string, listener: EventListenerOrEventListenerObject) => {
					if (typeof listener === "function") {
						listeners.delete(listener);
					}
				},
			),
		} as unknown as AbortSignal;
		const sandbox = {
			exec: vi.fn(),
			execWithArgs: vi.fn().mockResolvedValue({
				stdout: "sandbox ok",
				stderr: "",
				exitCode: 0,
			}),
			readFile: vi.fn(),
			writeFile: vi.fn(),
			exists: vi.fn(),
			dispose: vi.fn(),
		};

		const result = await executeGhCommand(
			"gh-sandbox-cleanup",
			["pr", "view", "1"],
			signal,
			sandbox as unknown as Sandbox,
		);

		expect(result.isError).toBe(false);
		expect(listeners.size).toBe(0);
		expect(signal.removeEventListener).toHaveBeenCalledTimes(2);
	});

	it("requires safe-mode plans for mutating gh commands", async () => {
		safeModeMock.requirePlanCheck.mockImplementationOnce(() => {
			throw new Error("Safe mode requires a plan before executing gh.");
		});

		await expect(
			executeGhCommand("gh-safe-mode", ["repo", "clone", "owner/repo"]),
		).rejects.toThrow("Safe mode requires a plan");

		expect(safeModeMock.requirePlanCheck).toHaveBeenCalledWith("gh");
		expect(childProcessMock.spawn).not.toHaveBeenCalled();
	});

	it("does not require safe-mode plans for read-only gh commands", async () => {
		const child = createMockChildProcess();
		childProcessMock.spawn.mockReturnValueOnce(child);

		const promise = executeGhCommand("gh-readonly", ["pr", "view", "1"]);
		child.stdout.emit("data", Buffer.from("ok"));
		child.emit("close", 0);

		await expect(promise).resolves.toBeTruthy();
		expect(safeModeMock.requirePlanCheck).not.toHaveBeenCalled();
	});

	it("caps oversized sandbox execWithArgs stdout and reports truncation", async () => {
		const sandbox = {
			exec: vi.fn(),
			execWithArgs: vi.fn().mockResolvedValue({
				stdout: "x".repeat(50 * 1024),
				stderr: "",
				exitCode: 0,
			}),
			readFile: vi.fn(),
			writeFile: vi.fn(),
			exists: vi.fn(),
			dispose: vi.fn(),
		};

		const result = await executeGhCommand(
			"gh-sandbox-large-output",
			["pr", "diff", "1"],
			undefined,
			sandbox as unknown as Sandbox,
		);
		const output = getTextOutput(result);
		const capturedOutput = output.split("\n\n")[0] ?? "";

		expect(sandbox.execWithArgs).toHaveBeenCalledWith(
			"gh",
			["pr", "diff", "1"],
			expect.objectContaining({ maxBuffer: 40 * 1024 + 1 }),
		);
		expect((capturedOutput.match(/x/g) ?? []).length).toBe(40 * 1024);
		expect(output).toContain("stdout exceeded 40KB limit and was truncated");
	});

	it("fails closed when sandbox gh lacks argv execution support", async () => {
		const sandbox = {
			exec: vi.fn(),
			readFile: vi.fn(),
			writeFile: vi.fn(),
			exists: vi.fn(),
			dispose: vi.fn(),
		};

		const result = await executeGhCommand(
			"gh-sandbox-no-argv",
			["repo", "clone", "owner/repo"],
			undefined,
			sandbox as unknown as Sandbox,
		);

		expect(result.isError).toBe(true);
		expect(getTextOutput(result)).toContain(
			"requires argv-capable sandbox support",
		);
		expect(sandbox.exec).not.toHaveBeenCalled();
	});

	it("reports sandbox execWithArgs aborts as cancelled", async () => {
		const sandbox = {
			exec: vi.fn(),
			execWithArgs: vi.fn(
				(
					_command: string,
					_args: string[] = [],
					options?: { signal?: AbortSignal },
				) =>
					new Promise((resolve) => {
						options?.signal?.addEventListener(
							"abort",
							() =>
								resolve({
									stdout: "",
									stderr: "",
									exitCode: 0,
								}),
							{ once: true },
						);
					}),
			),
			readFile: vi.fn(),
			writeFile: vi.fn(),
			exists: vi.fn(),
			dispose: vi.fn(),
		};
		const controller = new AbortController();

		const promise = executeGhCommand(
			"gh-sandbox-abort-exec-with-args",
			["repo", "clone", "owner/repo"],
			controller.signal,
			sandbox as unknown as Sandbox,
		);
		controller.abort();

		const result = await promise;

		expect(result.isError).toBe(true);
		expect(getTextOutput(result)).toContain("Command cancelled");
	});

	it("times out sandbox gh execution even when the sandbox ignores aborts", async () => {
		vi.useFakeTimers();
		try {
			const sandbox = {
				exec: vi.fn(),
				execWithArgs: vi.fn(() => new Promise(() => {})),
				readFile: vi.fn(),
				writeFile: vi.fn(),
				exists: vi.fn(),
				dispose: vi.fn(),
			};

			const promise = executeGhCommand(
				"gh-sandbox-timeout",
				["pr", "view", "1"],
				undefined,
				sandbox as unknown as Sandbox,
			);
			await vi.advanceTimersByTimeAsync(90_000);
			const result = await promise;

			expect(result.isError).toBe(true);
			expect(getTextOutput(result)).toContain("Command timed out after 90s");
		} finally {
			vi.useRealTimers();
		}
	});

	it("removes sandbox abort listeners after gh completes", async () => {
		const controller = new AbortController();
		const addListener = vi.spyOn(controller.signal, "addEventListener");
		const removeListener = vi.spyOn(controller.signal, "removeEventListener");
		const sandbox = {
			exec: vi.fn(),
			execWithArgs: vi.fn().mockResolvedValue({
				stdout: "ok",
				stderr: "",
				exitCode: 0,
			}),
			readFile: vi.fn(),
			writeFile: vi.fn(),
			exists: vi.fn(),
			dispose: vi.fn(),
		};

		const result = await executeGhCommand(
			"gh-sandbox-listener-cleanup",
			["pr", "view", "1"],
			controller.signal,
			sandbox as unknown as Sandbox,
		);

		expect(result.isError).not.toBe(true);
		expect(addListener).toHaveBeenCalledWith(
			"abort",
			expect.any(Function),
			expect.objectContaining({ once: true }),
		);
		expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(removeListener).toHaveBeenCalledTimes(2);
	});

	it("does not spawn gh when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			executeGhCommand(
				"gh-aborted-before-start",
				["pr", "view"],
				controller.signal,
			),
		).rejects.toThrow("GitHub CLI command aborted before start");

		expect(childProcessMock.spawn).not.toHaveBeenCalled();
	});

	it("catches aborts that happen while gh is spawning", async () => {
		const child = createMockChildProcess();
		const controller = new AbortController();
		childProcessMock.spawn.mockImplementationOnce(() => {
			controller.abort();
			return child;
		});

		const promise = executeGhCommand(
			"gh-abort-during-spawn",
			["pr", "view"],
			controller.signal,
		);

		expect(childProcessMock.spawn).toHaveBeenCalledWith(
			"gh",
			["pr", "view"],
			expect.objectContaining({ signal: controller.signal }),
		);
		expect(shellUtilsMock.killProcessTree).toHaveBeenCalledWith(1234);

		child.emit("close", null);
		const result = await promise;

		expect(result.isError).toBe(true);
		expect(getTextOutput(result)).toContain("Command cancelled");
		expect(getTextOutput(result)).not.toContain("Exit code: null");
	});

	it("returns install guidance when gh is missing on direct spawn", async () => {
		const child = createMockChildProcess();
		childProcessMock.spawn.mockReturnValueOnce(child);

		const promise = executeGhCommand("gh-missing", ["pr", "view"]);
		child.emit(
			"error",
			Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }),
		);

		const result = await promise;

		expect(result.isError).toBe(true);
		expect(getTextOutput(result)).toContain(
			"GitHub CLI (gh) is not installed.",
		);
	});

	it("returns install guidance for sandbox gh probes with non-zero output", async () => {
		const sandbox = {
			exec: vi.fn(),
			execWithArgs: vi.fn().mockResolvedValueOnce({
				stdout: "",
				stderr: "gh: command not found",
				exitCode: 127,
			}),
			readFile: vi.fn(),
			writeFile: vi.fn(),
			exists: vi.fn(),
			dispose: vi.fn(),
		};

		const result = await checkGhCliAvailable(
			undefined,
			sandbox as unknown as Sandbox,
		);

		expect(result).not.toBeNull();
		expect(getTextOutput(result!)).toContain(
			"GitHub CLI (gh) is not installed.",
		);
		expect(bashToolMock.execute).not.toHaveBeenCalled();
		expect(sandbox.exec).not.toHaveBeenCalled();
		expect(sandbox.execWithArgs).toHaveBeenCalledWith(
			"gh",
			["--version"],
			expect.objectContaining({
				env: { PATH: "/mock-bin" },
				maxBuffer: 40 * 1024 + 1,
			}),
		);
	});

	it("surfaces sandbox gh probe capability failures instead of reporting gh missing", async () => {
		const sandbox = {
			exec: vi.fn(),
			execWithArgs: vi.fn().mockResolvedValueOnce({
				stdout: "",
				stderr: "Daytona abortable execution requires session API support",
				exitCode: 1,
			}),
			readFile: vi.fn(),
			writeFile: vi.fn(),
			exists: vi.fn(),
			dispose: vi.fn(),
		};

		const result = await checkGhCliAvailable(
			undefined,
			sandbox as unknown as Sandbox,
		);

		expect(result?.isError).toBe(true);
		expect(getTextOutput(result!)).toContain(
			"GitHub CLI availability check failed.",
		);
		expect(getTextOutput(result!)).toContain(
			"Daytona abortable execution requires session API support",
		);
		expect(getTextOutput(result!)).not.toContain(
			"GitHub CLI (gh) is not installed.",
		);
	});

	it("treats Daytona session timeout probe failures as timeout errors", async () => {
		const sandbox = {
			exec: vi.fn(),
			execWithArgs: vi.fn().mockResolvedValueOnce({
				stdout: "",
				stderr: "Daytona session command timed out",
				exitCode: 1,
			}),
			readFile: vi.fn(),
			writeFile: vi.fn(),
			exists: vi.fn(),
			dispose: vi.fn(),
		};

		const result = await checkGhCliAvailable(
			undefined,
			sandbox as unknown as Sandbox,
		);

		expect(result?.isError).toBe(true);
		expect(getTextOutput(result!)).toContain(
			"Daytona session command timed out",
		);
		expect(getTextOutput(result!)).not.toContain(
			"GitHub CLI availability check failed.",
		);
	});

	it("does not report sandbox runtime ENOENT errors as missing gh", async () => {
		const sandbox = {
			exec: vi.fn(),
			execWithArgs: vi.fn().mockResolvedValueOnce({
				stdout: "",
				stderr: "spawn docker ENOENT",
				exitCode: 1,
			}),
			readFile: vi.fn(),
			writeFile: vi.fn(),
			exists: vi.fn(),
			dispose: vi.fn(),
		};

		const result = await checkGhCliAvailable(
			undefined,
			sandbox as unknown as Sandbox,
		);

		expect(result?.isError).toBe(true);
		expect(getTextOutput(result!)).toContain(
			"GitHub CLI availability check failed.",
		);
		expect(getTextOutput(result!)).toContain("spawn docker ENOENT");
		expect(getTextOutput(result!)).not.toContain(
			"GitHub CLI (gh) is not installed.",
		);
	});

	it("reports already-cancelled sandbox gh probes as cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		const sandbox = {
			exec: vi.fn(),
			execWithArgs: vi.fn(() => new Promise(() => {})),
			readFile: vi.fn(),
			writeFile: vi.fn(),
			exists: vi.fn(),
			dispose: vi.fn(),
		};

		const result = await checkGhCliAvailable(
			controller.signal,
			sandbox as unknown as Sandbox,
		);

		expect(result?.isError).toBe(true);
		expect(getTextOutput(result!)).toContain("Command cancelled");
		expect(getTextOutput(result!)).not.toContain("Command timed out");
	});

	it("passes resolved shell env to sandbox gh auth probes", async () => {
		const sandbox = {
			exec: vi.fn(),
			execWithArgs: vi
				.fn()
				.mockResolvedValueOnce({
					stdout: "gh version 2.0.0",
					stderr: "",
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: "Logged in to github.com",
					stderr: "",
					exitCode: 0,
				}),
			readFile: vi.fn(),
			writeFile: vi.fn(),
			exists: vi.fn(),
			dispose: vi.fn(),
		};
		shellEnvMock.resolveShellEnvironment.mockReturnValueOnce({
			GH_TOKEN: "token-from-policy",
			PATH: "/mock-bin",
		});

		const result = await checkGhCliAvailable(
			undefined,
			sandbox as unknown as Sandbox,
		);

		expect(result).toBeNull();
		expect(bashToolMock.execute).not.toHaveBeenCalled();
		expect(sandbox.exec).not.toHaveBeenCalled();
		expect(sandbox.execWithArgs).toHaveBeenNthCalledWith(
			1,
			"gh",
			["--version"],
			{
				env: { GH_TOKEN: "token-from-policy", PATH: "/mock-bin" },
				maxBuffer: 40 * 1024 + 1,
				signal: expect.any(AbortSignal),
			},
		);
		expect(sandbox.execWithArgs).toHaveBeenNthCalledWith(
			2,
			"gh",
			["auth", "status"],
			{
				env: { GH_TOKEN: "token-from-policy", PATH: "/mock-bin" },
				maxBuffer: 40 * 1024 + 1,
				signal: expect.any(AbortSignal),
			},
		);
	});

	it("surfaces sandbox gh auth probe failures after gh is installed", async () => {
		const sandbox = {
			exec: vi.fn(),
			execWithArgs: vi
				.fn()
				.mockResolvedValueOnce({
					stdout: "gh version 2.0.0",
					stderr: "",
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: "",
					stderr: "HTTP 401: bad credentials",
					exitCode: 1,
				}),
			readFile: vi.fn(),
			writeFile: vi.fn(),
			exists: vi.fn(),
			dispose: vi.fn(),
		};

		const result = await checkGhCliAvailable(
			undefined,
			sandbox as unknown as Sandbox,
		);

		expect(result?.isError).toBe(true);
		expect(getTextOutput(result!)).toContain(
			"GitHub CLI authentication check failed.",
		);
		expect(getTextOutput(result!)).toContain("HTTP 401: bad credentials");
		expect(getTextOutput(result!)).not.toContain(
			"GitHub CLI (gh) is not installed.",
		);
	});

	it("reports sandbox auth probe capability failures as availability failures", async () => {
		const sandbox = {
			exec: vi.fn(),
			execWithArgs: vi
				.fn()
				.mockResolvedValueOnce({
					stdout: "gh version 2.0.0",
					stderr: "",
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: "",
					stderr: "Daytona abortable execution requires session API support",
					exitCode: 1,
				}),
			readFile: vi.fn(),
			writeFile: vi.fn(),
			exists: vi.fn(),
			dispose: vi.fn(),
		};

		const result = await checkGhCliAvailable(
			undefined,
			sandbox as unknown as Sandbox,
		);

		expect(result?.isError).toBe(true);
		expect(getTextOutput(result!)).toContain(
			"GitHub CLI availability check failed.",
		);
		expect(getTextOutput(result!)).toContain(
			"Daytona abortable execution requires session API support",
		);
		expect(getTextOutput(result!)).not.toContain(
			"GitHub CLI authentication check failed.",
		);
	});

	it("times out sandbox gh availability probes", async () => {
		vi.useFakeTimers();
		try {
			const sandbox = {
				exec: vi.fn(),
				execWithArgs: vi.fn(
					(
						_command: string,
						_args: string[] = [],
						_options?: { signal?: AbortSignal },
					) => new Promise(() => {}),
				),
				readFile: vi.fn(),
				writeFile: vi.fn(),
				exists: vi.fn(),
				dispose: vi.fn(),
			};

			const promise = checkGhCliAvailable(
				undefined,
				sandbox as unknown as Sandbox,
			);
			await vi.advanceTimersByTimeAsync(90_000);
			const result = await promise;

			expect(result?.isError).toBe(true);
			expect(getTextOutput(result!)).toContain("Command timed out after 90s");
			expect(sandbox.execWithArgs).toHaveBeenCalledWith(
				"gh",
				["--version"],
				expect.objectContaining({
					signal: expect.any(AbortSignal),
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("times out sandbox gh auth probes", async () => {
		vi.useFakeTimers();
		try {
			const sandbox = {
				exec: vi.fn(),
				execWithArgs: vi
					.fn()
					.mockResolvedValueOnce({
						stdout: "gh version 2.0.0",
						stderr: "",
						exitCode: 0,
					})
					.mockImplementationOnce(
						(
							_command: string,
							_args: string[] = [],
							_options?: { signal?: AbortSignal },
						) => new Promise(() => {}),
					),
				readFile: vi.fn(),
				writeFile: vi.fn(),
				exists: vi.fn(),
				dispose: vi.fn(),
			};

			const promise = checkGhCliAvailable(
				undefined,
				sandbox as unknown as Sandbox,
			);
			await vi.advanceTimersByTimeAsync(90_000);
			const result = await promise;

			expect(result?.isError).toBe(true);
			expect(getTextOutput(result!)).toContain("Command timed out after 90s");
			expect(sandbox.execWithArgs).toHaveBeenNthCalledWith(
				2,
				"gh",
				["auth", "status"],
				expect.objectContaining({
					signal: expect.any(AbortSignal),
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("times out sandbox gh commands even if execWithArgs never settles", async () => {
		vi.useFakeTimers();
		try {
			const sandbox = {
				exec: vi.fn(),
				execWithArgs: vi.fn(
					(
						_command: string,
						_args: string[] = [],
						_options?: { signal?: AbortSignal },
					) => new Promise(() => {}),
				),
				readFile: vi.fn(),
				writeFile: vi.fn(),
				exists: vi.fn(),
				dispose: vi.fn(),
			};
			let settled = false;

			const promise = executeGhCommand(
				"gh-sandbox-timeout",
				["pr", "checks"],
				undefined,
				sandbox as unknown as Sandbox,
			).then((result) => {
				settled = true;
				return result;
			});

			await vi.advanceTimersByTimeAsync(90_000);
			await Promise.resolve();

			expect(settled).toBe(true);
			const result = await promise;

			expect(result.isError).toBe(true);
			expect(getTextOutput(result)).toContain("Command timed out after 90s");
			expect(sandbox.execWithArgs).toHaveBeenCalledWith(
				"gh",
				["pr", "checks"],
				expect.objectContaining({
					signal: expect.any(AbortSignal),
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails closed when sandbox gh probes lack argv execution support", async () => {
		const sandbox = {
			exec: vi.fn(),
			readFile: vi.fn(),
			writeFile: vi.fn(),
			exists: vi.fn(),
			dispose: vi.fn(),
		};

		const result = await checkGhCliAvailable(
			undefined,
			sandbox as unknown as Sandbox,
		);

		expect(result?.isError).toBe(true);
		expect(getTextOutput(result!)).toContain(
			"require argv-capable sandbox support",
		);
		expect(bashToolMock.execute).not.toHaveBeenCalled();
		expect(sandbox.exec).not.toHaveBeenCalled();
	});

	it("times out sandbox gh probes after the default timeout", async () => {
		vi.useFakeTimers();
		try {
			const sandbox = {
				exec: vi.fn(),
				execWithArgs: vi.fn(
					(
						_command: string,
						_args: string[] = [],
						options?: { signal?: AbortSignal },
					) =>
						new Promise((resolve) => {
							options?.signal?.addEventListener(
								"abort",
								() =>
									resolve({
										stdout: "",
										stderr: "",
										exitCode: 1,
									}),
								{ once: true },
							);
						}),
				),
				readFile: vi.fn(),
				writeFile: vi.fn(),
				exists: vi.fn(),
				dispose: vi.fn(),
			};

			const promise = checkGhCliAvailable(
				undefined,
				sandbox as unknown as Sandbox,
			);
			await vi.advanceTimersByTimeAsync(90_000);
			const result = await promise;

			expect(result?.isError).toBe(true);
			expect(getTextOutput(result!)).toContain("Command timed out after 90s");
			expect(getTextOutput(result!)).not.toContain("not installed");
			expect(sandbox.execWithArgs).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports sandbox gh cancellations when the signal aborts during setup", async () => {
		const reentrantSignal = {
			aborted: false,
			reason: new Error("sandbox aborted"),
			addEventListener: vi.fn(() => {
				reentrantSignal.aborted = true;
			}),
			removeEventListener: vi.fn(),
		} as unknown as AbortSignal;
		const sandbox = {
			exec: vi.fn(),
			execWithArgs: vi.fn(
				(
					_command: string,
					_args: string[] = [],
					options?: { signal?: AbortSignal },
				) =>
					options?.signal?.aborted
						? Promise.reject(new Error("sandbox aborted"))
						: Promise.resolve({
								stdout: "",
								stderr: "",
								exitCode: 0,
							}),
			),
			readFile: vi.fn(),
			writeFile: vi.fn(),
			exists: vi.fn(),
			dispose: vi.fn(),
		};

		const result = await executeGhCommand(
			"gh-sandbox-abort-during-setup",
			["repo", "clone", "owner/repo"],
			reentrantSignal,
			sandbox as unknown as Sandbox,
		);

		expect(result.isError).toBe(true);
		expect(getTextOutput(result)).toContain("Command cancelled");
	});

	it("caps oversized stdout and reports truncation", async () => {
		const child = createMockChildProcess();
		childProcessMock.spawn.mockReturnValueOnce(child);

		const promise = executeGhCommand("gh-large-output", ["api", "repos"]);
		child.stdout.emit("data", Buffer.from("x".repeat(50 * 1024)));
		child.emit("close", 0);

		const result = await promise;
		const output = getTextOutput(result);
		const capturedOutput = output.split("\n\n")[0] ?? "";

		expect((capturedOutput.match(/x/g) ?? []).length).toBe(40 * 1024);
		expect(output).toContain("stdout exceeded 40KB limit and was truncated");
	});

	it("preserves isError when rewriting friendly auth failures", async () => {
		const child = createMockChildProcess();
		childProcessMock.spawn.mockReturnValueOnce(child);

		const promise = executeGhCommand("gh-auth-error", ["pr", "view", "1"]);
		child.stderr.emit(
			"data",
			Buffer.from("gh: not logged in\nRun: gh auth login"),
		);
		child.emit("close", 1);

		const result = await promise;

		expect(result.isError).toBe(true);
		expect(getTextOutput(result)).toContain("GitHub CLI is not authenticated.");
	});

	it("terminates gh after the default timeout", async () => {
		vi.useFakeTimers();
		try {
			const child = createMockChildProcess();
			childProcessMock.spawn.mockReturnValueOnce(child);

			const promise = executeGhCommand("gh-timeout", ["pr", "checks"]);
			await vi.advanceTimersByTimeAsync(90_000);

			expect(shellUtilsMock.killProcessTree).toHaveBeenCalledWith(1234);
			expect(child.kill).not.toHaveBeenCalled();

			child.emit("close", null);
			const result = await promise;

			expect(result.isError).toBe(true);
			expect(getTextOutput(result)).toContain("Command timed out after 90s");
		} finally {
			vi.useRealTimers();
		}
	});

	it("kills the process tree when aborted", async () => {
		const child = createMockChildProcess();
		childProcessMock.spawn.mockReturnValueOnce(child);
		const controller = new AbortController();

		const promise = executeGhCommand(
			"gh-abort",
			["repo", "clone"],
			controller.signal,
		);
		controller.abort();

		expect(shellUtilsMock.killProcessTree).toHaveBeenCalledWith(1234);
		expect(child.kill).not.toHaveBeenCalled();

		child.emit("close", null);
		const result = await promise;

		expect(result.isError).toBe(true);
		expect(getTextOutput(result)).toContain("Command cancelled");
		expect(getTextOutput(result)).not.toContain("Exit code: null");
	});
});
