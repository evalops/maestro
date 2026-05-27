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
});
