import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("ripgrep utils", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
		vi.doUnmock("node:child_process");
		vi.doUnmock("../../src/tools/tools-manager.js");
	});

	it("runs the managed ripgrep binary when it is available", async () => {
		const spawnCalls: Array<{ command: string; args: string[]; cwd?: string }> =
			[];
		vi.doMock("node:child_process", async () => {
			const actual =
				await vi.importActual<typeof import("node:child_process")>(
					"node:child_process",
				);
			return {
				...actual,
				spawn: vi.fn(
					(command: string, args: string[], options?: { cwd?: string }) => {
						spawnCalls.push({ command, args, cwd: options?.cwd });
						const child = new EventEmitter() as EventEmitter & {
							stdout: PassThrough;
							stderr: PassThrough;
							kill: ReturnType<typeof vi.fn>;
						};
						child.stdout = new PassThrough();
						child.stderr = new PassThrough();
						child.kill = vi.fn();
						process.nextTick(() => {
							child.stdout.end("match\n");
							child.stderr.end("");
							child.emit("close", 0);
						});
						return child;
					},
				),
			};
		});
		vi.doMock("../../src/tools/tools-manager.js", () => ({
			ensureTool: vi.fn(async () => "/managed/bin/rg"),
		}));

		const { runRipgrep } = await import("../../src/tools/ripgrep-utils.js");
		const result = await runRipgrep(["--files"], undefined, "/workspace");

		expect(result.stdout).toBe("match\n");
		expect(spawnCalls).toEqual([
			{ command: "/managed/bin/rg", args: ["--files"], cwd: "/workspace" },
		]);
	});

	it("reports a clear error when ripgrep cannot be resolved", async () => {
		vi.doMock("../../src/tools/tools-manager.js", () => ({
			ensureTool: vi.fn(async () => null),
		}));

		const { runRipgrep } = await import("../../src/tools/ripgrep-utils.js");

		await expect(runRipgrep(["--files"])).rejects.toThrow(
			"ripgrep is not available and could not be downloaded",
		);
	});

	it("does not resolve ripgrep when the call is already aborted", async () => {
		const ensureTool = vi.fn(async () => "/managed/bin/rg");
		vi.doMock("../../src/tools/tools-manager.js", () => ({
			ensureTool,
		}));
		const controller = new AbortController();
		controller.abort();

		const { runRipgrep } = await import("../../src/tools/ripgrep-utils.js");

		await expect(runRipgrep(["--files"], controller.signal)).rejects.toThrow(
			"ripgrep search aborted before start",
		);
		expect(ensureTool).not.toHaveBeenCalled();
	});

	it("does not wait for ripgrep resolution when aborted during lookup", async () => {
		let resolveEnsureTool!: (value: string | null) => void;
		const ensureTool = vi.fn(
			() =>
				new Promise<string | null>((resolve) => {
					resolveEnsureTool = resolve;
				}),
		);
		const spawn = vi.fn();
		vi.doMock("node:child_process", async () => {
			const actual =
				await vi.importActual<typeof import("node:child_process")>(
					"node:child_process",
				);
			return {
				...actual,
				spawn,
			};
		});
		vi.doMock("../../src/tools/tools-manager.js", () => ({
			ensureTool,
		}));
		const controller = new AbortController();

		const { runRipgrep } = await import("../../src/tools/ripgrep-utils.js");
		const pending = runRipgrep(["--files"], controller.signal);
		expect(ensureTool).toHaveBeenCalledTimes(1);

		controller.abort();

		await expect(pending).rejects.toThrow(
			"ripgrep search aborted before start",
		);
		expect(spawn).not.toHaveBeenCalled();

		resolveEnsureTool("/managed/bin/rg");
	});

	it("aborts shared managed ripgrep resolution when the last waiter aborts", async () => {
		let installSignal: AbortSignal | undefined;
		const spawn = vi.fn();
		const ensureTool = vi.fn(
			(_tool: string, _silent: boolean, signal?: AbortSignal) =>
				new Promise<string | null>((_resolve, reject) => {
					installSignal = signal;
					signal?.addEventListener(
						"abort",
						() => reject(new Error("managed ripgrep resolution aborted")),
						{ once: true },
					);
				}),
		);
		vi.doMock("node:child_process", async () => {
			const actual =
				await vi.importActual<typeof import("node:child_process")>(
					"node:child_process",
				);
			return {
				...actual,
				spawn,
			};
		});
		vi.doMock("../../src/tools/tools-manager.js", () => ({
			ensureTool,
		}));
		const controller = new AbortController();

		const { runRipgrep } = await import("../../src/tools/ripgrep-utils.js");
		const pending = runRipgrep(["--files"], controller.signal);

		expect(ensureTool).toHaveBeenCalledTimes(1);
		expect(installSignal).toBeDefined();
		expect(installSignal?.aborted).toBe(false);
		controller.abort();

		await expect(pending).rejects.toThrow(/aborted/);
		expect(installSignal?.aborted).toBe(true);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("starts a fresh managed ripgrep resolution after an aborted install retry window", async () => {
		let installCallCount = 0;
		let firstInstallSignal: AbortSignal | undefined;
		let resolveFirstInstall!: (value: string | null) => void;
		const spawnCalls: Array<{ command: string; args: string[] }> = [];
		vi.doMock("node:child_process", async () => {
			const actual =
				await vi.importActual<typeof import("node:child_process")>(
					"node:child_process",
				);
			return {
				...actual,
				spawn: vi.fn((command: string, args: string[]) => {
					spawnCalls.push({ command, args });
					const child = new EventEmitter() as EventEmitter & {
						stdout: PassThrough;
						stderr: PassThrough;
						kill: ReturnType<typeof vi.fn>;
					};
					child.stdout = new PassThrough();
					child.stderr = new PassThrough();
					child.kill = vi.fn();
					process.nextTick(() => {
						child.stdout.end("retry match\n");
						child.stderr.end("");
						child.emit("close", 0);
					});
					return child;
				}),
			};
		});
		const ensureTool = vi.fn(
			(_tool: string, _silent: boolean, signal?: AbortSignal) => {
				installCallCount += 1;
				if (installCallCount === 1) {
					firstInstallSignal = signal;
					return new Promise<string | null>((resolve) => {
						resolveFirstInstall = resolve;
					});
				}
				return Promise.resolve("/managed/bin/rg");
			},
		);
		vi.doMock("../../src/tools/tools-manager.js", () => ({
			ensureTool,
		}));
		const controller = new AbortController();

		const { runRipgrep } = await import("../../src/tools/ripgrep-utils.js");
		const abortedSearch = runRipgrep(["--files"], controller.signal);
		expect(ensureTool).toHaveBeenCalledTimes(1);
		expect(firstInstallSignal?.aborted).toBe(false);

		controller.abort();

		await expect(abortedSearch).rejects.toThrow(
			"ripgrep search aborted before start",
		);
		expect(firstInstallSignal?.aborted).toBe(true);

		const retrySearch = runRipgrep(["--files"]);
		expect(ensureTool).toHaveBeenCalledTimes(2);
		await expect(retrySearch).resolves.toEqual({
			stdout: "retry match\n",
			stderr: "",
			exitCode: 0,
			truncated: false,
		});
		expect(spawnCalls).toEqual([
			{ command: "/managed/bin/rg", args: ["--files"] },
		]);

		resolveFirstInstall("/managed/bin/rg");
		await Promise.resolve();
	});

	it("dedupes managed ripgrep resolution for concurrent signaled searches", async () => {
		let resolveEnsureTool!: (value: string | null) => void;
		let installSignal: AbortSignal | undefined;
		const ensureTool = vi.fn(
			(_tool: string, _silent: boolean, signal?: AbortSignal) =>
				new Promise<string | null>((resolve) => {
					installSignal = signal;
					resolveEnsureTool = resolve;
				}),
		);
		const spawnCalls: Array<{ command: string; args: string[] }> = [];
		vi.doMock("node:child_process", async () => {
			const actual =
				await vi.importActual<typeof import("node:child_process")>(
					"node:child_process",
				);
			return {
				...actual,
				spawn: vi.fn((command: string, args: string[]) => {
					spawnCalls.push({ command, args });
					const child = new EventEmitter() as EventEmitter & {
						stdout: PassThrough;
						stderr: PassThrough;
						kill: ReturnType<typeof vi.fn>;
					};
					child.stdout = new PassThrough();
					child.stderr = new PassThrough();
					child.kill = vi.fn();
					process.nextTick(() => {
						child.stdout.end("match\n");
						child.stderr.end("");
						child.emit("close", 0);
					});
					return child;
				}),
			};
		});
		vi.doMock("../../src/tools/tools-manager.js", () => ({
			ensureTool,
		}));
		const firstController = new AbortController();
		const secondController = new AbortController();

		const { runRipgrep } = await import("../../src/tools/ripgrep-utils.js");
		const first = runRipgrep(["--files"], firstController.signal);
		const second = runRipgrep(
			["--json", "needle", "."],
			secondController.signal,
		);

		expect(ensureTool).toHaveBeenCalledTimes(1);
		expect(installSignal).toBeDefined();
		resolveEnsureTool("/managed/bin/rg");

		await expect(Promise.all([first, second])).resolves.toEqual([
			{ stdout: "match\n", stderr: "", exitCode: 0, truncated: false },
			{ stdout: "match\n", stderr: "", exitCode: 0, truncated: false },
		]);
		expect(spawnCalls).toEqual([
			{ command: "/managed/bin/rg", args: ["--files"] },
			{ command: "/managed/bin/rg", args: ["--json", "needle", "."] },
		]);
		expect(installSignal?.aborted).toBe(false);
	});
});
