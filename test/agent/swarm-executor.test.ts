import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	buildEvalOpsDelegationEnvironmentMock,
	issueEvalOpsDelegationTokenMock,
	spawnMock,
} = vi.hoisted(() => ({
	buildEvalOpsDelegationEnvironmentMock: vi.fn(),
	issueEvalOpsDelegationTokenMock: vi.fn(),
	spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

vi.mock("../../src/oauth/index.js", () => ({
	buildEvalOpsDelegationEnvironment: buildEvalOpsDelegationEnvironmentMock,
	issueEvalOpsDelegationToken: issueEvalOpsDelegationTokenMock,
}));

import { SwarmExecutor } from "../../src/agent/swarm/executor.js";
import type { SwarmConfig } from "../../src/agent/swarm/types.js";

const PARENT_ACCESS_VALUE = "parent-test";
const DELEGATED_ACCESS_VALUE = "child-test";

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

function createDeferredPromise<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function waitForSpawn(): Promise<void> {
	await vi.waitFor(() => {
		expect(spawnMock).toHaveBeenCalled();
	});
}

function getSpawnedTempFile(): string {
	const [, args] = spawnMock.mock.calls.at(-1) as [string, string[]];
	return args.at(-1)!;
}

describe("SwarmExecutor", () => {
	beforeEach(() => {
		buildEvalOpsDelegationEnvironmentMock.mockReset();
		buildEvalOpsDelegationEnvironmentMock.mockImplementation((result) => ({
			MAESTRO_EVALOPS_ACCESS_TOKEN: result.token,
			MAESTRO_EVALOPS_ORG_ID: result.organizationId,
			MAESTRO_EVALOPS_PROVIDER: result.providerRef.provider,
			MAESTRO_EVALOPS_ENVIRONMENT: result.providerRef.environment,
		}));
		issueEvalOpsDelegationTokenMock.mockReset();
		issueEvalOpsDelegationTokenMock.mockRejectedValue(
			new Error(
				"EvalOps delegation requires a valid access token. Run /login evalops first.",
			),
		);
		spawnMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("spawns the maestro CLI for teammate tasks", async () => {
		spawnMock.mockReturnValue(createMockChildProcess("done"));

		const executor = new SwarmExecutor(createConfig());
		void executor.execute();
		await waitForSpawn();

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
		await waitForSpawn();

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

	it("injects delegated EvalOps auth into teammate subprocesses when available", async () => {
		issueEvalOpsDelegationTokenMock.mockResolvedValue({
			agentId: "agent_teammate",
			expiresAt: Date.now() + 60_000,
			organizationId: "org_evalops",
			providerRef: {
				provider: "gateway",
				environment: "prod",
			},
			runId: "swarm-1:task-1",
			scopesDenied: [],
			scopesGranted: ["models:invoke"],
			scopesRequested: [],
			token: DELEGATED_ACCESS_VALUE,
			tokenType: "Bearer",
		});
		spawnMock.mockReturnValue(createMockChildProcess("done"));
		vi.stubEnv("MAESTRO_EVALOPS_ACCESS_TOKEN", PARENT_ACCESS_VALUE);
		vi.stubEnv("MAESTRO_EVALOPS_ORG_ID", "org_evalops");

		const executor = new SwarmExecutor(createConfig());
		void executor.execute();
		await waitForSpawn();

		expect(issueEvalOpsDelegationTokenMock).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: expect.any(String),
				agentType: "swarm_teammate",
				capabilities: ["swarm_task"],
				runId: expect.stringContaining(":task-1"),
				surface: "maestro-swarm",
				token: PARENT_ACCESS_VALUE,
				ttlSeconds: 60,
			}),
		);
		expect(spawnMock).toHaveBeenCalledWith(
			"maestro",
			expect.any(Array),
			expect.objectContaining({
				env: expect.objectContaining({
					MAESTRO_EVALOPS_ACCESS_TOKEN: DELEGATED_ACCESS_VALUE,
					MAESTRO_EVALOPS_ORG_ID: "org_evalops",
					MAESTRO_EVALOPS_PROVIDER: "gateway",
					MAESTRO_EVALOPS_ENVIRONMENT: "prod",
					MAESTRO_SWARM_MODE: "1",
				}),
			}),
		);
	});

	it("starts teammate delegation in parallel instead of serializing spawn setup", async () => {
		const firstDelegation = createDeferredPromise<{
			agentId: string;
			expiresAt: number;
			organizationId: string;
			providerRef: { provider: string; environment: string };
			runId: string;
			scopesDenied: string[];
			scopesGranted: string[];
			scopesRequested: string[];
			token: string;
			tokenType: string;
		}>();
		const secondDelegation = createDeferredPromise<{
			agentId: string;
			expiresAt: number;
			organizationId: string;
			providerRef: { provider: string; environment: string };
			runId: string;
			scopesDenied: string[];
			scopesGranted: string[];
			scopesRequested: string[];
			token: string;
			tokenType: string;
		}>();
		issueEvalOpsDelegationTokenMock
			.mockImplementationOnce(() => firstDelegation.promise)
			.mockImplementationOnce(() => secondDelegation.promise);
		spawnMock
			.mockReturnValueOnce(createMockChildProcess("done", 0, "manual"))
			.mockReturnValueOnce(createMockChildProcess("done", 0, "manual"));
		vi.stubEnv("MAESTRO_EVALOPS_ACCESS_TOKEN", PARENT_ACCESS_VALUE);
		vi.stubEnv("MAESTRO_EVALOPS_ORG_ID", "org_evalops");

		const executor = new SwarmExecutor(
			createMultiTaskConfig(
				[
					{ id: "task-1", prompt: "First task" },
					{ id: "task-2", prompt: "Second task" },
				],
				{ teammateCount: 2 },
			),
		);
		const execution = executor.execute();

		await vi.waitFor(() => {
			expect(issueEvalOpsDelegationTokenMock).toHaveBeenCalledTimes(2);
		});
		expect(spawnMock).not.toHaveBeenCalled();

		firstDelegation.resolve({
			agentId: "agent-1",
			expiresAt: Date.now() + 60_000,
			organizationId: "org_evalops",
			providerRef: {
				provider: "gateway",
				environment: "prod",
			},
			runId: "swarm-1:task-1",
			scopesDenied: [],
			scopesGranted: ["models:invoke"],
			scopesRequested: [],
			token: "child-1",
			tokenType: "Bearer",
		});
		secondDelegation.resolve({
			agentId: "agent-2",
			expiresAt: Date.now() + 60_000,
			organizationId: "org_evalops",
			providerRef: {
				provider: "gateway",
				environment: "prod",
			},
			runId: "swarm-1:task-2",
			scopesDenied: [],
			scopesGranted: ["models:invoke"],
			scopesRequested: [],
			token: "child-2",
			tokenType: "Bearer",
		});

		await vi.waitFor(() => {
			expect(spawnMock).toHaveBeenCalledTimes(2);
		});

		for (const result of spawnMock.mock.results) {
			result.value.emit("close", 0);
		}

		const result = await execution;
		expect(result.status).toBe("completed");
		expect(Array.from(result.completedTasks)).toEqual(
			expect.arrayContaining(["task-1", "task-2"]),
		);
	});

	it("falls back to inherited auth when EvalOps delegation fails", async () => {
		issueEvalOpsDelegationTokenMock.mockRejectedValue(
			new Error("identity_unavailable"),
		);
		spawnMock.mockReturnValue(createMockChildProcess("done"));
		vi.stubEnv("MAESTRO_EVALOPS_ACCESS_TOKEN", PARENT_ACCESS_VALUE);
		vi.stubEnv("MAESTRO_EVALOPS_ORG_ID", "org_evalops");

		const executor = new SwarmExecutor(createConfig());
		void executor.execute();
		await waitForSpawn();

		expect(buildEvalOpsDelegationEnvironmentMock).not.toHaveBeenCalled();
		expect(spawnMock).toHaveBeenCalledWith(
			"maestro",
			expect.any(Array),
			expect.objectContaining({
				env: expect.objectContaining({
					MAESTRO_EVALOPS_ACCESS_TOKEN: PARENT_ACCESS_VALUE,
					MAESTRO_EVALOPS_ORG_ID: "org_evalops",
					MAESTRO_SWARM_MODE: "1",
				}),
			}),
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
		await waitForSpawn();

		executor.cancel();
		proc.emit("close", 143);

		const result = await execution;
		expect(result.status).toBe("cancelled");
		expect(result.teammates[0]!.status).toBe("cancelled");
		expect(result.failedTasks.size).toBe(0);
	});

	it("cleans up teammate temp files and task state when the subprocess errors", async () => {
		const taskId = "task-error";
		const proc = createMockChildProcess("", 1, "manual");
		spawnMock.mockReturnValue(proc);

		const executor = new SwarmExecutor(createConfig({ id: taskId }));
		const execution = executor.execute();
		await waitForSpawn();

		const tempFile = getSpawnedTempFile();
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
		await waitForSpawn();
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
		await waitForSpawn();

		executor.cancel();

		const result = await execution;
		expect(result.status).toBe("cancelled");
		expect(result.activeTasks.size).toBe(0);
		expect(result.teammates[0]!.status).toBe("cancelled");
		expect(result.teammates[0]!.currentTask).toBeUndefined();
	});

	it("does not spawn a teammate after cancellation during async delegation setup", async () => {
		const delegation = createDeferredPromise<{
			agentId: string;
			expiresAt: number;
			organizationId: string;
			providerRef: { provider: string; environment: string };
			runId: string;
			scopesDenied: string[];
			scopesGranted: string[];
			scopesRequested: string[];
			token: string;
			tokenType: string;
		}>();
		const taskId = "task-cancelled-before-spawn";

		issueEvalOpsDelegationTokenMock.mockImplementation(
			() => delegation.promise,
		);
		const executor = new SwarmExecutor(createConfig({ id: taskId }));
		const execution = executor.execute();

		await vi.waitFor(() => {
			expect(issueEvalOpsDelegationTokenMock).toHaveBeenCalledTimes(1);
		});
		const [{ runId }] = issueEvalOpsDelegationTokenMock.mock.calls[0] as [
			{ runId: string },
		];
		const spawnedTempFile = join(
			tmpdir(),
			`${runId.split(":")[0]}-swarm-task-${taskId}.md`,
		);
		expect(existsSync(spawnedTempFile)).toBe(true);

		executor.cancel();
		delegation.resolve({
			agentId: "agent-cancelled",
			expiresAt: Date.now() + 60_000,
			organizationId: "org_evalops",
			providerRef: {
				provider: "gateway",
				environment: "prod",
			},
			runId: "swarm-1:task-cancelled-before-spawn",
			scopesDenied: [],
			scopesGranted: ["models:invoke"],
			scopesRequested: [],
			token: DELEGATED_ACCESS_VALUE,
			tokenType: "Bearer",
		});

		const result = await execution;
		expect(spawnMock).not.toHaveBeenCalled();
		expect(result.status).toBe("cancelled");
		expect(result.activeTasks.size).toBe(0);
		expect(result.teammates[0]!.status).toBe("cancelled");
		expect(result.teammates[0]!.currentTask).toBeUndefined();
		expect(existsSync(spawnedTempFile)).toBe(false);
	});

	it("keeps teammate temp prompt files inside the system temp directory", async () => {
		spawnMock.mockReturnValue(createMockChildProcess("done"));

		const executor = new SwarmExecutor(
			createConfig({ id: "../../swarm-path-traversal" }),
		);
		void executor.execute();
		await waitForSpawn();

		const [, args] = spawnMock.mock.calls[0] as [string, string[]];
		const tempFile = args.at(-1)!;
		expect(tempFile.startsWith(tmpdir())).toBe(true);
		expect(basename(tempFile)).toContain("swarm-task-swarm-path-traversal.md");
	});
});
