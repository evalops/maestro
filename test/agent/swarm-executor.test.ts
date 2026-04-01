import { EventEmitter } from "node:events";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

import { SwarmExecutor } from "../../src/agent/swarm/executor.js";
import type { SwarmConfig } from "../../src/agent/swarm/types.js";

function createMockChildProcess(
	output: string,
	closeCode = 0,
	closeMode: "microtask" | "timer" | "manual" = "microtask",
) {
	const proc = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		pid: number;
		kill: ReturnType<typeof vi.fn>;
	};
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.pid = 31337;
	proc.kill = vi.fn();

	const emitClose = () => {
		proc.stdout.emit("data", Buffer.from(output));
		proc.emit("close", closeCode);
	};

	if (closeMode === "timer") {
		setTimeout(emitClose, 0);
	} else if (closeMode === "microtask") {
		queueMicrotask(emitClose);
	}

	return proc;
}

function createConfig(
	taskOverrides: Partial<SwarmConfig["tasks"][number]> = {},
): SwarmConfig {
	return {
		teammateCount: 1,
		planFile: "/tmp/plan.md",
		tasks: [
			{
				id: "task-1",
				prompt: "Update the implementation",
				...taskOverrides,
			},
		],
		cwd: process.cwd(),
		taskTimeout: 1_000,
	};
}

function createMultiTaskConfig(
	tasks: SwarmConfig["tasks"],
	overrides: Partial<SwarmConfig> = {},
): SwarmConfig {
	return {
		teammateCount: 1,
		planFile: "/tmp/plan.md",
		tasks,
		cwd: process.cwd(),
		taskTimeout: 1_000,
		...overrides,
	};
}

describe("SwarmExecutor", () => {
	beforeEach(() => {
		spawnMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("spawns the maestro CLI for teammate tasks", async () => {
		spawnMock.mockReturnValue(createMockChildProcess("done"));

		const executor = new SwarmExecutor(createConfig());
		void executor.execute();
		await Promise.resolve();

		expect(spawnMock).toHaveBeenCalledWith(
			"maestro",
			expect.arrayContaining([
				"--no-session",
				"exec",
				expect.stringContaining("swarm-task-task-1.md"),
			]),
			expect.objectContaining({
				cwd: process.cwd(),
				stdio: ["pipe", "pipe", "pipe"],
				env: expect.objectContaining({
					MAESTRO_SWARM_MODE: "1",
					MAESTRO_TEAMMATE_ID: expect.any(String),
					MAESTRO_SWARM_ID: expect.any(String),
				}),
			}),
		);
	});

	it("completes when a teammate finishes successfully", async () => {
		spawnMock.mockReturnValue(createMockChildProcess("done", 0, "timer"));

		const executor = new SwarmExecutor(createConfig());
		const result = await Promise.race([
			executor.execute(),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("swarm execution timed out")), 250);
			}),
		]);

		expect(result.status).toBe("completed");
		expect(Array.from(result.completedTasks)).toContain("task-1");
		expect(result.failedTasks.size).toBe(0);
	});

	it("uses a task-level model override for teammate execution", async () => {
		spawnMock.mockReturnValue(createMockChildProcess("done"));

		const executor = new SwarmExecutor(
			createConfig({ model: "claude-sonnet-4-5-20250929" }),
		);
		void executor.execute();
		await Promise.resolve();

		expect(spawnMock).toHaveBeenCalledWith(
			"maestro",
			expect.arrayContaining([
				"--no-session",
				"--model",
				"claude-sonnet-4-5-20250929",
				"exec",
				expect.stringContaining("swarm-task-task-1.md"),
			]),
			expect.any(Object),
		);
	});

	it("returns an isolated state snapshot", () => {
		const executor = new SwarmExecutor(createConfig());

		const snapshot = executor.getState();
		snapshot.status = "failed";
		snapshot.teammates[0]!.status = "failed";
		snapshot.pendingTasks.length = 0;
		snapshot.activeTasks.set("task-x", "teammate-x");
		snapshot.completedTasks.add("task-x");
		snapshot.failedTasks.add("task-y");

		const fresh = executor.getState();
		expect(fresh.status).toBe("initializing");
		expect(fresh.teammates[0]!.status).toBe("pending");
		expect(fresh.pendingTasks).toHaveLength(1);
		expect(fresh.activeTasks.size).toBe(0);
		expect(fresh.completedTasks.size).toBe(0);
		expect(fresh.failedTasks.size).toBe(0);
	});

	it("preserves final teammate completion status in the returned swarm state", async () => {
		spawnMock.mockReturnValue(createMockChildProcess("done", 0, "timer"));

		const executor = new SwarmExecutor(createConfig());
		const result = await executor.execute();

		expect(result.status).toBe("completed");
		expect(result.teammates[0]!.status).toBe("completed");
		expect(result.teammates[0]!.completedTasks).toEqual(["task-1"]);
	});

	it("stays cancelled when a killed teammate exits after cancellation", async () => {
		const proc = createMockChildProcess("", 143, "manual");
		spawnMock.mockReturnValue(proc);

		const executor = new SwarmExecutor(createConfig());
		const execution = executor.execute();
		await Promise.resolve();

		executor.cancel();
		proc.emit("close", 143);

		const result = await execution;
		expect(result.status).toBe("cancelled");
		expect(result.teammates[0]!.status).toBe("cancelled");
		expect(result.failedTasks.size).toBe(0);
	});

	it("cleans up teammate temp files and task state when the subprocess errors", async () => {
		const taskId = "task-error";
		const tempFile = join(tmpdir(), `swarm-task-${taskId}.md`);
		rmSync(tempFile, { force: true });

		const proc = createMockChildProcess("", 1, "manual");
		spawnMock.mockReturnValue(proc);

		const executor = new SwarmExecutor(createConfig({ id: taskId }));
		const execution = executor.execute();
		await Promise.resolve();

		expect(existsSync(tempFile)).toBe(true);

		proc.emit("error", new Error("spawn failed"));

		const result = await execution;
		expect(result.status).toBe("failed");
		expect(result.teammates[0]!.status).toBe("failed");
		expect(result.teammates[0]!.currentTask).toBeUndefined();
		expect(existsSync(tempFile)).toBe(false);
	});

	it("recycles a teammate after a subprocess error when continueOnFailure is enabled", async () => {
		const firstProc = createMockChildProcess("", 1, "manual");
		spawnMock.mockReturnValue(firstProc);

		const executor = new SwarmExecutor(
			createMultiTaskConfig(
				[
					{ id: "task-1", prompt: "First task" },
					{ id: "task-2", prompt: "Second task" },
				],
				{ continueOnFailure: true },
			),
		);

		const execution = executor.execute();
		await Promise.resolve();
		try {
			firstProc.emit("error", new Error("spawn failed"));

			const stateAfterError = executor.getState();
			expect(stateAfterError.failedTasks.has("task-1")).toBe(true);
			expect(stateAfterError.pendingTasks.map((task) => task.id)).toContain(
				"task-2",
			);
			expect(stateAfterError.teammates[0]!.status).toBe("pending");
			expect(stateAfterError.teammates[0]!.currentTask).toBeUndefined();
		} finally {
			executor.cancel();
			await execution;
		}
	});

	it("clears active task bookkeeping immediately when cancelling a running swarm", async () => {
		const proc = createMockChildProcess("", 143, "manual");
		spawnMock.mockReturnValue(proc);

		const executor = new SwarmExecutor(createConfig());
		const execution = executor.execute();
		await Promise.resolve();

		executor.cancel();

		const result = await execution;
		expect(result.status).toBe("cancelled");
		expect(result.activeTasks.size).toBe(0);
		expect(result.teammates[0]!.status).toBe("cancelled");
		expect(result.teammates[0]!.currentTask).toBeUndefined();
	});

	it("keeps teammate temp prompt files inside the system temp directory", async () => {
		spawnMock.mockReturnValue(createMockChildProcess("done"));

		const executor = new SwarmExecutor(
			createConfig({ id: "../../swarm-path-traversal" }),
		);
		void executor.execute();
		await Promise.resolve();

		const [, args] = spawnMock.mock.calls[0] as [string, string[]];
		const tempFile = args.at(-1)!;
		expect(tempFile.startsWith(tmpdir())).toBe(true);
		expect(basename(tempFile)).toBe("swarm-task-swarm-path-traversal.md");
	});
});
