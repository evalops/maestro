import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
	spawn: vi.fn(),
}));

vi.mock("node:child_process", async () => {
	const actual =
		await vi.importActual<typeof import("node:child_process")>(
			"node:child_process",
		);
	return {
		...actual,
		spawn: childProcessMock.spawn,
	};
});

import { LocalSandbox } from "../../src/sandbox/local-sandbox.js";

type MockChildProcess = EventEmitter & {
	pid?: number;
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill: ReturnType<typeof vi.fn>;
};

function createMockChildProcess(pid = 1234): MockChildProcess {
	const child = new EventEmitter() as MockChildProcess;
	child.pid = pid;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn();
	return child;
}

describe("LocalSandbox", () => {
	beforeEach(() => {
		childProcessMock.spawn.mockReset();
	});

	it("caps execWithArgs stdout while preserving the child exit code", async () => {
		const sandbox = new LocalSandbox();
		const child = createMockChildProcess();
		childProcessMock.spawn.mockReturnValueOnce(child);

		const promise = sandbox.execWithArgs(
			process.execPath,
			["-e", "process.stdout.write('x'.repeat(5000))"],
			{ maxBuffer: 1025 },
		);
		await Promise.resolve();
		child.stdout.emit("data", Buffer.from("x".repeat(5000)));
		child.emit("close", 0);

		const result = await promise;

		expect(childProcessMock.spawn).toHaveBeenCalledWith(
			process.execPath,
			["-e", "process.stdout.write('x'.repeat(5000))"],
			expect.objectContaining({
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toHaveLength(1025);
		expect(result.stderr).toBe("");
	});

	it("treats signaled execWithArgs exits as failures", async () => {
		const sandbox = new LocalSandbox();
		const child = createMockChildProcess();
		childProcessMock.spawn.mockReturnValueOnce(child);

		const promise = sandbox.execWithArgs("gh", ["pr", "view", "1"]);
		await Promise.resolve();
		child.stdout.emit("data", Buffer.from("partial output"));
		child.stderr.emit("data", Buffer.from("terminated by signal"));
		child.emit("close", null, "SIGKILL");

		await expect(promise).resolves.toEqual({
			stdout: "partial output",
			stderr: "terminated by signal",
			exitCode: 1,
		});
	});

	it("preserves spawn error messages when execWithArgs rejects before stderr streams", async () => {
		const sandbox = new LocalSandbox();
		const child = createMockChildProcess();
		childProcessMock.spawn.mockReturnValueOnce(child);

		const promise = sandbox.execWithArgs("missing-gh", ["--version"]);
		await Promise.resolve();
		child.emit(
			"error",
			Object.assign(new Error("spawn missing-gh ENOENT"), { code: "ENOENT" }),
		);

		await expect(promise).resolves.toEqual({
			stdout: "",
			stderr: "spawn missing-gh ENOENT",
			exitCode: 1,
		});
	});

	it("terminates the spawned process group when execWithArgs is aborted", async () => {
		const sandbox = new LocalSandbox();
		const child = createMockChildProcess(4321);
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
		const controller = new AbortController();
		childProcessMock.spawn.mockReturnValueOnce(child);

		try {
			const promise = sandbox.execWithArgs(
				"gh",
				["repo", "clone", "owner/repo"],
				{
					signal: controller.signal,
				},
			);
			await Promise.resolve();

			controller.abort();
			child.emit("close", null, "SIGTERM");

			await expect(promise).resolves.toEqual({
				stdout: "",
				stderr: "",
				exitCode: 1,
			});
			expect(killSpy).toHaveBeenCalledWith(-4321, "SIGTERM");
			expect(child.kill).not.toHaveBeenCalled();
		} finally {
			killSpy.mockRestore();
		}
	});
});
