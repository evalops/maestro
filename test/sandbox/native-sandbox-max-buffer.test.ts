import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
	exec: vi.fn(),
	spawn: vi.fn(),
}));

vi.mock("node:child_process", () => childProcessMock);
vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return {
		...actual,
		platform: () => "darwin",
	};
});

import { NativeSandbox } from "../../src/sandbox/native-sandbox.js";

type MockChildProcess = EventEmitter & {
	stdout: EventEmitter;
	stderr: EventEmitter;
};

function createMockChildProcess(): MockChildProcess {
	const child = new EventEmitter() as MockChildProcess;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	return child;
}

describe("NativeSandbox", () => {
	let testDir: string;

	beforeEach(() => {
		childProcessMock.exec.mockReset();
		childProcessMock.spawn.mockReset();
		testDir = join(tmpdir(), `native-sandbox-max-buffer-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("caps execWithArgs output to the provided buffer size", async () => {
		const sandbox = new NativeSandbox({ mode: "workspace-write" }, testDir);
		const child = createMockChildProcess();
		childProcessMock.spawn.mockReturnValueOnce(child);

		const promise = sandbox.execWithArgs("gh", ["api"], { maxBuffer: 1025 });
		await Promise.resolve();
		child.stdout.emit("data", Buffer.from("x".repeat(5000)));
		child.emit("close", 0);

		const result = await promise;

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toHaveLength(1025);
		expect(result.stderr).toBe("");
		expect(childProcessMock.spawn.mock.calls[0]?.[2]).not.toHaveProperty(
			"maxBuffer",
		);
	});

	it("treats signaled exec exits as failures", async () => {
		const sandbox = new NativeSandbox({ mode: "workspace-write" }, testDir);
		const child = createMockChildProcess();
		childProcessMock.spawn.mockReturnValueOnce(child);

		const promise = sandbox.exec("gh api");
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

	it("treats signaled execWithArgs exits as failures", async () => {
		const sandbox = new NativeSandbox({ mode: "workspace-write" }, testDir);
		const child = createMockChildProcess();
		childProcessMock.spawn.mockReturnValueOnce(child);

		const promise = sandbox.execWithArgs("gh", ["api"]);
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
});
