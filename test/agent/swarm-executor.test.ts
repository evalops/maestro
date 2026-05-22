import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	buildEvalOpsDelegationEnvironmentMock,
	cancelA2ATaskMock,
	getA2ATaskMock,
	issueEvalOpsDelegationTokenMock,
	listA2APeerCandidatesWithPlatformMock,
	recordSubagentDispatchMock,
	recordA2ATaskStartMock,
	resolveA2APeerMock,
	resolveAgentRegistryServiceConfigMock,
	spawnMock,
	sendA2AMessageMock,
	updateA2ATaskInLedgerMock,
} = vi.hoisted(() => ({
	buildEvalOpsDelegationEnvironmentMock: vi.fn(),
	cancelA2ATaskMock: vi.fn(),
	getA2ATaskMock: vi.fn(),
	issueEvalOpsDelegationTokenMock: vi.fn(),
	listA2APeerCandidatesWithPlatformMock: vi.fn(),
	recordSubagentDispatchMock: vi.fn(),
	recordA2ATaskStartMock: vi.fn(),
	resolveA2APeerMock: vi.fn(),
	resolveAgentRegistryServiceConfigMock: vi.fn(),
	spawnMock: vi.fn(),
	sendA2AMessageMock: vi.fn(),
	updateA2ATaskInLedgerMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

vi.mock("../../src/oauth/index.js", () => ({
	buildEvalOpsDelegationEnvironment: buildEvalOpsDelegationEnvironmentMock,
	issueEvalOpsDelegationToken: issueEvalOpsDelegationTokenMock,
}));

vi.mock("../../src/platform/a2a-client.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/platform/a2a-client.js")
	>("../../src/platform/a2a-client.js");
	return {
		...actual,
		cancelA2ATask: cancelA2ATaskMock,
		getA2ATask: getA2ATaskMock,
		sendA2AMessage: sendA2AMessageMock,
	};
});

vi.mock("../../src/platform/a2a-peer-registry.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/platform/a2a-peer-registry.js")
	>("../../src/platform/a2a-peer-registry.js");
	return {
		...actual,
		resolveA2APeer: resolveA2APeerMock,
	};
});

vi.mock("../../src/platform/a2a-task-ledger.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/platform/a2a-task-ledger.js")
	>("../../src/platform/a2a-task-ledger.js");
	return {
		...actual,
		recordA2ATaskStart: recordA2ATaskStartMock,
		updateA2ATaskInLedger: updateA2ATaskInLedgerMock,
	};
});

vi.mock("../../src/platform/agent-registry-client.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/platform/agent-registry-client.js")
	>("../../src/platform/agent-registry-client.js");
	return {
		...actual,
		listA2APeerCandidatesWithPlatform: listA2APeerCandidatesWithPlatformMock,
		resolveAgentRegistryServiceConfig: resolveAgentRegistryServiceConfigMock,
	};
});

vi.mock("../../src/telemetry.js", () => ({
	recordSubagentDispatch: recordSubagentDispatchMock,
}));

import { MODEL_BY_TIER } from "../../src/agent/modes.js";
import { SwarmExecutor } from "../../src/agent/swarm/executor.js";
import type { SwarmConfig } from "../../src/agent/swarm/types.js";

const PARENT_ACCESS_VALUE = "parent-test";
const DELEGATED_ACCESS_VALUE = "child-test";

function createMockChildProcess(
	output: string,
	closeCode = 0,
	closeMode: "microtask" | "timer" | "manual" = "microtask",
	emitSpawn = true,
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
	const emitSpawnEvent = () => {
		proc.emit("spawn");
	};

	if (closeMode === "timer") {
		if (emitSpawn) {
			queueMicrotask(emitSpawnEvent);
		}
		setTimeout(emitClose, 0);
	} else if (closeMode === "microtask") {
		queueMicrotask(() => {
			if (emitSpawn) {
				emitSpawnEvent();
			}
			emitClose();
		});
	} else if (emitSpawn) {
		queueMicrotask(emitSpawnEvent);
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

async function executeWithTimeout(
	executor: SwarmExecutor,
	timeoutMs = 500,
): Promise<Awaited<ReturnType<SwarmExecutor["execute"]>>> {
	return Promise.race([
		executor.execute(),
		new Promise<never>((_, reject) => {
			setTimeout(
				() => reject(new Error("swarm execution timed out")),
				timeoutMs,
			);
		}),
	]);
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
		recordSubagentDispatchMock.mockReset();
		resolveA2APeerMock.mockReset();
		resolveA2APeerMock.mockResolvedValue({
			name: "remote-a",
			entry: {
				url: "https://remote-a.example/a2a",
				displayName: "Remote A",
				skills: [
					{
						id: "maestro.subagent.code-writer",
						name: "Code Writer",
					},
				],
			},
			config: {
				baseUrl: "https://remote-a.example/a2a",
				agentId: "remote-a",
				timeoutMs: 25,
				maxAttempts: 1,
			},
		});
		cancelA2ATaskMock.mockReset();
		cancelA2ATaskMock.mockResolvedValue({
			id: "remote-task-1",
			contextId: "remote-context-1",
			status: { state: "TASK_STATE_CANCELLED" },
		});
		sendA2AMessageMock.mockReset();
		sendA2AMessageMock.mockResolvedValue({
			task: {
				id: "remote-task-1",
				contextId: "remote-context-1",
				status: { state: "TASK_STATE_WORKING" },
			},
		});
		getA2ATaskMock.mockReset();
		getA2ATaskMock.mockResolvedValue({
			id: "remote-task-1",
			contextId: "remote-context-1",
			status: { state: "TASK_STATE_COMPLETED" },
			artifacts: [
				{
					artifactId: "remote-result",
					parts: [{ text: "remote done", mediaType: "text/plain" }],
				},
			],
		});
		recordA2ATaskStartMock.mockReset();
		recordA2ATaskStartMock.mockResolvedValue(undefined);
		updateA2ATaskInLedgerMock.mockReset();
		updateA2ATaskInLedgerMock.mockResolvedValue(undefined);
		listA2APeerCandidatesWithPlatformMock.mockReset();
		listA2APeerCandidatesWithPlatformMock.mockResolvedValue([]);
		resolveAgentRegistryServiceConfigMock.mockReset();
		resolveAgentRegistryServiceConfigMock.mockResolvedValue({
			baseUrl: "https://platform.example",
			token: "platform-token",
			organizationId: "org_evalops",
			workspaceId: "workspace-default",
			timeoutMs: 25,
			maxAttempts: 1,
		});
		spawnMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("spawns the maestro CLI for teammate tasks", async () => {
		let prompt = "";
		spawnMock.mockImplementation((_command: string, args: string[]) => {
			prompt = readFileSync(args.at(-1)!, "utf-8");
			return createMockChildProcess("done");
		});

		const executor = new SwarmExecutor(createConfig());
		void executor.execute();
		await waitForSpawn();

		expect(prompt).toContain("## Goal\nComplete swarm task task-1");
		expect(prompt).toContain("## Context\nYou are teammate");
		expect(prompt).toContain("## Task\nUpdate the implementation");
		expect(prompt).toContain(
			"## Validation\nMake the requested changes directly",
		);
		expect(prompt).toContain(
			"## Stopping Condition\nStop when the assigned task is complete",
		);
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
		expect(recordSubagentDispatchMock).not.toHaveBeenCalled();
	});

	it("dispatches swarm teammate tasks to configured A2A peers", async () => {
		const executor = new SwarmExecutor({
			...createConfig({
				files: ["src/agent/swarm/executor.ts"],
				subagentType: "coder",
			}),
			transport: "a2a",
			a2a: {
				peers: ["remote-a"],
				role: "code-writer",
				tasksPath: "/tmp/maestro-a2a-tasks.json",
				maxWaitMs: 50,
				pollIntervalMs: 1,
			},
			mode: "smart",
			modelProvider: "anthropic",
		});

		const result = await executeWithTimeout(executor);

		expect(result.status).toBe("completed");
		expect(Array.from(result.completedTasks)).toContain("task-1");
		expect(result.teammates[0]!.output).toBe("remote done");
		expect(result.teammates[0]!.a2a).toEqual(
			expect.objectContaining({
				peer: "remote-a",
				peerDisplayName: "Remote A",
				source: "registry",
				taskId: "remote-task-1",
				contextId: "remote-context-1",
				messageId: expect.stringContaining("maestro-swarm-message-"),
				skillId: "maestro.subagent.code-writer",
				role: "code-writer",
			}),
		);
		expect(spawnMock).not.toHaveBeenCalled();
		expect(resolveA2APeerMock).toHaveBeenCalledWith(
			"remote-a",
			expect.objectContaining({
				path: undefined,
				timeoutMs: undefined,
				maxAttempts: undefined,
			}),
		);
		const [serviceConfig, input] = sendA2AMessageMock.mock.calls[0] as [
			{ baseUrl: string },
			{
				message: {
					contextId?: string;
					metadata?: Record<string, unknown>;
					parts: Array<{ text?: string }>;
				};
				metadata?: Record<string, unknown>;
			},
		];
		expect(serviceConfig).toEqual(
			expect.objectContaining({
				baseUrl: "https://remote-a.example/a2a",
				agentId: "remote-a",
			}),
		);
		expect(input.message.contextId).toBe(`maestro-swarm:${result.id}:task-1`);
		expect(input.message.parts[0]!.text).toContain(
			"## Task\nUpdate the implementation",
		);
		expect(input.message.metadata).toEqual(
			expect.objectContaining({
				requestKind: "maestro-swarm-task",
				transport: "a2a",
				relayPeer: "remote-a",
				a2aSkillId: "maestro.subagent.code-writer",
				files: ["src/agent/swarm/executor.ts"],
				swarm: expect.objectContaining({
					rootDelegationId: result.id,
					currentDelegationId: `${result.id}:task-1`,
				}),
				evalops: expect.objectContaining({
					transport: "a2a",
					peer: "remote-a",
				}),
				"evalops.subagentRequest": expect.objectContaining({
					skillId: "maestro.subagent.code-writer",
					role: "code-writer",
					taskId: "task-1",
					swarmId: result.id,
				}),
			}),
		);
		expect(input.metadata).toEqual(
			expect.objectContaining({
				route: "maestro_swarm",
				transport: "a2a",
				swarmId: result.id,
				taskId: "task-1",
				peer: "remote-a",
				source: "registry",
			}),
		);
		expect(recordA2ATaskStartMock).toHaveBeenCalledWith(
			expect.objectContaining({
				path: "/tmp/maestro-a2a-tasks.json",
				peer: "remote-a",
				peerDisplayName: "Remote A",
				kind: "delegation",
				role: "code-writer",
				contextId: "remote-context-1",
				metadata: expect.objectContaining({
					requestKind: "maestro-swarm-task",
					a2aSkillId: "maestro.subagent.code-writer",
				}),
			}),
		);
		expect(updateA2ATaskInLedgerMock).toHaveBeenCalledWith(
			expect.objectContaining({
				path: "/tmp/maestro-a2a-tasks.json",
				peer: "remote-a",
				task: expect.objectContaining({
					id: "remote-task-1",
					status: { state: "TASK_STATE_COMPLETED" },
				}),
			}),
		);
	});

	it("rotates configured A2A peers across successive tasks", async () => {
		const executor = new SwarmExecutor(
			createMultiTaskConfig(
				[
					{ id: "task-1", prompt: "First remote task" },
					{ id: "task-2", prompt: "Second remote task" },
					{ id: "task-3", prompt: "Third remote task" },
				],
				{
					transport: "a2a",
					a2a: {
						peers: ["remote-a", "remote-b"],
						maxWaitMs: 50,
						pollIntervalMs: 1,
					},
				},
			),
		);

		const result = await executeWithTimeout(executor);

		expect(result.status).toBe("completed");
		expect(resolveA2APeerMock.mock.calls.map((call) => call[0])).toEqual([
			"remote-a",
			"remote-b",
			"remote-a",
		]);
	});

	it("discovers and ranks A2A swarm peers through Platform Agent Registry", async () => {
		listA2APeerCandidatesWithPlatformMock.mockResolvedValue([
			{
				agent: {
					id: "agent-stale",
					name: "Stale Maestro",
					workspaceId: "workspace-1",
					status: "AGENT_STATUS_BUSY",
					lastHeartbeatAt: "2026-05-20T11:40:00.000Z",
				},
				endpointUrl: "https://stale.public/a2a",
				endpointKind: "public",
				pushNotifications: false,
				skills: [
					{
						id: "maestro.subagent.code-review",
						name: "Code Review",
						allowedTaskClasses: ["code.review"],
					},
				],
			},
			{
				agent: {
					id: "agent-target",
					name: "Target Maestro",
					workspaceId: "workspace-1",
					status: "AGENT_STATUS_IDLE",
					lastHeartbeatAt: new Date().toISOString(),
				},
				endpointUrl: "https://target.internal/a2a",
				endpointKind: "internal",
				pushNotifications: true,
				skills: [
					{
						id: "maestro.subagent.code-review",
						name: "Code Review",
						allowedTaskClasses: ["code.review"],
						approvalPolicyRef: "policy:code-review",
						requiredArtifactKinds: ["review.summary"],
					},
				],
			},
		]);
		const executor = new SwarmExecutor({
			...createConfig({ subagentType: "review" }),
			transport: "a2a",
			a2a: {
				discover: true,
				skillId: "maestro.subagent.code-review",
				workspaceId: "workspace-1",
				capability: "code-review",
				preferInternalEndpoint: true,
				limit: 3,
				maxWaitMs: 50,
				pollIntervalMs: 1,
			},
			mode: "smart",
			modelProvider: "anthropic",
		});

		const result = await executeWithTimeout(executor);

		expect(result.status).toBe("completed");
		expect(resolveA2APeerMock).not.toHaveBeenCalled();
		expect(listA2APeerCandidatesWithPlatformMock).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "workspace-1",
				capability: "code-review",
				surface: "a2a",
				status: "AGENT_STATUS_IDLE",
				limit: 3,
				skillId: "maestro.subagent.code-review",
				preferInternalEndpoint: true,
			}),
		);
		const [serviceConfig, input] = sendA2AMessageMock.mock.calls[0] as [
			{
				baseUrl: string;
				token?: string;
				organizationId?: string;
				agentId?: string;
			},
			{
				message: { metadata?: Record<string, unknown> };
				metadata?: Record<string, unknown>;
			},
		];
		expect(serviceConfig).toEqual(
			expect.objectContaining({
				baseUrl: "https://target.internal/a2a",
				token: "platform-token",
				organizationId: "org_evalops",
				workspaceId: "workspace-1",
				agentId: "agent-target",
				actorId: "maestro-swarm",
			}),
		);
		expect(input.message.metadata).toEqual(
			expect.objectContaining({
				relayPeer: "Target Maestro",
				a2aSkillId: "maestro.subagent.code-review",
			}),
		);
		expect(input.metadata).toEqual(
			expect.objectContaining({
				source: "platform-agent-registry",
				peer: "Target Maestro",
			}),
		);
	});

	it("normalizes swarm subagent types before capability policy filtering", async () => {
		listA2APeerCandidatesWithPlatformMock.mockResolvedValue([
			{
				agent: {
					id: "agent-denied",
					name: "Denied Maestro",
					workspaceId: "workspace-1",
					status: "AGENT_STATUS_IDLE",
					lastHeartbeatAt: new Date().toISOString(),
				},
				endpointUrl: "https://denied.internal/a2a",
				endpointKind: "internal",
				pushNotifications: true,
				skills: [
					{
						id: "maestro.subagent.code-review",
						name: "Code Review",
						deniedTaskClasses: ["code.review"],
					},
				],
			},
			{
				agent: {
					id: "agent-allowed",
					name: "Allowed Maestro",
					workspaceId: "workspace-1",
					status: "AGENT_STATUS_BUSY",
				},
				endpointUrl: "https://allowed.public/a2a",
				endpointKind: "public",
				skills: [
					{
						id: "maestro.subagent.code-review",
						name: "Code Review",
						allowedTaskClasses: ["code.review"],
					},
				],
			},
		]);
		const executor = new SwarmExecutor({
			...createConfig({ subagentType: "reviewer" }),
			transport: "a2a",
			a2a: {
				discover: true,
				workspaceId: "workspace-1",
				capability: "code-review",
				preferInternalEndpoint: true,
				maxWaitMs: 50,
				pollIntervalMs: 1,
			},
			mode: "smart",
			modelProvider: "anthropic",
		});

		const result = await executeWithTimeout(executor);

		expect(result.status).toBe("completed");
		expect(sendA2AMessageMock.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				baseUrl: "https://allowed.public/a2a",
				agentId: "agent-allowed",
			}),
		);
	});

	it("propagates the selected Platform skill when discovery had no explicit skill", async () => {
		listA2APeerCandidatesWithPlatformMock.mockResolvedValue([
			{
				agent: {
					id: "agent-multi-skill",
					name: "Multi Skill Maestro",
					workspaceId: "workspace-1",
					status: "AGENT_STATUS_IDLE",
					lastHeartbeatAt: new Date().toISOString(),
				},
				endpointUrl: "https://multi-skill.internal/a2a",
				endpointKind: "internal",
				pushNotifications: true,
				skills: [
					{
						id: "maestro.subagent.refactor",
						name: "Refactor",
						allowedTaskClasses: ["code.refactor"],
					},
					{
						id: "maestro.subagent.review",
						name: "Review",
						allowedTaskClasses: ["code.review"],
						approvalPolicyRef: "policy:code-review",
					},
				],
			},
		]);
		const executor = new SwarmExecutor({
			...createConfig(),
			transport: "a2a",
			a2a: {
				discover: true,
				workspaceId: "workspace-1",
				capability: "code",
				preferInternalEndpoint: true,
				maxWaitMs: 50,
				pollIntervalMs: 1,
			},
			mode: "smart",
			modelProvider: "anthropic",
		});

		const result = await executeWithTimeout(executor);

		expect(result.status).toBe("completed");
		expect(listA2APeerCandidatesWithPlatformMock).toHaveBeenCalledWith(
			expect.objectContaining({
				skillId: undefined,
			}),
		);
		expect(result.teammates[0]!.a2a).toEqual(
			expect.objectContaining({
				skillId: "maestro.subagent.review",
			}),
		);
		expect(sendA2AMessageMock.mock.calls[0]?.[1].message.metadata).toEqual(
			expect.objectContaining({
				a2aSkillId: "maestro.subagent.review",
				"evalops.subagentRequest": expect.objectContaining({
					skillId: "maestro.subagent.review",
				}),
			}),
		);
	});

	it("does not infer a Maestro task class for explicit custom A2A skills", async () => {
		listA2APeerCandidatesWithPlatformMock.mockResolvedValue([
			{
				agent: {
					id: "agent-custom",
					name: "Custom Reviewer",
					workspaceId: "workspace-1",
					status: "AGENT_STATUS_IDLE",
					lastHeartbeatAt: new Date().toISOString(),
				},
				endpointUrl: "https://custom.internal/a2a",
				endpointKind: "internal",
				skills: [
					{
						id: "vendor.custom.review",
						name: "Vendor Review",
						allowedTaskClasses: ["vendor.review"],
					},
				],
			},
		]);
		const executor = new SwarmExecutor({
			...createConfig({
				a2aSkillId: "vendor.custom.review",
				subagentType: "coder",
			}),
			transport: "a2a",
			a2a: {
				discover: true,
				workspaceId: "workspace-1",
				capability: "vendor-review",
				preferInternalEndpoint: true,
				maxWaitMs: 50,
				pollIntervalMs: 1,
			},
			mode: "smart",
			modelProvider: "anthropic",
		});

		const result = await executeWithTimeout(executor);

		expect(result.status).toBe("completed");
		expect(listA2APeerCandidatesWithPlatformMock).toHaveBeenCalledWith(
			expect.objectContaining({
				skillId: "vendor.custom.review",
			}),
		);
		expect(sendA2AMessageMock.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				baseUrl: "https://custom.internal/a2a",
				agentId: "agent-custom",
			}),
		);
	});

	it("honors task A2A peer pins during Platform discovery", async () => {
		listA2APeerCandidatesWithPlatformMock.mockResolvedValue([
			{
				agent: {
					id: "agent-round-robin-first",
					name: "Wrong Maestro",
					workspaceId: "workspace-1",
					status: "AGENT_STATUS_IDLE",
				},
				endpointUrl: "https://wrong.internal/a2a",
				endpointKind: "internal",
				skills: [{ id: "maestro.subagent.code-review", name: "Code Review" }],
			},
			{
				agent: {
					id: "agent-pinned",
					name: "Pinned Maestro",
					workspaceId: "workspace-1",
					status: "AGENT_STATUS_IDLE",
				},
				endpointUrl: "https://pinned.internal/a2a",
				endpointKind: "internal",
				skills: [{ id: "maestro.subagent.code-review", name: "Code Review" }],
			},
		]);
		const executor = new SwarmExecutor({
			...createConfig({
				a2aPeer: "agent-pinned",
				subagentType: "review",
			}),
			transport: "a2a",
			a2a: {
				discover: true,
				skillId: "maestro.subagent.code-review",
				workspaceId: "workspace-1",
				capability: "code-review",
				preferInternalEndpoint: true,
				maxWaitMs: 50,
				pollIntervalMs: 1,
			},
			mode: "smart",
			modelProvider: "anthropic",
		});

		const result = await executeWithTimeout(executor);

		expect(result.status).toBe("completed");
		expect(listA2APeerCandidatesWithPlatformMock).toHaveBeenCalledWith(
			expect.objectContaining({
				limit: undefined,
				skillId: "maestro.subagent.code-review",
			}),
		);
		expect(sendA2AMessageMock.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				baseUrl: "https://pinned.internal/a2a",
				agentId: "agent-pinned",
			}),
		);
		expect(sendA2AMessageMock.mock.calls[0]?.[1].message.metadata).toEqual(
			expect.objectContaining({
				relayPeer: "Pinned Maestro",
			}),
		);
	});

	it("rotates discovered A2A candidates across successive tasks", async () => {
		listA2APeerCandidatesWithPlatformMock.mockResolvedValue([
			{
				agent: {
					id: "agent-a",
					name: "Agent A",
					workspaceId: "workspace-1",
					status: "AGENT_STATUS_IDLE",
				},
				endpointUrl: "https://agent-a.internal/a2a",
				endpointKind: "internal",
				skills: [{ id: "maestro.subagent.code-review", name: "Code Review" }],
			},
			{
				agent: {
					id: "agent-b",
					name: "Agent B",
					workspaceId: "workspace-1",
					status: "AGENT_STATUS_IDLE",
				},
				endpointUrl: "https://agent-b.internal/a2a",
				endpointKind: "internal",
				skills: [{ id: "maestro.subagent.code-review", name: "Code Review" }],
			},
		]);
		const executor = new SwarmExecutor(
			createMultiTaskConfig(
				[
					{
						id: "task-1",
						prompt: "First remote review",
						subagentType: "review",
					},
					{
						id: "task-2",
						prompt: "Second remote review",
						subagentType: "review",
					},
				],
				{
					transport: "a2a",
					a2a: {
						discover: true,
						skillId: "maestro.subagent.code-review",
						workspaceId: "workspace-1",
						capability: "code-review",
						preferInternalEndpoint: true,
						maxWaitMs: 50,
						pollIntervalMs: 1,
					},
					mode: "smart",
					modelProvider: "anthropic",
				},
			),
		);

		const result = await executeWithTimeout(executor);

		expect(result.status).toBe("completed");
		expect(listA2APeerCandidatesWithPlatformMock).toHaveBeenCalledWith(
			expect.objectContaining({
				limit: 2,
			}),
		);
		expect(
			sendA2AMessageMock.mock.calls.map((call) => call[0].baseUrl),
		).toEqual(["https://agent-a.internal/a2a", "https://agent-b.internal/a2a"]);
	});

	it("fails remote A2A tasks that finish in an action-required state", async () => {
		getA2ATaskMock.mockResolvedValue({
			id: "remote-task-1",
			contextId: "remote-context-1",
			status: {
				state: "TASK_STATE_INPUT_REQUIRED",
				message: {
					messageId: "need-input",
					role: "ROLE_AGENT",
					parts: [{ text: "Need credentials", mediaType: "text/plain" }],
				},
			},
		});
		const executor = new SwarmExecutor({
			...createConfig(),
			transport: "a2a",
			a2a: {
				peers: ["remote-a"],
				maxWaitMs: 50,
				pollIntervalMs: 1,
			},
		});

		const result = await executeWithTimeout(executor);

		expect(result.status).toBe("failed");
		expect(result.failedTasks.has("task-1")).toBe(true);
		expect(result.teammates[0]!.status).toBe("failed");
		expect(result.teammates[0]!.output).toBe("Need credentials");
		expect(result.teammates[0]!.error).toContain("TASK_STATE_INPUT_REQUIRED");
		expect(updateA2ATaskInLedgerMock).toHaveBeenCalledWith(
			expect.objectContaining({
				task: expect.objectContaining({
					status: expect.objectContaining({
						state: "TASK_STATE_INPUT_REQUIRED",
					}),
				}),
			}),
		);
	});

	it("recycles a remote A2A teammate after a dispatch error when continueOnFailure is enabled", async () => {
		resolveA2APeerMock.mockRejectedValueOnce(new Error("peer unavailable"));
		const executor = new SwarmExecutor(
			createMultiTaskConfig(
				[
					{ id: "task-1", prompt: "First remote task" },
					{ id: "task-2", prompt: "Second remote task" },
				],
				{
					continueOnFailure: true,
					transport: "a2a",
					a2a: {
						peers: ["remote-a"],
						maxWaitMs: 50,
						pollIntervalMs: 1,
					},
				},
			),
		);

		const result = await executeWithTimeout(executor);

		expect(resolveA2APeerMock).toHaveBeenCalledTimes(2);
		expect(sendA2AMessageMock).toHaveBeenCalledTimes(1);
		expect(result.failedTasks.has("task-1")).toBe(true);
		expect(result.completedTasks.has("task-2")).toBe(true);
		expect(result.teammates[0]!.status).toBe("completed");
		expect(result.teammates[0]!.completedTasks).toEqual(["task-2"]);
	});

	it("clears stale A2A metadata when a recycled teammate later fails before dispatch", async () => {
		resolveA2APeerMock
			.mockResolvedValueOnce({
				name: "remote-a",
				entry: {
					url: "https://remote-a.example/a2a",
					displayName: "Remote A",
					skills: [{ id: "maestro.subagent.code-writer", name: "Code Writer" }],
				},
				config: {
					baseUrl: "https://remote-a.example/a2a",
					agentId: "remote-a",
					timeoutMs: 25,
					maxAttempts: 1,
				},
			})
			.mockRejectedValueOnce(new Error("peer unavailable"));
		const executor = new SwarmExecutor(
			createMultiTaskConfig(
				[
					{ id: "task-1", prompt: "First remote task" },
					{ id: "task-2", prompt: "Second remote task" },
				],
				{
					continueOnFailure: true,
					transport: "a2a",
					a2a: {
						peers: ["remote-a"],
						maxWaitMs: 50,
						pollIntervalMs: 1,
					},
				},
			),
		);

		const result = await executeWithTimeout(executor);

		expect(result.status).toBe("completed");
		expect(result.completedTasks.has("task-1")).toBe(true);
		expect(result.failedTasks.has("task-2")).toBe(true);
		expect(result.teammates[0]!.status).toBe("failed");
		expect(result.teammates[0]!.a2a).toBeUndefined();
	});

	it("cancels remote A2A tasks when the swarm is cancelled", async () => {
		const remotePoll = createDeferredPromise<{
			id: string;
			contextId: string;
			status: { state: string };
		}>();
		getA2ATaskMock.mockReturnValue(remotePoll.promise);
		const executor = new SwarmExecutor({
			...createConfig(),
			transport: "a2a",
			a2a: {
				peers: ["remote-a"],
				maxWaitMs: 5_000,
				pollIntervalMs: 1,
			},
		});

		const execution = executor.execute();
		await vi.waitFor(() => {
			expect(getA2ATaskMock).toHaveBeenCalled();
		});

		executor.cancel();
		remotePoll.resolve({
			id: "remote-task-1",
			contextId: "remote-context-1",
			status: { state: "TASK_STATE_CANCELLED" },
		});
		const result = await execution;

		expect(result.status).toBe("cancelled");
		expect(result.teammates[0]!.status).toBe("cancelled");
		expect(result.teammates[0]!.a2a).toEqual(
			expect.objectContaining({
				peer: "remote-a",
				taskId: "remote-task-1",
				contextId: "remote-context-1",
			}),
		);
		await vi.waitFor(() => {
			expect(cancelA2ATaskMock).toHaveBeenCalledWith(
				expect.objectContaining({
					baseUrl: "https://remote-a.example/a2a",
				}),
				"remote-task-1",
			);
		});
		expect(updateA2ATaskInLedgerMock).toHaveBeenCalledWith(
			expect.objectContaining({
				peer: "remote-a",
				task: expect.objectContaining({
					status: { state: "TASK_STATE_CANCELLED" },
				}),
			}),
		);
	});

	it("cancels a remote A2A task accepted during a cancel-send race", async () => {
		const remoteSend = createDeferredPromise<{
			task: {
				id: string;
				contextId: string;
				status: { state: string };
			};
		}>();
		sendA2AMessageMock.mockReturnValueOnce(remoteSend.promise);
		const executor = new SwarmExecutor({
			...createConfig(),
			transport: "a2a",
			a2a: {
				peers: ["remote-a"],
				maxWaitMs: 5_000,
				pollIntervalMs: 1,
			},
		});

		const execution = executor.execute();
		await vi.waitFor(() => {
			expect(sendA2AMessageMock).toHaveBeenCalled();
		});
		expect(sendA2AMessageMock.mock.calls[0]?.[2]).toBeUndefined();

		executor.cancel();
		remoteSend.resolve({
			task: {
				id: "remote-task-1",
				contextId: "remote-context-1",
				status: { state: "TASK_STATE_WORKING" },
			},
		});
		const result = await execution;

		expect(result.status).toBe("cancelled");
		await vi.waitFor(() => {
			expect(cancelA2ATaskMock).toHaveBeenCalledWith(
				expect.objectContaining({
					baseUrl: "https://remote-a.example/a2a",
				}),
				"remote-task-1",
			);
		});
	});

	it("cancels remote A2A tasks when polling times out", async () => {
		getA2ATaskMock.mockResolvedValue({
			id: "remote-task-1",
			contextId: "remote-context-1",
			status: { state: "TASK_STATE_WORKING" },
		});
		const executor = new SwarmExecutor({
			...createConfig(),
			transport: "a2a",
			a2a: {
				peers: ["remote-a"],
				maxWaitMs: 5,
				pollIntervalMs: 1,
			},
		});

		const result = await executeWithTimeout(executor);

		expect(result.status).toBe("failed");
		expect(result.failedTasks.has("task-1")).toBe(true);
		expect(result.teammates[0]!.error).toContain(
			"Timed out waiting for remote A2A task remote-task-1",
		);
		expect(cancelA2ATaskMock).toHaveBeenCalledWith(
			expect.objectContaining({
				baseUrl: "https://remote-a.example/a2a",
			}),
			"remote-task-1",
		);
		expect(updateA2ATaskInLedgerMock).toHaveBeenCalledWith(
			expect.objectContaining({
				peer: "remote-a",
				task: expect.objectContaining({
					status: { state: "TASK_STATE_CANCELLED" },
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

	it("reports task-level model overrides while preserving the dispatch decision", async () => {
		spawnMock.mockImplementation(() => createMockChildProcess("done"));

		const executor = new SwarmExecutor({
			...createConfig({
				model: "openai/gpt-4.1",
				subagentType: "coder",
			}),
			mode: "smart",
			modelProvider: "anthropic",
		});
		void executor.execute();
		await waitForSpawn();

		const [, args, options] = spawnMock.mock.calls.at(-1) as [
			string,
			string[],
			{ env: Record<string, string> },
		];
		expect(args).toEqual(
			expect.arrayContaining([
				"--no-session",
				"--model",
				"openai/gpt-4.1",
				"exec",
				expect.stringContaining("swarm-task-task-1.md"),
			]),
		);
		expect(args).not.toContain("--provider");
		expect(options.env).toEqual(
			expect.objectContaining({
				MAESTRO_SWARM_SUBAGENT_TYPE: "coder",
				MAESTRO_SWARM_MODEL: "openai/gpt-4.1",
				MAESTRO_SWARM_MODEL_PROVIDER: "openai",
				MAESTRO_SWARM_DISPATCH_SOURCE: "override",
			}),
		);
		await vi.waitFor(() => {
			expect(recordSubagentDispatchMock).toHaveBeenCalledWith(
				expect.objectContaining({
					mode: "smart",
					subagentType: "coder",
					provider: "openai",
					model: "openai/gpt-4.1",
					reasoningEffort: "medium",
					source: "override",
					success: true,
					latencyMs: expect.any(Number),
					metadata: expect.objectContaining({
						taskId: "task-1",
						teammateId: expect.any(String),
						parentMode: "smart",
						parentModelProvider: "anthropic",
						dispatchModel: "gpt-5.5",
						dispatchProvider: "openai-codex",
						dispatchSource: "mode",
						modelOverride: "task",
					}),
				}),
			);
		});
	});

	it("resolves teammate model from mode subagent dispatch when task has no model override", async () => {
		spawnMock.mockImplementation(() => createMockChildProcess("done"));

		const executor = new SwarmExecutor({
			...createConfig({
				subagentType: "coder",
			}),
			mode: "smart",
			modelProvider: "anthropic",
		});
		void executor.execute();
		await waitForSpawn();

		expect(spawnMock).toHaveBeenCalledWith(
			"maestro",
			expect.arrayContaining([
				"--provider",
				"openai-codex",
				"--model",
				"gpt-5.5",
			]),
			expect.objectContaining({
				env: expect.objectContaining({
					MAESTRO_SWARM_SUBAGENT_TYPE: "coder",
					MAESTRO_SWARM_MODEL_PROVIDER: "openai-codex",
					MAESTRO_SWARM_REASONING_EFFORT: "medium",
				}),
			}),
		);
		await vi.waitFor(() => {
			expect(recordSubagentDispatchMock).toHaveBeenCalledWith(
				expect.objectContaining({
					mode: "smart",
					subagentType: "coder",
					provider: "openai-codex",
					model: "gpt-5.5",
					reasoningEffort: "medium",
					source: "mode",
					success: true,
					latencyMs: expect.any(Number),
					metadata: expect.objectContaining({
						taskId: "task-1",
						teammateId: expect.any(String),
						parentMode: "smart",
						parentModelProvider: "anthropic",
					}),
				}),
			);
		});
	});

	it("does not report dispatch success when cancelled before teammate spawn", async () => {
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
		issueEvalOpsDelegationTokenMock.mockReturnValue(delegation.promise);
		vi.stubEnv("MAESTRO_EVALOPS_ACCESS_TOKEN", PARENT_ACCESS_VALUE);
		spawnMock.mockReturnValue(createMockChildProcess("done"));

		const executor = new SwarmExecutor({
			...createConfig({ subagentType: "coder" }),
			mode: "smart",
			modelProvider: "anthropic",
		});
		const execution = executor.execute();

		await vi.waitFor(() => {
			expect(issueEvalOpsDelegationTokenMock).toHaveBeenCalled();
		});
		executor.cancel();
		delegation.resolve({
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

		const result = await execution;
		expect(result.status).toBe("cancelled");
		expect(spawnMock).not.toHaveBeenCalled();
		expect(recordSubagentDispatchMock).not.toHaveBeenCalled();
	});

	it("reports dispatch failure when teammate process fails before spawning", async () => {
		const proc = createMockChildProcess("", 1, "manual", false);
		spawnMock.mockReturnValue(proc);

		const executor = new SwarmExecutor({
			...createConfig({ subagentType: "coder" }),
			mode: "smart",
			modelProvider: "anthropic",
		});
		const execution = executor.execute();
		await waitForSpawn();

		proc.emit("error", new Error("spawn ENOENT"));

		const result = await execution;
		expect(result.status).toBe("failed");
		expect(recordSubagentDispatchMock).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "smart",
				subagentType: "coder",
				provider: "openai-codex",
				model: "gpt-5.5",
				source: "mode",
				success: false,
				latencyMs: expect.any(Number),
				metadata: expect.objectContaining({
					taskId: "task-1",
					teammateId: expect.any(String),
					parentMode: "smart",
					parentModelProvider: "anthropic",
					reason: "spawn_error",
				}),
			}),
		);
	});

	it("inherits the parent provider from env for tier-routed subagents", async () => {
		spawnMock.mockReturnValue(createMockChildProcess("done"));
		vi.stubEnv("MAESTRO_MODEL_PROVIDER", "google");

		const executor = new SwarmExecutor({
			...createConfig({
				subagentType: "researcher",
			}),
			mode: "smart",
		});
		void executor.execute();
		await waitForSpawn();

		expect(spawnMock).toHaveBeenCalledWith(
			"maestro",
			expect.arrayContaining([
				"--provider",
				"google",
				"--model",
				MODEL_BY_TIER.sonnet.google,
			]),
			expect.objectContaining({
				env: expect.objectContaining({
					MAESTRO_SWARM_SUBAGENT_TYPE: "researcher",
					MAESTRO_SWARM_MODEL_PROVIDER: "google",
					MAESTRO_SWARM_REASONING_EFFORT: "medium",
				}),
			}),
		);
	});

	it("inherits the parent mode from env for subagent dispatch", async () => {
		spawnMock.mockReturnValue(createMockChildProcess("done"));
		vi.stubEnv("MAESTRO_MODE", "rush");
		vi.stubEnv("MAESTRO_MODEL_PROVIDER", "google");

		const executor = new SwarmExecutor(
			createConfig({
				subagentType: "planner",
			}),
		);
		void executor.execute();
		await waitForSpawn();

		expect(spawnMock).toHaveBeenCalledWith(
			"maestro",
			expect.arrayContaining([
				"--provider",
				"google",
				"--model",
				MODEL_BY_TIER.sonnet.google,
			]),
			expect.objectContaining({
				env: expect.objectContaining({
					MAESTRO_SWARM_MODE_NAME: "rush",
					MAESTRO_SWARM_SUBAGENT_TYPE: "planner",
					MAESTRO_SWARM_MODEL_PROVIDER: "google",
				}),
			}),
		);
	});

	it("keeps tier-routed subagents provider-neutral when parent provider is unknown", async () => {
		spawnMock.mockReturnValue(createMockChildProcess("done"));

		const executor = new SwarmExecutor({
			...createConfig({
				subagentType: "researcher",
			}),
			mode: "smart",
		});
		void executor.execute();
		await waitForSpawn();

		const [, args] = spawnMock.mock.calls.at(-1) as [string, string[]];
		expect(args).not.toContain("--provider");
		expect(args).not.toContain("--model");
		expect(args).toEqual(
			expect.arrayContaining([
				"--no-session",
				"exec",
				expect.stringContaining("swarm-task-task-1.md"),
			]),
		);
		expect(recordSubagentDispatchMock).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "smart",
				subagentType: "researcher",
				provider: "anthropic",
				model: MODEL_BY_TIER.sonnet.anthropic,
				reasoningEffort: "medium",
				source: "mode",
				success: false,
				latencyMs: expect.any(Number),
				metadata: expect.objectContaining({
					taskId: "task-1",
					teammateId: expect.any(String),
					parentMode: "smart",
					modelTier: "sonnet",
					reason: "missing_parent_model_provider",
				}),
			}),
		);
	});

	it("allows task model overrides when tier-routed parent provider is unknown", async () => {
		spawnMock.mockImplementation(() => createMockChildProcess("done"));

		const executor = new SwarmExecutor({
			...createConfig({
				model: "openai/gpt-4.1",
				subagentType: "researcher",
			}),
			mode: "smart",
		});
		void executor.execute();
		await waitForSpawn();

		const [, args, options] = spawnMock.mock.calls.at(-1) as [
			string,
			string[],
			{ env: Record<string, string> },
		];
		expect(args).toEqual(
			expect.arrayContaining([
				"--no-session",
				"--model",
				"openai/gpt-4.1",
				"exec",
				expect.stringContaining("swarm-task-task-1.md"),
			]),
		);
		expect(args).not.toContain("--provider");
		expect(options.env).toEqual(
			expect.objectContaining({
				MAESTRO_SWARM_MODEL: "openai/gpt-4.1",
				MAESTRO_SWARM_MODEL_PROVIDER: "openai",
				MAESTRO_SWARM_DISPATCH_SOURCE: "override",
			}),
		);
		await vi.waitFor(() => {
			expect(recordSubagentDispatchMock).toHaveBeenCalledWith(
				expect.objectContaining({
					mode: "smart",
					subagentType: "researcher",
					provider: "openai",
					model: "openai/gpt-4.1",
					source: "override",
					success: true,
					metadata: expect.objectContaining({
						dispatchModel: MODEL_BY_TIER.sonnet.anthropic,
						dispatchProvider: "anthropic",
						modelOverride: "task",
						modelTier: "sonnet",
					}),
				}),
			);
		});
		expect(recordSubagentDispatchMock).toHaveBeenCalledTimes(1);
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

	it("does not run tasks whose dependencies failed", async () => {
		const events: Array<{
			type: string;
			taskId?: string;
			error?: string;
		}> = [];
		spawnMock.mockReturnValue(createMockChildProcess("", 1, "timer"));

		const executor = new SwarmExecutor(
			createMultiTaskConfig(
				[
					{ id: "task-1", prompt: "First task" },
					{
						id: "task-2",
						prompt: "Second task",
						dependsOn: ["task-1"],
					},
				],
				{ continueOnFailure: true },
			),
		);
		executor.onEvent((event) => events.push(event));

		const result = await executeWithTimeout(executor);

		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(result.failedTasks.has("task-1")).toBe(true);
		expect(result.failedTasks.has("task-2")).toBe(true);
		expect(result.completedTasks.has("task-2")).toBe(false);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "task_fail",
				taskId: "task-2",
				error: "Dependency task-1 failed",
			}),
		);
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
		const tempFile = join(
			tmpdir(),
			`${runId.split(":")[0]}-swarm-task-${taskId}.md`,
		);
		expect(existsSync(tempFile)).toBe(true);

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
		expect(existsSync(tempFile)).toBe(false);
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
