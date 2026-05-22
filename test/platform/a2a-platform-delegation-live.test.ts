import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type PlatformA2ALiveSmokeDependencies,
	type PlatformA2ALiveSmokeEvidence,
	resolvePlatformA2ALiveSmokeEnv,
	runPlatformA2ADelegationLiveSmoke,
	sha256Hex,
} from "../../scripts/smoke-platform-a2a-delegation-live.js";
import { verifyPlatformA2ALiveEvidenceFile } from "../../scripts/verify-platform-a2a-live-evidence.js";
import {
	PlatformA2ADelegationTaskControlModeValue,
	type PlatformAgentRegistryA2APeerCandidate,
	type PlatformAgentRegistryGetA2ADelegationGraphResult,
} from "../../src/platform/agent-registry-client.js";

const baseEnv = {
	MAESTRO_AGENT_REGISTRY_SERVICE_URL: "https://platform.test",
	MAESTRO_AGENT_REGISTRY_SERVICE_TOKEN: "registry-token",
	MAESTRO_AGENT_REGISTRY_ORG_ID: "org_1",
	MAESTRO_AGENT_REGISTRY_WORKSPACE_ID: "ws_1",
	MAESTRO_A2A_LIVE_FROM_AGENT_ID: "maestro-origin",
	MAESTRO_A2A_LIVE_TO_AGENT_ID: "maestro-target",
	MAESTRO_A2A_LIVE_SKILL_ID: "maestro.subagent.repo-explorer",
	MAESTRO_A2A_LIVE_OBSERVE_INTERVAL_MS: "1",
	MAESTRO_A2A_LIVE_TASK_INTERVAL_MS: "1",
} satisfies Record<string, string>;

function peer(
	id: string,
	endpointUrl: string,
): PlatformAgentRegistryA2APeerCandidate {
	return {
		agent: {
			id,
			workspaceId: "ws_1",
			name: id,
			agentType: "maestro",
			status: "AGENT_STATUS_IDLE",
			activeConfigVersion: 7,
			lastHeartbeatAt: "2026-05-21T19:59:30.000Z",
			a2a: {
				publicEndpointUrl: endpointUrl,
				agentCardUrl: `${endpointUrl}/.well-known/agent-card.json`,
				agentCardObservedAt: "2026-05-21T19:59:40.000Z",
				protocolBinding: "HTTP+JSON",
				protocolVersion: "1.0",
				skills: [{ id: "maestro.subagent.repo-explorer" }],
			},
			capacity: {
				current: 0,
				max: 4,
				remaining: 4,
			},
		},
		endpointUrl,
		endpointKind: "public",
		agentCardUrl: `${endpointUrl}/.well-known/agent-card.json`,
		protocolBinding: "HTTP+JSON",
		protocolVersion: "1.0",
		skills: [{ id: "maestro.subagent.repo-explorer" }],
	};
}

function graph(
	a2aTaskId?: string,
): PlatformAgentRegistryGetA2ADelegationGraphResult {
	return {
		rootDelegationId: "delegation_1",
		total: 1,
		truncated: false,
		nodes: [
			{
				depth: 0,
				childCount: 0,
				terminal: false,
				delegation: {
					id: "delegation_1",
					workspaceId: "ws_1",
					fromAgentId: "maestro-origin",
					toAgentId: "maestro-target",
					status: "DELEGATION_STATUS_ACCEPTED",
					a2aTaskId,
					a2aDispatchStatus: a2aTaskId ? "dispatched" : "pending",
					a2aEndpointUrl: "https://target.test/a2a",
					a2aSkillId: "maestro.subagent.repo-explorer",
					a2aRootDelegationId: "delegation_1",
				},
			},
		],
		edges: [],
	};
}

describe("Platform A2A live delegation smoke", () => {
	it("fails before network work when required env is missing", () => {
		expect(() => resolvePlatformA2ALiveSmokeEnv({})).toThrow(
			/MAESTRO_AGENT_REGISTRY_SERVICE_URL/,
		);
	});

	it("runs the live proof path and writes redacted evidence", async () => {
		let writtenEvidence: PlatformA2ALiveSmokeEvidence | undefined;
		const dependencies: Partial<PlatformA2ALiveSmokeDependencies> = {
			now: () => new Date("2026-05-21T20:00:00.000Z"),
			sleep: vi.fn(async () => undefined),
			log: vi.fn(),
			gitSha: () => "1234567890abcdef1234567890abcdef12345678",
			resolveConfig: vi.fn(async () => ({
				baseUrl: "https://process-config.test",
				token: ["process", "config", "token"].join("-"),
				organizationId: "process-org",
				workspaceId: "process-workspace",
				timeoutMs: 2_000,
				maxAttempts: 1,
			})),
			listPeers: vi.fn(async () => [
				peer("maestro-origin", "https://origin.test/a2a"),
				peer("maestro-target", "https://target.test/a2a"),
			]),
			delegate: vi.fn(async () => ({
				delegation: {
					id: "delegation_1",
					workspaceId: "ws_1",
					fromAgentId: "maestro-origin",
					toAgentId: "maestro-target",
					status: "DELEGATION_STATUS_ACCEPTED",
				},
			})),
			getGraph: vi
				.fn()
				.mockResolvedValueOnce(graph())
				.mockResolvedValueOnce(graph("task_1")),
			control: vi.fn(async () => ({
				delegation: graph("task_1").nodes[0]?.delegation,
				remoteTask: {
					taskId: "task_1",
					state: "TASK_STATE_WORKING",
					controlId: "control_1",
					controlMode: PlatformA2ADelegationTaskControlModeValue.Collect,
					queuedForWorker: true,
					observedAt: "2026-05-21T20:00:01.000Z",
				},
			})),
			getTask: vi
				.fn()
				.mockResolvedValueOnce({
					id: "task_1",
					contextId: "ctx_1",
					status: { state: "TASK_STATE_WORKING" },
				})
				.mockResolvedValueOnce({
					id: "task_1",
					contextId: "ctx_1",
					status: { state: "TASK_STATE_COMPLETED" },
				}),
			writeEvidence: vi.fn(async (_outputDir, evidence) => {
				writtenEvidence = evidence;
				return "/tmp/platform-a2a-delegation-live/evidence.json";
			}),
		};

		const result = await runPlatformA2ADelegationLiveSmoke({
			env: {
				...baseEnv,
				GITHUB_REPOSITORY: "evalops/maestro-internal",
				GITHUB_RUN_ID: "26252628231",
				GITHUB_SHA: "1234567890abcdef1234567890abcdef12345678",
				GITHUB_REF: "refs/pull/2070/merge",
				GITHUB_EVENT_NAME: "pull_request",
				GITHUB_SERVER_URL: "https://github.com",
			},
			dependencies,
		});

		expect(result.evidencePath).toBe(
			"/tmp/platform-a2a-delegation-live/evidence.json",
		);
		expect(result.evidence).toMatchObject({
			live: true,
			workspaceId: "ws_1",
			inputs: {
				promptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
			maestro: {
				gitSha: "1234567890abcdef1234567890abcdef12345678",
			},
			github: {
				repository: "evalops/maestro-internal",
				runId: "26252628231",
				runUrl:
					"https://github.com/evalops/maestro-internal/actions/runs/26252628231",
				sha: "1234567890abcdef1234567890abcdef12345678",
				pullRequestNumber: 2070,
				pullRequestUrl: "https://github.com/evalops/maestro-internal/pull/2070",
			},
			delegation: {
				id: "delegation_1",
				a2aTaskId: "task_1",
			},
			task: {
				id: "task_1",
				state: "TASK_STATE_COMPLETED",
				terminal: true,
			},
		});
		expect(JSON.stringify(writtenEvidence)).not.toContain("registry-token");
		expect(JSON.stringify(writtenEvidence)).not.toContain(
			"acknowledge delegation",
		);
		expect(dependencies.listPeers).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "ws_1",
				skillId: "maestro.subagent.repo-explorer",
				requireA2ADispatch: true,
				eligibleForDelegation: true,
			}),
			expect.objectContaining({
				config: expect.objectContaining({
					baseUrl: "https://platform.test",
					token: "registry-token",
					organizationId: "org_1",
					workspaceId: "ws_1",
				}),
			}),
		);
		expect(dependencies.sleep).toHaveBeenCalled();
	});

	it("retries transient delegation graph lookup failures", async () => {
		const sleep = vi.fn(async () => undefined);
		const getGraph = vi
			.fn()
			.mockRejectedValueOnce(new Error("upstream timeout"))
			.mockResolvedValueOnce(graph("task_1"));
		const dependencies: Partial<PlatformA2ALiveSmokeDependencies> = {
			now: () => new Date("2026-05-21T20:00:00.000Z"),
			sleep,
			log: vi.fn(),
			gitSha: () => "1234567890abcdef1234567890abcdef12345678",
			resolveConfig: vi.fn(async () => ({
				baseUrl: "https://platform.test",
				token: "registry-token",
				organizationId: "org_1",
				workspaceId: "ws_1",
				timeoutMs: 2_000,
				maxAttempts: 1,
			})),
			listPeers: vi.fn(async () => [
				peer("maestro-origin", "https://origin.test/a2a"),
				peer("maestro-target", "https://target.test/a2a"),
			]),
			delegate: vi.fn(async () => ({
				delegation: {
					id: "delegation_1",
					workspaceId: "ws_1",
					fromAgentId: "maestro-origin",
					toAgentId: "maestro-target",
					status: "DELEGATION_STATUS_ACCEPTED",
				},
			})),
			getGraph,
			control: vi.fn(async () => ({
				delegation: graph("task_1").nodes[0]?.delegation,
				remoteTask: {
					taskId: "task_1",
					state: "TASK_STATE_COMPLETED",
					controlMode: PlatformA2ADelegationTaskControlModeValue.Collect,
				},
			})),
			getTask: vi.fn(async () => ({
				id: "task_1",
				contextId: "ctx_1",
				status: { state: "TASK_STATE_COMPLETED" },
			})),
			writeEvidence: vi.fn(async () => {
				return "/tmp/platform-a2a-delegation-live/evidence.json";
			}),
		};

		await runPlatformA2ADelegationLiveSmoke({
			env: {
				...baseEnv,
				MAESTRO_A2A_LIVE_OBSERVE_ATTEMPTS: "2",
			},
			dependencies,
		});

		expect(getGraph).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(1);
	});

	it("discovers the origin peer without target skill filters", async () => {
		const origin = peer("maestro-origin", "https://origin.test/a2a");
		origin.skills = [];
		if (origin.agent.a2a) {
			origin.agent.a2a.skills = [];
		}
		const target = peer("maestro-target", "https://target.test/a2a");
		const listPeers = vi
			.fn()
			.mockResolvedValueOnce([target])
			.mockResolvedValueOnce([origin]);
		const dependencies: Partial<PlatformA2ALiveSmokeDependencies> = {
			now: () => new Date("2026-05-21T20:00:00.000Z"),
			sleep: vi.fn(async () => undefined),
			log: vi.fn(),
			gitSha: () => "1234567890abcdef1234567890abcdef12345678",
			resolveConfig: vi.fn(async () => ({
				baseUrl: "https://platform.test",
				token: "registry-token",
				organizationId: "org_1",
				workspaceId: "ws_1",
				timeoutMs: 2_000,
				maxAttempts: 1,
			})),
			listPeers,
			delegate: vi.fn(async () => ({
				delegation: {
					id: "delegation_1",
					workspaceId: "ws_1",
					fromAgentId: "maestro-origin",
					toAgentId: "maestro-target",
					status: "DELEGATION_STATUS_ACCEPTED",
				},
			})),
			getGraph: vi.fn(async () => graph("task_1")),
			control: vi.fn(async () => ({
				delegation: graph("task_1").nodes[0]?.delegation,
				remoteTask: {
					taskId: "task_1",
					state: "TASK_STATE_COMPLETED",
					controlMode: PlatformA2ADelegationTaskControlModeValue.Collect,
				},
			})),
			getTask: vi.fn(async () => ({
				id: "task_1",
				contextId: "ctx_1",
				status: { state: "TASK_STATE_COMPLETED" },
			})),
			writeEvidence: vi.fn(async () => {
				return "/tmp/platform-a2a-delegation-live/evidence.json";
			}),
		};

		const result = await runPlatformA2ADelegationLiveSmoke({
			env: baseEnv,
			dependencies,
		});

		expect(result.evidence.peers.origin.agentId).toBe("maestro-origin");
		expect(result.evidence.peers.target.agentId).toBe("maestro-target");
		expect(listPeers).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				workspaceId: "ws_1",
				skillId: "maestro.subagent.repo-explorer",
				requireA2ADispatch: true,
				eligibleForDelegation: true,
			}),
			expect.any(Object),
		);
		expect(listPeers.mock.calls[1]?.[0]).toEqual({
			workspaceId: "ws_1",
			limit: 100,
			requireA2ADispatch: true,
		});
	});

	it("fails after exhausting transient delegation graph lookup retries", async () => {
		const sleep = vi.fn(async () => undefined);
		const getGraph = vi.fn(async () => {
			throw new Error("upstream timeout");
		});
		const dependencies: Partial<PlatformA2ALiveSmokeDependencies> = {
			now: () => new Date("2026-05-21T20:00:00.000Z"),
			sleep,
			log: vi.fn(),
			resolveConfig: vi.fn(async () => ({
				baseUrl: "https://platform.test",
				token: "registry-token",
				organizationId: "org_1",
				workspaceId: "ws_1",
				timeoutMs: 2_000,
				maxAttempts: 1,
			})),
			listPeers: vi.fn(async () => [
				peer("maestro-origin", "https://origin.test/a2a"),
				peer("maestro-target", "https://target.test/a2a"),
			]),
			delegate: vi.fn(async () => ({
				delegation: { id: "delegation_1" },
			})),
			getGraph,
		};

		await expect(
			runPlatformA2ADelegationLiveSmoke({
				env: {
					...baseEnv,
					MAESTRO_A2A_LIVE_OBSERVE_ATTEMPTS: "2",
				},
				dependencies,
			}),
		).rejects.toThrow(/upstream timeout/);

		expect(getGraph).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(sleep).toHaveBeenCalledWith(1);
	});

	it("fails before writing evidence when control omits the remote task id", async () => {
		const writeEvidence = vi.fn(async () => {
			return "/tmp/platform-a2a-delegation-live/evidence.json";
		});
		const dependencies: Partial<PlatformA2ALiveSmokeDependencies> = {
			now: () => new Date("2026-05-21T20:00:00.000Z"),
			sleep: vi.fn(async () => undefined),
			log: vi.fn(),
			gitSha: () => "1234567890abcdef1234567890abcdef12345678",
			resolveConfig: vi.fn(async () => ({
				baseUrl: "https://platform.test",
				token: "registry-token",
				organizationId: "org_1",
				workspaceId: "ws_1",
				timeoutMs: 2_000,
				maxAttempts: 1,
			})),
			listPeers: vi.fn(async () => [
				peer("maestro-origin", "https://origin.test/a2a"),
				peer("maestro-target", "https://target.test/a2a"),
			]),
			delegate: vi.fn(async () => ({
				delegation: {
					id: "delegation_1",
					workspaceId: "ws_1",
					fromAgentId: "maestro-origin",
					toAgentId: "maestro-target",
					status: "DELEGATION_STATUS_ACCEPTED",
				},
			})),
			getGraph: vi.fn(async () => graph("task_1")),
			control: vi.fn(async () => ({
				delegation: graph("task_1").nodes[0]?.delegation,
			})),
			getTask: vi.fn(async () => ({
				id: "task_1",
				contextId: "ctx_1",
				status: { state: "TASK_STATE_COMPLETED" },
			})),
			writeEvidence,
		};

		await expect(
			runPlatformA2ADelegationLiveSmoke({
				env: baseEnv,
				dependencies,
			}),
		).rejects.toThrow(/did not return remoteTask\.taskId/);

		expect(writeEvidence).not.toHaveBeenCalled();
	});

	it("retries transient remote task fetch failures during observation", async () => {
		const sleep = vi.fn(async () => undefined);
		const getTask = vi
			.fn()
			.mockRejectedValueOnce(new Error("remote task not propagated yet"))
			.mockResolvedValueOnce({
				id: "task_1",
				contextId: "ctx_1",
				status: { state: "TASK_STATE_COMPLETED" },
			});
		const dependencies: Partial<PlatformA2ALiveSmokeDependencies> = {
			now: () => new Date("2026-05-21T20:00:00.000Z"),
			sleep,
			log: vi.fn(),
			gitSha: () => "1234567890abcdef1234567890abcdef12345678",
			resolveConfig: vi.fn(async () => ({
				baseUrl: "https://platform.test",
				token: "registry-token",
				organizationId: "org_1",
				workspaceId: "ws_1",
				timeoutMs: 2_000,
				maxAttempts: 1,
			})),
			listPeers: vi.fn(async () => [
				peer("maestro-origin", "https://origin.test/a2a"),
				peer("maestro-target", "https://target.test/a2a"),
			]),
			delegate: vi.fn(async () => ({
				delegation: {
					id: "delegation_1",
					workspaceId: "ws_1",
					fromAgentId: "maestro-origin",
					toAgentId: "maestro-target",
					status: "DELEGATION_STATUS_ACCEPTED",
				},
			})),
			getGraph: vi.fn(async () => graph("task_1")),
			control: vi.fn(async () => ({
				delegation: graph("task_1").nodes[0]?.delegation,
				remoteTask: {
					taskId: "task_1",
					state: "TASK_STATE_COMPLETED",
					controlMode: PlatformA2ADelegationTaskControlModeValue.Collect,
				},
			})),
			getTask,
			writeEvidence: vi.fn(async () => {
				return "/tmp/platform-a2a-delegation-live/evidence.json";
			}),
		};

		const result = await runPlatformA2ADelegationLiveSmoke({
			env: {
				...baseEnv,
				MAESTRO_A2A_LIVE_TASK_ATTEMPTS: "2",
			},
			dependencies,
		});

		expect(result.evidence.task.id).toBe("task_1");
		expect(getTask).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(1);
	});

	it("uses supplied env credentials for Platform calls", async () => {
		let writtenEvidence: PlatformA2ALiveSmokeEvidence | undefined;
		const listPeers = vi.fn(async () => [
			peer("maestro-origin", "https://origin.test/a2a"),
			peer("maestro-target", "https://target.test/a2a"),
		]);
		const delegate = vi.fn(async () => ({
			delegation: {
				id: "delegation_1",
				workspaceId: "ws_1",
				fromAgentId: "maestro-origin",
				toAgentId: "maestro-target",
				status: "DELEGATION_STATUS_ACCEPTED",
			},
		}));
		const dependencies: Partial<PlatformA2ALiveSmokeDependencies> = {
			now: () => new Date("2026-05-21T20:00:00.000Z"),
			sleep: vi.fn(async () => undefined),
			log: vi.fn(),
			gitSha: () => "1234567890abcdef1234567890abcdef12345678",
			resolveConfig: vi.fn(async () => null),
			listPeers,
			delegate,
			getGraph: vi.fn(async () => graph("task_1")),
			control: vi.fn(async () => ({
				delegation: graph("task_1").nodes[0]?.delegation,
				remoteTask: {
					taskId: "task_1",
					state: "TASK_STATE_COMPLETED",
					controlMode: PlatformA2ADelegationTaskControlModeValue.Collect,
				},
			})),
			getTask: vi.fn(async () => ({
				id: "task_1",
				contextId: "ctx_1",
				status: { state: "TASK_STATE_COMPLETED" },
			})),
			writeEvidence: vi.fn(async (_outputDir, evidence) => {
				writtenEvidence = evidence;
				return "/tmp/platform-a2a-delegation-live/evidence.json";
			}),
		};

		await runPlatformA2ADelegationLiveSmoke({
			env: {
				...baseEnv,
				MAESTRO_AGENT_REGISTRY_SERVICE_URL: "https://env-platform.test",
				MAESTRO_AGENT_REGISTRY_SERVICE_TOKEN: "env-registry-token",
				GITHUB_EVENT_NAME: "push",
				GITHUB_REF: "refs/heads/release/2026",
				GITHUB_REF_NAME: "release/2026",
				GITHUB_REPOSITORY: "evalops/maestro-internal",
			},
			dependencies,
		});

		expect(listPeers).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				config: expect.objectContaining({
					baseUrl: "https://env-platform.test",
					token: "env-registry-token",
					organizationId: "org_1",
					workspaceId: "ws_1",
				}),
			}),
		);
		expect(delegate).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				config: expect.objectContaining({
					baseUrl: "https://env-platform.test",
					token: "env-registry-token",
				}),
			}),
		);
		expect(writtenEvidence?.github).toMatchObject({
			eventName: "push",
			ref: "refs/heads/release/2026",
			repository: "evalops/maestro-internal",
		});
		expect(writtenEvidence?.github?.pullRequestNumber).toBeUndefined();
		expect(writtenEvidence?.github?.pullRequestUrl).toBeUndefined();
	});

	it("records an invalid-token rejection when the negative auth probe is required", async () => {
		const listPeers = vi
			.fn()
			.mockRejectedValueOnce(new Error("401 unauthorized"))
			.mockResolvedValueOnce([
				peer("maestro-origin", "https://origin.test/a2a"),
				peer("maestro-target", "https://target.test/a2a"),
			]);
		const dependencies: Partial<PlatformA2ALiveSmokeDependencies> = {
			now: () => new Date("2026-05-21T20:00:00.000Z"),
			sleep: vi.fn(async () => undefined),
			log: vi.fn(),
			gitSha: () => "1234567890abcdef1234567890abcdef12345678",
			resolveConfig: vi.fn(async () => ({
				baseUrl: "https://platform.test",
				token: "registry-token",
				organizationId: "org_1",
				workspaceId: "ws_1",
				timeoutMs: 2_000,
				maxAttempts: 1,
			})),
			listPeers,
			delegate: vi.fn(async () => ({
				delegation: {
					id: "delegation_1",
					workspaceId: "ws_1",
					fromAgentId: "maestro-origin",
					toAgentId: "maestro-target",
					status: "DELEGATION_STATUS_ACCEPTED",
				},
			})),
			getGraph: vi.fn(async () => graph("task_1")),
			control: vi.fn(async () => ({
				delegation: graph("task_1").nodes[0]?.delegation,
				remoteTask: {
					taskId: "task_1",
					state: "TASK_STATE_COMPLETED",
					controlMode: PlatformA2ADelegationTaskControlModeValue.Collect,
				},
			})),
			getTask: vi.fn(async () => ({
				id: "task_1",
				contextId: "ctx_1",
				status: { state: "TASK_STATE_COMPLETED" },
			})),
			writeEvidence: vi.fn(async (_outputDir, _evidence) => {
				return "/tmp/platform-a2a-delegation-live/evidence.json";
			}),
		};

		const result = await runPlatformA2ADelegationLiveSmoke({
			env: {
				...baseEnv,
				MAESTRO_A2A_LIVE_REQUIRE_INVALID_TOKEN_PROBE: "true",
			},
			dependencies,
		});

		expect(result.evidence.negativeAuthProbe).toEqual({
			surface: "platform-agent-registry-peer-discovery",
			rejected: true,
			errorClass: "unauthorized",
			observedAt: "2026-05-21T20:00:00.000Z",
		});
		expect(listPeers).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ limit: 1, workspaceId: "ws_1" }),
			expect.objectContaining({
				config: expect.objectContaining({
					token: [
						"maestro",
						"a2a",
						"live",
						"smoke",
						"rejected",
						"auth",
						"probe",
					].join("-"),
				}),
			}),
		);
		expect(listPeers).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ limit: 100, workspaceId: "ws_1" }),
			expect.objectContaining({
				config: expect.objectContaining({ token: "registry-token" }),
			}),
		);
	});

	it("refuses live proof evidence when the invalid-token probe is accepted", async () => {
		const dependencies: Partial<PlatformA2ALiveSmokeDependencies> = {
			resolveConfig: vi.fn(async () => ({
				baseUrl: "https://platform.test",
				token: "registry-token",
				organizationId: "org_1",
				workspaceId: "ws_1",
				timeoutMs: 2_000,
				maxAttempts: 1,
			})),
			listPeers: vi.fn(async () => []),
		};

		await expect(
			runPlatformA2ADelegationLiveSmoke({
				env: {
					...baseEnv,
					MAESTRO_A2A_LIVE_REQUIRE_INVALID_TOKEN_PROBE: "true",
				},
				dependencies,
			}),
		).rejects.toThrow(/invalid-token probe was accepted/);
	});

	it("writes evidence with a SHA-256 sidecar for later signed-bundle binding", async () => {
		const outputDir = await mkdtemp(join(tmpdir(), "maestro-a2a-live-proof-"));
		try {
			const dependencies: Partial<PlatformA2ALiveSmokeDependencies> = {
				now: () => new Date("2026-05-21T20:00:00.000Z"),
				sleep: vi.fn(async () => undefined),
				log: vi.fn(),
				gitSha: () => "1234567890abcdef1234567890abcdef12345678",
				resolveConfig: vi.fn(async () => ({
					baseUrl: "https://platform.test",
					token: "registry-token",
					organizationId: "org_1",
					workspaceId: "ws_1",
					timeoutMs: 2_000,
					maxAttempts: 1,
				})),
				listPeers: vi.fn(async () => [
					peer("maestro-origin", "https://origin.test/a2a"),
					peer("maestro-target", "https://target.test/a2a"),
				]),
				delegate: vi.fn(async () => ({
					delegation: {
						id: "delegation_1",
						workspaceId: "ws_1",
						fromAgentId: "maestro-origin",
						toAgentId: "maestro-target",
						status: "DELEGATION_STATUS_ACCEPTED",
					},
				})),
				getGraph: vi.fn(async () => graph("task_1")),
				control: vi.fn(async () => ({
					delegation: graph("task_1").nodes[0]?.delegation,
					remoteTask: {
						taskId: "task_1",
						state: "TASK_STATE_COMPLETED",
						controlMode: PlatformA2ADelegationTaskControlModeValue.Collect,
					},
				})),
				getTask: vi.fn(async () => ({
					id: "task_1",
					contextId: "ctx_1",
					status: { state: "TASK_STATE_COMPLETED" },
				})),
			};

			const result = await runPlatformA2ADelegationLiveSmoke({
				env: {
					...baseEnv,
					MAESTRO_A2A_LIVE_EVIDENCE_DIR: outputDir,
				},
				dependencies,
			});

			const evidenceBytes = await readFile(result.evidencePath, "utf8");
			const sidecar = await readFile(`${result.evidencePath}.sha256`, "utf8");
			expect(sidecar).toBe(`${sha256Hex(evidenceBytes)}  evidence.json\n`);
			expect(evidenceBytes).not.toContain("registry-token");
			expect(evidenceBytes).not.toContain("acknowledge delegation");
		} finally {
			await rm(outputDir, { force: true, recursive: true });
		}
	});

	it("writes an Ed25519 detached signature sidecar when a signing key is configured", async () => {
		const outputDir = await mkdtemp(join(tmpdir(), "maestro-a2a-live-proof-"));
		try {
			const { privateKey, publicKey } = generateKeyPairSync("ed25519");
			const privateKeyPem = privateKey.export({
				format: "pem",
				type: "pkcs8",
			}) as string;
			const publicKeyPem = publicKey.export({
				format: "pem",
				type: "spki",
			}) as string;
			const dependencies: Partial<PlatformA2ALiveSmokeDependencies> = {
				now: () => new Date("2026-05-21T20:00:00.000Z"),
				sleep: vi.fn(async () => undefined),
				log: vi.fn(),
				gitSha: () => "1234567890abcdef1234567890abcdef12345678",
				resolveConfig: vi.fn(async () => ({
					baseUrl: "https://platform.test",
					token: "registry-token",
					organizationId: "org_1",
					workspaceId: "ws_1",
					timeoutMs: 2_000,
					maxAttempts: 1,
				})),
				listPeers: vi.fn(async () => [
					peer("maestro-origin", "https://origin.test/a2a"),
					peer("maestro-target", "https://target.test/a2a"),
				]),
				delegate: vi.fn(async () => ({
					delegation: {
						id: "delegation_1",
						workspaceId: "ws_1",
						fromAgentId: "maestro-origin",
						toAgentId: "maestro-target",
						status: "DELEGATION_STATUS_ACCEPTED",
					},
				})),
				getGraph: vi.fn(async () => graph("task_1")),
				control: vi.fn(async () => ({
					delegation: graph("task_1").nodes[0]?.delegation,
					remoteTask: {
						taskId: "task_1",
						state: "TASK_STATE_COMPLETED",
						controlMode: PlatformA2ADelegationTaskControlModeValue.Collect,
					},
				})),
				getTask: vi.fn(async () => ({
					id: "task_1",
					contextId: "ctx_1",
					status: { state: "TASK_STATE_COMPLETED" },
				})),
			};

			const result = await runPlatformA2ADelegationLiveSmoke({
				env: {
					...baseEnv,
					MAESTRO_A2A_LIVE_EVIDENCE_DIR: outputDir,
					MAESTRO_A2A_LIVE_EVIDENCE_SIGNING_PRIVATE_KEY: privateKeyPem,
					MAESTRO_A2A_LIVE_EVIDENCE_SIGNING_KEY_ID: "platform-live-smoke-ci",
				},
				dependencies,
			});

			const signature = JSON.parse(
				await readFile(`${result.evidencePath}.sig.json`, "utf8"),
			) as Record<string, unknown>;
			expect(signature).toMatchObject({
				protocolVersion:
					"evalops.maestro.platform-a2a-live-evidence-signature.v1",
				algorithm: "ed25519",
				keyId: "platform-live-smoke-ci",
				evidenceSha256: sha256Hex(await readFile(result.evidencePath, "utf8")),
			});
			await expect(
				verifyPlatformA2ALiveEvidenceFile(result.evidencePath, {
					publicKeyPem,
					requireSignature: true,
				}),
			).resolves.toMatchObject({
				signature: {
					keyId: "platform-live-smoke-ci",
					verified: true,
				},
			});
		} finally {
			await rm(outputDir, { force: true, recursive: true });
		}
	});

	it("turns missing graph support into an explicit Platform readiness failure", async () => {
		const dependencies: Partial<PlatformA2ALiveSmokeDependencies> = {
			now: () => new Date("2026-05-21T20:00:00.000Z"),
			sleep: vi.fn(async () => undefined),
			log: vi.fn(),
			resolveConfig: vi.fn(async () => ({
				baseUrl: "https://platform.test",
				token: "registry-token",
				organizationId: "org_1",
				workspaceId: "ws_1",
				timeoutMs: 2_000,
				maxAttempts: 1,
			})),
			listPeers: vi.fn(async () => [
				peer("maestro-origin", "https://origin.test/a2a"),
				peer("maestro-target", "https://target.test/a2a"),
			]),
			delegate: vi.fn(async () => ({
				delegation: { id: "delegation_1" },
			})),
			getGraph: vi.fn(async () => {
				throw new Error("connect 404 unknown method");
			}),
		};

		await expect(
			runPlatformA2ADelegationLiveSmoke({
				env: baseEnv,
				dependencies,
			}),
		).rejects.toThrow(/does not support A2A delegation graph yet/);
	});
});
