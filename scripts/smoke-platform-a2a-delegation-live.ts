import { execFileSync } from "node:child_process";
import {
	type KeyObject,
	createHash,
	createPrivateKey,
	createPublicKey,
	sign as signBytes,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	PlatformA2ADelegationTaskControlModeValue,
	type PlatformA2ADelegationGraphNode,
	type PlatformAgentRegistryA2APeerCandidate,
	type PlatformAgentRegistryControlA2ADelegationTaskResult,
	type PlatformAgentRegistryDelegateResult,
	type PlatformAgentRegistryGetA2ADelegationGraphResult,
	controlA2ADelegationTaskWithPlatform,
	delegateAgentWithPlatform,
	getA2ADelegationGraphWithPlatform,
	listA2APeerCandidatesWithPlatform,
	resolveAgentRegistryServiceConfig,
} from "../src/platform/agent-registry-client.js";
import {
	type A2AAgentCard,
	type A2AServiceConfig,
	type A2ATask,
	discoverA2AAgentCard,
	getA2ATask,
} from "../src/platform/a2a-client.js";
import {
	DEFAULT_PLATFORM_MAX_ATTEMPTS,
	DEFAULT_PLATFORM_TIMEOUT_MS,
	type PlatformServiceConfig,
	parsePositiveInt,
	trimString,
} from "../src/platform/client.js";
import { getPackageName } from "../src/package-metadata.js";

const SERVICE_URL_ENV_VARS = [
	"MAESTRO_AGENT_REGISTRY_SERVICE_URL",
	"AGENT_REGISTRY_SERVICE_URL",
	"MAESTRO_AGENT_REGISTRY_URL",
	"AGENT_REGISTRY_BASE_URL",
	"PLATFORM_AGENT_REGISTRY_URL",
	"MAESTRO_PLATFORM_BASE_URL",
	"MAESTRO_EVALOPS_BASE_URL",
	"EVALOPS_BASE_URL",
] as const;

const SERVICE_TOKEN_ENV_VARS = [
	"MAESTRO_AGENT_REGISTRY_SERVICE_TOKEN",
	"AGENT_REGISTRY_SERVICE_TOKEN",
	"MAESTRO_AGENT_REGISTRY_TOKEN",
	"AGENT_REGISTRY_TOKEN",
	"MAESTRO_EVALOPS_ACCESS_TOKEN",
	"EVALOPS_TOKEN",
] as const;

const ORGANIZATION_ENV_VARS = [
	"MAESTRO_AGENT_REGISTRY_ORG_ID",
	"AGENT_REGISTRY_ORGANIZATION_ID",
	"AGENT_REGISTRY_ORG_ID",
	"MAESTRO_EVALOPS_ORG_ID",
	"EVALOPS_ORGANIZATION_ID",
	"EVALOPS_ORG_ID",
	"MAESTRO_ENTERPRISE_ORG_ID",
] as const;

const WORKSPACE_ENV_VARS = [
	"MAESTRO_AGENT_REGISTRY_WORKSPACE_ID",
	"AGENT_REGISTRY_WORKSPACE_ID",
	"MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
	"MAESTRO_EVALOPS_WORKSPACE_ID",
	"EVALOPS_WORKSPACE_ID",
	"MAESTRO_WORKSPACE_ID",
] as const;

const EVIDENCE_SIGNING_KEY_ENV_VARS = [
	"MAESTRO_A2A_LIVE_EVIDENCE_SIGNING_PRIVATE_KEY",
	"MAESTRO_A2A_LIVE_EVIDENCE_SIGNING_KEY",
] as const;

const EVIDENCE_SIGNING_KEY_FILE_ENV_VARS = [
	"MAESTRO_A2A_LIVE_EVIDENCE_SIGNING_PRIVATE_KEY_FILE",
	"MAESTRO_A2A_LIVE_EVIDENCE_SIGNING_KEY_FILE",
] as const;

const EVIDENCE_SIGNATURE_PROTOCOL_VERSION =
	"evalops.maestro.platform-a2a-live-evidence-signature.v1";

const TERMINAL_TASK_STATES = new Set([
	"TASK_STATE_COMPLETED",
	"TASK_STATE_FAILED",
	"TASK_STATE_CANCELED",
	"TASK_STATE_CANCELLED",
	"TASK_STATE_REJECTED",
]);

type Env = Record<string, string | undefined>;

export interface PlatformA2ALiveSmokeEnv {
	serviceUrl: string;
	serviceToken: string;
	organizationId: string;
	workspaceId: string;
	fromAgentId: string;
	toAgentId: string;
	skillId?: string;
	capability?: string;
	prompt: string;
	outputDir: string;
	maxHeartbeatAgeMs: number;
	observeAttempts: number;
	observeIntervalMs: number;
	taskAttempts: number;
	taskIntervalMs: number;
	fetchAgentCard: boolean;
	requireInvalidTokenProbe: boolean;
	requireTerminalTask: boolean;
}

export interface PlatformA2ALiveSmokeEvidence {
	protocolVersion: "evalops.maestro.platform-a2a-live-smoke.v1";
	eventType: "platform_a2a_delegation_live_smoke";
	live: true;
	createdAt: string;
	workspaceId: string;
	organizationId: string;
	platformEndpoint: string;
	maestro: {
		gitSha: string;
		cliPackage: string;
	};
	github?: PlatformA2ALiveSmokeGithubEvidence;
	inputs: {
		fromAgentId: string;
		toAgentId: string;
		skillId?: string;
		capability?: string;
		promptHash?: string;
	};
	peers: {
		origin: PlatformA2APeerEvidence;
		target: PlatformA2APeerEvidence;
	};
	delegation: {
		id: string;
		status?: string;
		dispatchStatus?: string;
		dispatchError?: string;
		a2aTaskId: string;
		a2aMessageId?: string;
		a2aEndpointUrl?: string;
		a2aSkillId?: string;
		a2aDispatchedAt?: string;
		a2aLeaseRenewedAt?: string;
		rootDelegationId?: string;
		parentDelegationId?: string;
		chain?: string[];
	};
	graph: {
		rootDelegationId?: string;
		total?: number;
		truncated?: boolean;
		nodes: PlatformA2AGraphNodeEvidence[];
		edges: { parentDelegationId?: string; childDelegationId?: string }[];
	};
	control?: {
		mode: string;
		taskId?: string;
		state?: string;
		controlId?: string;
		queuedForWorker?: boolean;
		observedAt?: string;
	};
	task?: {
		id?: string;
		state?: string;
		terminal: boolean;
		contextId?: string;
	};
	negativeAuthProbe?: {
		surface: "platform-agent-registry-peer-discovery";
		rejected: true;
		errorClass: "unauthorized" | "forbidden";
		observedAt: string;
	};
	redaction: {
		rawTokensWithheld: true;
		rawPayloadsWithheld: true;
	};
}

export interface PlatformA2ALiveSmokeEvidenceWriteContext {
	env: Env;
	now: Date;
}

export interface PlatformA2ALiveSmokeGithubEvidence {
	repository?: string;
	serverUrl?: string;
	runId?: string;
	runUrl?: string;
	sha?: string;
	ref?: string;
	headRef?: string;
	baseRef?: string;
	eventName?: string;
	pullRequestNumber?: number;
	pullRequestUrl?: string;
}

interface PlatformA2APeerEvidence {
	agentId: string;
	status?: string;
	endpointUrl: string;
	endpointKind?: string;
	agentCardUrl?: string;
	agentCardObservedAt?: string;
	lastHeartbeatAt?: string;
	lastHeartbeatAgeMs?: number;
	activeConfigVersion?: number;
	capacity?: {
		current?: number;
		max?: number;
		remaining?: number;
		reservedDelegationCount?: number;
	};
}

interface PlatformA2AGraphNodeEvidence {
	delegationId?: string;
	depth?: number;
	childCount?: number;
	terminal?: boolean;
	status?: string;
	a2aTaskId?: string;
	a2aDispatchStatus?: string;
	parentDelegationId?: string;
	rootDelegationId?: string;
}

export interface PlatformA2ALiveSmokeDependencies {
	resolveConfig: () => Promise<PlatformServiceConfig | null>;
	listPeers: typeof listA2APeerCandidatesWithPlatform;
	delegate: typeof delegateAgentWithPlatform;
	getGraph: typeof getA2ADelegationGraphWithPlatform;
	control: typeof controlA2ADelegationTaskWithPlatform;
	getTask: typeof getA2ATask;
	discoverAgentCard: typeof discoverA2AAgentCard;
	gitSha: () => string;
	writeEvidence: (
		outputDir: string,
		evidence: PlatformA2ALiveSmokeEvidence,
		context: PlatformA2ALiveSmokeEvidenceWriteContext,
	) => Promise<string>;
	sleep: (ms: number) => Promise<void>;
	now: () => Date;
	log: (message: string) => void;
}

export interface RunPlatformA2ALiveSmokeOptions {
	env?: Env;
	dependencies?: Partial<PlatformA2ALiveSmokeDependencies>;
}

const defaultDependencies: PlatformA2ALiveSmokeDependencies = {
	resolveConfig: resolveAgentRegistryServiceConfig,
	listPeers: listA2APeerCandidatesWithPlatform,
	delegate: delegateAgentWithPlatform,
	getGraph: getA2ADelegationGraphWithPlatform,
	control: controlA2ADelegationTaskWithPlatform,
	getTask: getA2ATask,
	discoverAgentCard: discoverA2AAgentCard,
	gitSha: readGitSha,
	writeEvidence: writeEvidenceFile,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => new Date(),
	log: (message) => {
		console.log(message);
	},
};

export function resolvePlatformA2ALiveSmokeEnv(
	env: Env = process.env,
): PlatformA2ALiveSmokeEnv {
	const serviceUrl = firstEnv(env, SERVICE_URL_ENV_VARS);
	const serviceToken = firstEnv(env, SERVICE_TOKEN_ENV_VARS);
	const organizationId = firstEnv(env, ORGANIZATION_ENV_VARS);
	const workspaceId = firstEnv(env, WORKSPACE_ENV_VARS);
	const fromAgentId = trimString(env.MAESTRO_A2A_LIVE_FROM_AGENT_ID);
	const toAgentId = trimString(env.MAESTRO_A2A_LIVE_TO_AGENT_ID);
	const skillId = trimString(env.MAESTRO_A2A_LIVE_SKILL_ID);
	const capability = trimString(env.MAESTRO_A2A_LIVE_CAPABILITY);
	const missing: string[] = [];
	if (!serviceUrl) {
		missing.push(`${SERVICE_URL_ENV_VARS[0]} or EVALOPS_BASE_URL`);
	}
	if (!serviceToken) {
		missing.push(`${SERVICE_TOKEN_ENV_VARS[0]} or EVALOPS_TOKEN`);
	}
	if (!organizationId) {
		missing.push(`${ORGANIZATION_ENV_VARS[0]} or EVALOPS_ORGANIZATION_ID`);
	}
	if (!workspaceId) {
		missing.push(`${WORKSPACE_ENV_VARS[0]} or EVALOPS_WORKSPACE_ID`);
	}
	if (!fromAgentId) {
		missing.push("MAESTRO_A2A_LIVE_FROM_AGENT_ID");
	}
	if (!toAgentId) {
		missing.push("MAESTRO_A2A_LIVE_TO_AGENT_ID");
	}
	if (!skillId && !capability) {
		missing.push("MAESTRO_A2A_LIVE_SKILL_ID or MAESTRO_A2A_LIVE_CAPABILITY");
	}
	if (missing.length > 0) {
		throw new Error(
			`Platform A2A live smoke is missing required environment: ${missing.join(", ")}`,
		);
	}
	return {
		serviceUrl,
		serviceToken,
		organizationId,
		workspaceId,
		fromAgentId,
		toAgentId,
		skillId,
		capability,
		prompt:
			trimString(env.MAESTRO_A2A_LIVE_PROMPT) ??
			"Platform live A2A smoke: acknowledge delegation, report the current workspace, and return one redaction-safe status artifact.",
		outputDir:
			trimString(env.MAESTRO_A2A_LIVE_EVIDENCE_DIR) ??
			join(process.cwd(), "tmp", "platform-a2a-delegation-live"),
		maxHeartbeatAgeMs: parsePositiveInt(
			env.MAESTRO_A2A_LIVE_MAX_HEARTBEAT_AGE_MS,
			15 * 60 * 1000,
		),
		observeAttempts: parsePositiveInt(
			env.MAESTRO_A2A_LIVE_OBSERVE_ATTEMPTS,
			6,
		),
		observeIntervalMs: parsePositiveInt(
			env.MAESTRO_A2A_LIVE_OBSERVE_INTERVAL_MS,
			1_000,
		),
		taskAttempts: parsePositiveInt(env.MAESTRO_A2A_LIVE_TASK_ATTEMPTS, 12),
		taskIntervalMs: parsePositiveInt(
			env.MAESTRO_A2A_LIVE_TASK_INTERVAL_MS,
			5_000,
		),
		fetchAgentCard: env.MAESTRO_A2A_LIVE_FETCH_AGENT_CARD === "true",
		requireInvalidTokenProbe:
			env.MAESTRO_A2A_LIVE_REQUIRE_INVALID_TOKEN_PROBE === "true",
		requireTerminalTask: env.MAESTRO_A2A_LIVE_REQUIRE_TERMINAL_TASK !== "false",
	};
}

export async function runPlatformA2ADelegationLiveSmoke(
	options: RunPlatformA2ALiveSmokeOptions = {},
): Promise<{ evidence: PlatformA2ALiveSmokeEvidence; evidencePath: string }> {
	const rawEnv = options.env ?? process.env;
	const env = resolvePlatformA2ALiveSmokeEnv(rawEnv);
	const deps = { ...defaultDependencies, ...options.dependencies };
	const config = await deps.resolveConfig();
	const effectiveConfig: PlatformServiceConfig = {
		...(config ?? {
			timeoutMs: DEFAULT_PLATFORM_TIMEOUT_MS,
			maxAttempts: DEFAULT_PLATFORM_MAX_ATTEMPTS,
		}),
		baseUrl: env.serviceUrl,
		token: env.serviceToken,
		workspaceId: env.workspaceId,
		organizationId: env.organizationId,
	};
	if (
		!effectiveConfig.baseUrl ||
		!effectiveConfig.workspaceId ||
		!effectiveConfig.token
	) {
		throw new Error(
			"Platform A2A live smoke could not resolve a usable Agent Registry service config after env validation",
		);
	}
	const createdAt = deps.now().toISOString();
	const negativeAuthProbe = env.requireInvalidTokenProbe
		? await runInvalidTokenProbe(env, effectiveConfig, deps)
		: undefined;
	deps.log(
		`Discovering Platform A2A target peers in workspace ${env.workspaceId} for ${env.skillId ?? env.capability}`,
	);
	const targetPeers = await deps.listPeers(
		{
			workspaceId: env.workspaceId,
			skillId: env.skillId,
			capability: env.capability,
			limit: 100,
			requireA2ADispatch: true,
			eligibleForDelegation: true,
		},
		{ config: effectiveConfig },
	);
	if (!targetPeers) {
		throw new Error("Platform A2A live smoke received no peer list from Platform");
	}
	const target = requirePeer(targetPeers, env.toAgentId, env, deps.now());
	let origin = targetPeers.find(
		(candidate) => candidate.agent.id === env.fromAgentId,
	);
	if (!origin) {
		deps.log(
			`Discovering Platform A2A origin peer ${env.fromAgentId} without target skill filters`,
		);
		const originPeers = await deps.listPeers(
			{
				workspaceId: env.workspaceId,
				limit: 100,
				requireA2ADispatch: true,
			},
			{ config: effectiveConfig },
		);
		if (!originPeers) {
			throw new Error(
				"Platform A2A live smoke received no origin peer list from Platform",
			);
		}
		origin = requirePeer(originPeers, env.fromAgentId, env, deps.now());
	} else {
		origin = requirePeer(targetPeers, env.fromAgentId, env, deps.now());
	}
	if (env.fetchAgentCard) {
		await assertAgentCardFetch(origin, effectiveConfig, deps);
		await assertAgentCardFetch(target, effectiveConfig, deps);
	}
	const delegationResult = await deps.delegate(
		{
			workspaceId: env.workspaceId,
			fromAgentId: env.fromAgentId,
			toAgentId: env.toAgentId,
			requiredCapability: env.capability,
			a2aSkillId: env.skillId,
			reason: "maestro-platform-a2a-live-smoke",
			contextPayload: {
				requestKind: "maestro-peer-delegation-live-smoke",
				transport: "platform-a2a",
				source: "scripts/smoke-platform-a2a-delegation-live.ts",
				requestedAt: createdAt,
				prompt: env.prompt,
				fromAgentId: env.fromAgentId,
				toAgentId: env.toAgentId,
				workspaceId: env.workspaceId,
				a2aSkillId: env.skillId,
				requiredCapability: env.capability,
				evidenceContract:
					"delegation-id,a2a-task-id,graph,control,task-state,git-sha",
			},
		},
		{ config: effectiveConfig },
	);
	const delegation = requireDelegation(delegationResult);
	deps.log(`Platform delegation created: ${delegation.id}`);
	const graph = await observeDelegationGraph(
		delegation.id,
		env,
		effectiveConfig,
		deps,
	);
	const observedDelegation =
		findDelegationNode(graph, delegation.id)?.delegation ?? delegation;
	const taskId = trimString(observedDelegation.a2aTaskId ?? delegation.a2aTaskId);
	if (!taskId) {
		throw new Error(
			`Platform delegation ${delegation.id} did not expose a remote A2A task id after ${env.observeAttempts} graph observation attempts`,
		);
	}
	const control = await runControlProbe(
		delegation.id,
		taskId,
		env,
		effectiveConfig,
		deps,
	);
	const task = await observeRemoteTask(taskId, target, effectiveConfig, env, deps);
	const taskState = trimString(task.status?.state);
	const terminal = taskState ? TERMINAL_TASK_STATES.has(taskState) : false;
	if (env.requireTerminalTask && !terminal) {
		throw new Error(
			`Remote A2A task ${taskId} did not reach a terminal state after ${env.taskAttempts} attempts; last state ${taskState ?? "unknown"}`,
		);
	}
	const evidence = buildEvidence({
		env,
		config: effectiveConfig,
		createdAt,
		origin,
		target,
		delegation: observedDelegation,
		graph,
		control,
		task,
		terminal,
		gitSha: deps.gitSha(),
		github: buildGithubEvidence(rawEnv),
		negativeAuthProbe,
	});
	const evidencePath = await deps.writeEvidence(env.outputDir, evidence, {
		env: rawEnv,
		now: deps.now(),
	});
	deps.log(`Platform A2A live smoke evidence written to ${evidencePath}`);
	return { evidence, evidencePath };
}

function firstEnv(
	env: Env,
	names: readonly string[],
): string | undefined {
	for (const name of names) {
		const value = trimString(env[name]);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function requirePeer(
	peers: PlatformAgentRegistryA2APeerCandidate[],
	agentId: string,
	env: PlatformA2ALiveSmokeEnv,
	now: Date,
): PlatformAgentRegistryA2APeerCandidate {
	const peer = peers.find((candidate) => candidate.agent.id === agentId);
	if (!peer) {
		throw new Error(
			`Platform A2A live smoke did not find registered A2A peer ${agentId}`,
		);
	}
	const heartbeatAt = parseTimestamp(peer.agent.lastHeartbeatAt);
	if (!heartbeatAt) {
		throw new Error(
			`Platform A2A peer ${agentId} has no parseable last heartbeat timestamp`,
		);
	}
	const heartbeatAgeMs = Math.max(0, now.getTime() - heartbeatAt.getTime());
	if (heartbeatAgeMs > env.maxHeartbeatAgeMs) {
		throw new Error(
			`Platform A2A peer ${agentId} heartbeat is stale: ${heartbeatAgeMs}ms old`,
		);
	}
	if (!trimString(peer.agent.a2a?.agentCardObservedAt)) {
		throw new Error(
			`Platform A2A peer ${agentId} has no Agent Card observation timestamp`,
		);
	}
	return peer;
}

async function runInvalidTokenProbe(
	env: PlatformA2ALiveSmokeEnv,
	config: PlatformServiceConfig,
	deps: PlatformA2ALiveSmokeDependencies,
): Promise<NonNullable<PlatformA2ALiveSmokeEvidence["negativeAuthProbe"]>> {
	const probeConfig = {
		...config,
		token: ["maestro", "a2a", "live", "smoke", "rejected", "auth", "probe"].join(
			"-",
		),
	};
	try {
		await deps.listPeers(
			{
				workspaceId: env.workspaceId,
				skillId: env.skillId,
				capability: env.capability,
				limit: 1,
				requireA2ADispatch: true,
				eligibleForDelegation: true,
			},
			{ config: probeConfig },
		);
	} catch (error) {
		const errorClass = classifyAuthRejection(error);
		if (!errorClass) {
			throw new Error(
				`Platform A2A invalid-token probe failed, but not with an auth rejection: ${redactErrorMessage(error)}`,
			);
		}
		return {
			surface: "platform-agent-registry-peer-discovery",
			rejected: true,
			errorClass,
			observedAt: deps.now().toISOString(),
		};
	}
	throw new Error(
		"Platform A2A invalid-token probe was accepted; refusing to write live proof evidence",
	);
}

async function assertAgentCardFetch(
	peer: PlatformAgentRegistryA2APeerCandidate,
	config: PlatformServiceConfig,
	deps: PlatformA2ALiveSmokeDependencies,
): Promise<A2AAgentCard> {
	const a2aConfig = buildA2AConfig(peer, config);
	return await deps.discoverAgentCard(a2aConfig);
}

function requireDelegation(
	result: PlatformAgentRegistryDelegateResult | null,
): NonNullable<PlatformAgentRegistryDelegateResult["delegation"]> {
	const delegation = result?.delegation;
	if (!delegation?.id) {
		throw new Error("Platform did not return a durable delegation id");
	}
	return delegation;
}

async function observeDelegationGraph(
	delegationId: string,
	env: PlatformA2ALiveSmokeEnv,
	config: PlatformServiceConfig,
	deps: PlatformA2ALiveSmokeDependencies,
): Promise<PlatformAgentRegistryGetA2ADelegationGraphResult> {
	let lastGraph: PlatformAgentRegistryGetA2ADelegationGraphResult | null = null;
	for (let attempt = 1; attempt <= env.observeAttempts; attempt += 1) {
		try {
			const graph = await deps.getGraph(
				{
					workspaceId: env.workspaceId,
					delegationId,
					maxDepth: 8,
					limit: 100,
				},
				{ config },
			);
			if (!graph) {
				throw new Error("Platform returned no A2A delegation graph");
			}
			lastGraph = graph;
			const node = findDelegationNode(graph, delegationId);
			if (node?.delegation?.a2aTaskId) {
				return graph;
			}
		} catch (error) {
			throwIfUnsupportedContract(error, "A2A delegation graph");
			if (attempt >= env.observeAttempts) {
				throw error;
			}
		}
		if (attempt < env.observeAttempts) {
			await deps.sleep(env.observeIntervalMs);
		}
	}
	if (lastGraph) {
		return lastGraph;
	}
	throw new Error("Platform returned no A2A delegation graph");
}

async function runControlProbe(
	delegationId: string,
	taskId: string,
	env: PlatformA2ALiveSmokeEnv,
	config: PlatformServiceConfig,
	deps: PlatformA2ALiveSmokeDependencies,
): Promise<PlatformAgentRegistryControlA2ADelegationTaskResult> {
	try {
		const result = await deps.control(
			{
				workspaceId: env.workspaceId,
				delegationId,
				mode: PlatformA2ADelegationTaskControlModeValue.Collect,
				message: "Collect current remote Maestro A2A task state for live proof.",
				idempotencyKey: `maestro-a2a-live-smoke-${delegationId}-${taskId}`,
				metadata: {
					source: "scripts/smoke-platform-a2a-delegation-live.ts",
					proof: "platform-a2a-live-smoke",
				},
			},
			{ config },
		);
		if (!result) {
			throw new Error("Platform returned no A2A task control result");
		}
		const controlTaskId = trimString(result.remoteTask?.taskId);
		if (!controlTaskId) {
			throw new Error(
				`Platform A2A task control for delegation ${delegationId} did not return remoteTask.taskId`,
			);
		}
		if (controlTaskId !== taskId) {
			throw new Error(
				`Platform A2A task control returned remoteTask.taskId ${controlTaskId} for expected task ${taskId}`,
			);
		}
		return result;
	} catch (error) {
		throwIfUnsupportedContract(error, "A2A task control");
		throw error;
	}
}

async function observeRemoteTask(
	taskId: string,
	peer: PlatformAgentRegistryA2APeerCandidate,
	config: PlatformServiceConfig,
	env: PlatformA2ALiveSmokeEnv,
	deps: PlatformA2ALiveSmokeDependencies,
): Promise<A2ATask> {
	const a2aConfig = buildA2AConfig(peer, config);
	let lastTask: A2ATask | undefined;
	let lastError: unknown;
	for (let attempt = 1; attempt <= env.taskAttempts; attempt += 1) {
		try {
			lastTask = await deps.getTask(a2aConfig, taskId);
			const state = trimString(lastTask.status?.state);
			if (
				!env.requireTerminalTask ||
				(state && TERMINAL_TASK_STATES.has(state))
			) {
				return lastTask;
			}
		} catch (error) {
			lastError = error;
			if (attempt >= env.taskAttempts) {
				throw error;
			}
		}
		if (attempt < env.taskAttempts) {
			await deps.sleep(env.taskIntervalMs);
		}
	}
	if (!lastTask) {
		if (lastError instanceof Error) {
			throw lastError;
		}
		throw new Error(`Remote A2A task ${taskId} could not be fetched`);
	}
	return lastTask;
}

function buildA2AConfig(
	peer: PlatformAgentRegistryA2APeerCandidate,
	config: PlatformServiceConfig,
): A2AServiceConfig {
	return {
		baseUrl: peer.endpointUrl,
		token: config.token,
		organizationId: config.organizationId,
		workspaceId: config.workspaceId ?? "",
		timeoutMs: config.timeoutMs,
		maxAttempts: config.maxAttempts,
		agentId: "maestro-platform-a2a-live-smoke",
	};
}

function buildEvidence(input: {
	env: PlatformA2ALiveSmokeEnv;
	config: PlatformServiceConfig;
	createdAt: string;
	origin: PlatformAgentRegistryA2APeerCandidate;
	target: PlatformAgentRegistryA2APeerCandidate;
	delegation: NonNullable<PlatformAgentRegistryDelegateResult["delegation"]>;
	graph: PlatformAgentRegistryGetA2ADelegationGraphResult;
	control: PlatformAgentRegistryControlA2ADelegationTaskResult;
	task: A2ATask;
	terminal: boolean;
	gitSha: string;
	github?: PlatformA2ALiveSmokeGithubEvidence;
	negativeAuthProbe?: PlatformA2ALiveSmokeEvidence["negativeAuthProbe"];
}): PlatformA2ALiveSmokeEvidence {
	const remoteTask = input.control.remoteTask;
	return {
		protocolVersion: "evalops.maestro.platform-a2a-live-smoke.v1",
		eventType: "platform_a2a_delegation_live_smoke",
		live: true,
		createdAt: input.createdAt,
		workspaceId: input.env.workspaceId,
		organizationId: input.env.organizationId,
		platformEndpoint: input.config.baseUrl,
		maestro: {
			gitSha: input.gitSha,
			cliPackage: getPackageName(),
		},
		github: input.github,
		inputs: {
			fromAgentId: input.env.fromAgentId,
			toAgentId: input.env.toAgentId,
			skillId: input.env.skillId,
			capability: input.env.capability,
			promptHash: sha256Hex(input.env.prompt),
		},
		peers: {
			origin: buildPeerEvidence(input.origin, input.createdAt),
			target: buildPeerEvidence(input.target, input.createdAt),
		},
		delegation: {
			id: input.delegation.id ?? "",
			status: input.delegation.status,
			dispatchStatus: input.delegation.a2aDispatchStatus,
			dispatchError: input.delegation.a2aDispatchError,
			a2aTaskId: input.delegation.a2aTaskId ?? input.task.id ?? "",
			a2aMessageId: input.delegation.a2aMessageId,
			a2aEndpointUrl: input.delegation.a2aEndpointUrl,
			a2aSkillId: input.delegation.a2aSkillId,
			a2aDispatchedAt: input.delegation.a2aDispatchedAt,
			a2aLeaseRenewedAt: input.delegation.a2aLeaseRenewedAt,
			rootDelegationId: input.delegation.a2aRootDelegationId,
			parentDelegationId: input.delegation.a2aParentDelegationId,
			chain: input.delegation.a2aDelegationChain,
		},
		graph: {
			rootDelegationId: input.graph.rootDelegationId,
			total: input.graph.total,
			truncated: input.graph.truncated,
			nodes: input.graph.nodes.map(buildGraphNodeEvidence),
			edges: input.graph.edges.map((edge) => ({
				parentDelegationId: edge.parentDelegationId,
				childDelegationId: edge.childDelegationId,
			})),
		},
		control: {
			mode:
				remoteTask?.controlMode ??
				PlatformA2ADelegationTaskControlModeValue.Collect,
			taskId: remoteTask?.taskId,
			state: remoteTask?.state,
			controlId: remoteTask?.controlId,
			queuedForWorker: remoteTask?.queuedForWorker,
			observedAt: remoteTask?.observedAt,
		},
		task: {
			id: input.task.id,
			state: input.task.status?.state,
			terminal: input.terminal,
			contextId: input.task.contextId,
		},
		negativeAuthProbe: input.negativeAuthProbe,
		redaction: {
			rawTokensWithheld: true,
			rawPayloadsWithheld: true,
		},
	};
}

function buildGithubEvidence(env: Env): PlatformA2ALiveSmokeGithubEvidence | undefined {
	const repository = trimString(env.GITHUB_REPOSITORY);
	const serverUrl = trimString(env.GITHUB_SERVER_URL) ?? "https://github.com";
	const runId = trimString(env.GITHUB_RUN_ID);
	const sha = trimString(env.GITHUB_SHA);
	const ref = trimString(env.GITHUB_REF);
	const headRef = trimString(env.GITHUB_HEAD_REF);
	const baseRef = trimString(env.GITHUB_BASE_REF);
	const eventName = trimString(env.GITHUB_EVENT_NAME);
	const pullRequestNumber = parsePullRequestNumber(env);
	if (
		!repository &&
		!runId &&
		!sha &&
		!ref &&
		!headRef &&
		!baseRef &&
		!eventName &&
		pullRequestNumber === undefined
	) {
		return undefined;
	}
	return {
		repository,
		serverUrl: repository ? serverUrl : undefined,
		runId,
		runUrl: repository && runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : undefined,
		sha,
		ref,
		headRef,
		baseRef,
		eventName,
		pullRequestNumber,
		pullRequestUrl:
			repository && pullRequestNumber
				? `${serverUrl}/${repository}/pull/${pullRequestNumber}`
				: undefined,
	};
}

function parsePullRequestNumber(env: Env): number | undefined {
	for (const key of [
		"GITHUB_PR_NUMBER",
		"PR_NUMBER",
		"PULL_REQUEST_NUMBER",
	] as const) {
		const parsed = parsePositiveInteger(trimString(env[key]));
		if (parsed !== undefined) {
			return parsed;
		}
	}
	for (const key of ["GITHUB_REF", "GITHUB_REF_NAME"] as const) {
		const value = trimString(env[key]);
		const match =
			key === "GITHUB_REF"
				? value?.match(/^refs\/pull\/([1-9]\d*)\/(?:head|merge)$/u)
				: value?.match(/^([1-9]\d*)\/(?:head|merge)$/u);
		const parsed = parsePositiveInteger(match?.[1]);
		if (parsed !== undefined) {
			return parsed;
		}
	}
	return undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (!value || !/^[1-9]\d*$/u.test(value)) {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function buildPeerEvidence(
	peer: PlatformAgentRegistryA2APeerCandidate,
	createdAt: string,
): PlatformA2APeerEvidence {
	const heartbeatAt = parseTimestamp(peer.agent.lastHeartbeatAt);
	const observedAt = parseTimestamp(createdAt);
	return {
		agentId: peer.agent.id ?? "",
		status: peer.agent.status,
		endpointUrl: peer.endpointUrl,
		endpointKind: peer.endpointKind,
		agentCardUrl: peer.agentCardUrl,
		agentCardObservedAt: peer.agent.a2a?.agentCardObservedAt,
		lastHeartbeatAt: peer.agent.lastHeartbeatAt,
		lastHeartbeatAgeMs:
			heartbeatAt && observedAt
				? Math.max(0, observedAt.getTime() - heartbeatAt.getTime())
				: undefined,
		activeConfigVersion: peer.agent.activeConfigVersion,
		capacity: peer.agent.capacity,
	};
}

function buildGraphNodeEvidence(
	node: PlatformA2ADelegationGraphNode,
): PlatformA2AGraphNodeEvidence {
	return {
		delegationId: node.delegation?.id,
		depth: node.depth,
		childCount: node.childCount,
		terminal: node.terminal,
		status: node.delegation?.status,
		a2aTaskId: node.delegation?.a2aTaskId,
		a2aDispatchStatus: node.delegation?.a2aDispatchStatus,
		parentDelegationId: node.delegation?.a2aParentDelegationId,
		rootDelegationId: node.delegation?.a2aRootDelegationId,
	};
}

function findDelegationNode(
	graph: PlatformAgentRegistryGetA2ADelegationGraphResult,
	delegationId: string,
): PlatformA2ADelegationGraphNode | undefined {
	return graph.nodes.find((node) => node.delegation?.id === delegationId);
}

function parseTimestamp(value: string | undefined): Date | undefined {
	const trimmed = trimString(value);
	if (!trimmed) {
		return undefined;
	}
	const date = new Date(trimmed);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

function throwIfUnsupportedContract(error: unknown, surface: string): void {
	const message = error instanceof Error ? error.message : String(error);
	if (
		/\b(404|501|unimplemented|unknown service|unknown method|not found)\b/iu.test(
			message,
		)
	) {
		throw new Error(
			`Platform target does not support ${surface} yet; deploy a Platform build with agents.v1 AgentService graph/control support before claiming live A2A proof. Cause: ${message}`,
		);
	}
}

function classifyAuthRejection(
	error: unknown,
): "unauthorized" | "forbidden" | undefined {
	const message = redactErrorMessage(error);
	if (/\b(401|unauthori[sz]ed|unauthenticated|invalid token)\b/iu.test(message)) {
		return "unauthorized";
	}
	if (/\b(403|forbidden|permission denied|access denied)\b/iu.test(message)) {
		return "forbidden";
	}
	return undefined;
}

function redactErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/[A-Za-z0-9_.~+/=-]{20,}/gu, "[redacted]");
}

function readGitSha(): string {
	return execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: process.cwd(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

async function writeEvidenceFile(
	outputDir: string,
	evidence: PlatformA2ALiveSmokeEvidence,
	context: PlatformA2ALiveSmokeEvidenceWriteContext,
): Promise<string> {
	const runDir = join(outputDir, evidence.createdAt.replace(/[:.]/gu, "-"));
	await mkdir(runDir, { recursive: true });
	const evidencePath = join(runDir, "evidence.json");
	const tempPath = `${evidencePath}.tmp`;
	const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
	const evidenceDigest = sha256Hex(evidenceBytes);
	await writeFile(tempPath, evidenceBytes);
	await rename(tempPath, evidencePath);
	await writeFile(`${evidencePath}.sha256`, `${evidenceDigest}  evidence.json\n`);
	const signature = await buildEvidenceSignature(
		evidenceBytes,
		evidenceDigest,
		context,
	);
	if (signature) {
		await writeFile(
			`${evidencePath}.sig.json`,
			`${JSON.stringify(signature, null, 2)}\n`,
		);
	}
	return evidencePath;
}

async function buildEvidenceSignature(
	evidenceBytes: string,
	evidenceDigest: string,
	context: PlatformA2ALiveSmokeEvidenceWriteContext,
): Promise<Record<string, unknown> | undefined> {
	const signingKeyPem = await resolveSigningPrivateKey(context.env);
	if (!signingKeyPem) {
		return undefined;
	}
	const privateKey = createPrivateKey(signingKeyPem);
	if (privateKey.asymmetricKeyType !== "ed25519") {
		throw new Error(
			`Platform A2A live evidence signing requires an Ed25519 private key, got ${privateKey.asymmetricKeyType ?? "unknown"}`,
		);
	}
	const signature = signBytes(null, Buffer.from(evidenceBytes), privateKey);
	return {
		protocolVersion: EVIDENCE_SIGNATURE_PROTOCOL_VERSION,
		algorithm: "ed25519",
		evidenceSha256: evidenceDigest,
		signature: signature.toString("base64"),
		keyId: trimString(context.env.MAESTRO_A2A_LIVE_EVIDENCE_SIGNING_KEY_ID),
		publicKeyFingerprintSha256: fingerprintPublicKey(privateKey),
		signedAt: context.now.toISOString(),
	};
}

async function resolveSigningPrivateKey(env: Env): Promise<string | undefined> {
	const inlineKey = firstEnv(env, EVIDENCE_SIGNING_KEY_ENV_VARS);
	if (inlineKey) {
		return normalizePem(inlineKey);
	}
	const keyFile = firstEnv(env, EVIDENCE_SIGNING_KEY_FILE_ENV_VARS);
	if (!keyFile) {
		return undefined;
	}
	return normalizePem(await readFile(keyFile, "utf8"));
}

function fingerprintPublicKey(privateKey: KeyObject): string {
	const publicKey = createPublicKey(privateKey);
	const publicDer = publicKey.export({ format: "der", type: "spki" });
	return createHash("sha256").update(publicDer).digest("hex");
}

function normalizePem(value: string): string {
	return value.includes("\\n") ? value.replace(/\\n/gu, "\n") : value;
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isEntrypoint(): boolean {
	const entrypoint = process.argv[1];
	return Boolean(entrypoint && import.meta.url === pathToFileURL(entrypoint).href);
}

if (isEntrypoint()) {
	runPlatformA2ADelegationLiveSmoke().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exitCode = 1;
	});
}
