import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildA2AUserMessage,
	getA2ATask,
	sendA2AMessage,
	type A2AServiceConfig,
} from "../src/platform/a2a-client.js";
import {
	listA2APeerCandidatesWithPlatform,
	type PlatformAgentRegistryAgent,
} from "../src/platform/agent-registry-client.js";
import { SwarmExecutor } from "../src/agent/swarm/executor.js";
import type { SwarmConfig, SwarmState } from "../src/agent/swarm/types.js";

const ORGANIZATION_ID = "org_local_a2a_swarm";
const WORKSPACE_ID = "workspace_local_a2a_swarm";
const REGISTRY_TOKEN = "local-a2a-swarm-token";
const PUSH_TOKEN = "local-a2a-swarm-push-token";
const CONTROL_READY_TIMEOUT_MS = 120_000;
const REGISTRY_READY_TIMEOUT_MS = 30_000;
const PUSH_EVENT_TIMEOUT_MS = 30_000;
const SKILL_ID = "maestro.subagent.code-review";
const DENIED_TASK_CLASS = "credential.materialization";
const RESUME_TASK_ID = "local-swarm-resume-task";

type MockAgent = PlatformAgentRegistryAgent & {
	currentObjectiveIds?: string[];
	heartbeatReceived?: boolean;
};

type CapturedRequest = {
	body: Record<string, unknown>;
	headers: IncomingMessage["headers"];
	method?: string;
	url?: string;
};

type PushEventSummary = {
	type: "statusUpdate" | "artifactUpdate" | "task";
	taskId?: string;
	state?: string;
};

type MockRegistry = {
	baseUrl: string;
	close: () => Promise<void>;
	requests: CapturedRequest[];
	agents: Map<string, MockAgent>;
	waitForAgents: (count: number) => Promise<void>;
};

type PushReceiver = {
	baseUrl: string;
	close: () => Promise<void>;
	requests: CapturedRequest[];
	waitForTaskEvents: (taskIds: string[]) => Promise<void>;
};

type ControlPlaneInstance = {
	agentId: string;
	name: string;
	baseUrl: string;
	tasksPath: string;
	process: ChildProcessWithoutNullStreams;
	stderr: () => string;
};

type EnvSnapshot = Record<string, string | undefined>;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openPort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("failed to allocate a local TCP port");
	}
	const port = address.port;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
	return port;
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => resolve(body));
		request.on("error", reject);
	});
}

function respondJson(
	response: ServerResponse,
	status: number,
	body: Record<string, unknown>,
): void {
	response.writeHead(status, {
		"Content-Type": "application/json",
		"Connect-Protocol-Version": "1",
	});
	response.end(JSON.stringify(body));
}

function stringValue(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function objectValue(
	record: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const value = record[key];
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function pushEventSummary(request: CapturedRequest): PushEventSummary | undefined {
	const statusUpdate = objectValue(request.body, "statusUpdate");
	if (statusUpdate) {
		const status = objectValue(statusUpdate, "status");
		return {
			type: "statusUpdate",
			taskId: stringValue(statusUpdate, "taskId"),
			state: status ? stringValue(status, "state") : undefined,
		};
	}
	const artifactUpdate = objectValue(request.body, "artifactUpdate");
	if (artifactUpdate) {
		return {
			type: "artifactUpdate",
			taskId: stringValue(artifactUpdate, "taskId"),
		};
	}
	const task = objectValue(request.body, "task");
	if (task) {
		const status = objectValue(task, "status");
		return {
			type: "task",
			taskId: stringValue(task, "id"),
			state: status ? stringValue(status, "state") : undefined,
		};
	}
	return undefined;
}

function pushEventCounts(requests: CapturedRequest[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const request of requests) {
		const summary = pushEventSummary(request);
		if (!summary) {
			continue;
		}
		counts[summary.type] = (counts[summary.type] ?? 0) + 1;
	}
	return counts;
}

function skillList(agent: MockAgent): Array<Record<string, unknown>> {
	const skills = agent.a2a?.skills;
	return Array.isArray(skills)
		? (skills.filter(
				(skill): skill is Record<string, unknown> =>
					Boolean(skill) && typeof skill === "object" && !Array.isArray(skill),
			) as Array<Record<string, unknown>>)
		: [];
}

function skillAllowsTaskClass(
	agent: MockAgent,
	skillId: string | undefined,
	taskClass: string | undefined,
): boolean {
	if (!taskClass) {
		return true;
	}
	const skills = skillList(agent).filter(
		(skill) => !skillId || stringValue(skill, "id") === skillId,
	);
	if (skills.length === 0) {
		return false;
	}
	return skills.some((skill) => {
		const denied = new Set(stringList(skill, "deniedTaskClasses"));
		if (denied.has(taskClass)) {
			return false;
		}
		const allowed = new Set(stringList(skill, "allowedTaskClasses"));
		return allowed.size === 0 || allowed.has(taskClass);
	});
}

function agentHasSkill(agent: MockAgent, skillId: string | undefined): boolean {
	if (!skillId) {
		return true;
	}
	return skillList(agent).some((skill) => stringValue(skill, "id") === skillId);
}

function agentHasSurface(agent: MockAgent, surface: string | undefined): boolean {
	if (!surface) {
		return true;
	}
	return (agent.surfaces ?? []).includes(surface);
}

function agentHasCapability(
	agent: MockAgent,
	capability: string | undefined,
): boolean {
	if (!capability) {
		return true;
	}
	return (agent.capabilities ?? []).includes(capability);
}

function buildAgentFromRegister(body: Record<string, unknown>): MockAgent {
	const a2a = objectValue(body, "a2a");
	const now = new Date().toISOString();
	return {
		id: stringValue(body, "id"),
		workspaceId: stringValue(body, "workspaceId") ?? WORKSPACE_ID,
		name: stringValue(body, "name"),
		description: stringValue(body, "description"),
		agentType: stringValue(body, "agentType") ?? "maestro",
		capabilities: stringList(body, "capabilities"),
		surfaces: stringList(body, "surfaces"),
		surfaceTypes: stringList(body, "surfaceTypes"),
		ownerId: stringValue(body, "ownerId"),
		status: "AGENT_STATUS_IDLE",
		heartbeatReceived: false,
		createdAt: now,
		updatedAt: now,
		a2a: a2a as MockAgent["a2a"],
		capacity: {
			current: 0,
			max: 2,
			remaining: 2,
			reservedDelegationCount: 0,
		},
	};
}

function applyHeartbeat(agent: MockAgent, body: Record<string, unknown>): MockAgent {
	const now = new Date().toISOString();
	const a2a = objectValue(body, "a2a") as MockAgent["a2a"] | undefined;
	return {
		...agent,
		status: stringValue(body, "status") ?? agent.status,
		lastHeartbeatAt: now,
		heartbeatReceived: true,
		updatedAt: now,
		currentObjectiveIds: stringList(body, "currentObjectiveIds"),
		surfaces: stringValue(body, "surface")
			? [stringValue(body, "surface") as string, "maestro"]
			: agent.surfaces,
		surfaceTypes: stringValue(body, "surfaceType")
			? [stringValue(body, "surfaceType") as string]
			: agent.surfaceTypes,
		a2a: a2a ?? agent.a2a,
	};
}

function filterAgents(
	agents: Iterable<MockAgent>,
	body: Record<string, unknown>,
): MockAgent[] {
	const workspaceId = stringValue(body, "workspaceId") ?? WORKSPACE_ID;
	const capability = stringValue(body, "capability");
	const surface = stringValue(body, "surface");
	const status = stringValue(body, "status");
	const skillId =
		stringValue(body, "a2aSkillId") ?? stringValue(body, "a2a_skill_id");
	const taskClass =
		stringValue(body, "taskClass") ?? stringValue(body, "task_class");
	const limit = Number(body.limit);
	return [...agents]
		.filter((agent) => agent.workspaceId === workspaceId)
		.filter((agent) => !status || agent.status === status)
		.filter((agent) => agentHasCapability(agent, capability))
		.filter((agent) => agentHasSurface(agent, surface))
		.filter((agent) => agentHasSkill(agent, skillId))
		.filter((agent) => skillAllowsTaskClass(agent, skillId, taskClass))
		.slice(0, Number.isFinite(limit) && limit > 0 ? limit : undefined);
}

async function startMockRegistry(): Promise<MockRegistry> {
	const port = await openPort();
	const agents = new Map<string, MockAgent>();
	const requests: CapturedRequest[] = [];
	const server = createServer(async (request, response) => {
		const rawBody = await readBody(request);
		const body = rawBody.trim()
			? (JSON.parse(rawBody) as Record<string, unknown>)
			: {};
		requests.push({
			body,
			headers: request.headers,
			method: request.method,
			url: request.url,
		});

		if (request.method !== "POST") {
			respondJson(response, 405, { error: "method not allowed" });
			return;
		}

		if (request.url === "/agents.v1.AgentService/Register") {
			const agent = buildAgentFromRegister(body);
			if (!agent.id) {
				respondJson(response, 400, { error: "missing id" });
				return;
			}
			agents.set(agent.id, agent);
			respondJson(response, 200, { agent });
			return;
		}

		if (request.url === "/agents.v1.AgentService/Update") {
			const id = stringValue(body, "id");
			if (!id) {
				respondJson(response, 400, { error: "missing id" });
				return;
			}
			const existing = agents.get(id);
			const updated = {
				...(existing ?? buildAgentFromRegister({ ...body, id })),
				...body,
				updatedAt: new Date().toISOString(),
			} as MockAgent;
			agents.set(id, updated);
			respondJson(response, 200, { agent: updated });
			return;
		}

		if (request.url === "/agents.v1.AgentService/Heartbeat") {
			const id = stringValue(body, "agentId");
			if (!id) {
				respondJson(response, 400, { error: "missing agentId" });
				return;
			}
			const existing =
				agents.get(id) ??
				buildAgentFromRegister({
					id,
					workspaceId: WORKSPACE_ID,
					name: id,
					agentType: "maestro",
					capabilities: [],
					surfaces: ["a2a", "maestro"],
					a2a: objectValue(body, "a2a"),
				});
			agents.set(id, applyHeartbeat(existing, body));
			respondJson(response, 200, {
				nextHeartbeatBy: new Date(Date.now() + 60_000).toISOString(),
			});
			return;
		}

		if (request.url === "/agents.v1.AgentService/List") {
			const filtered = filterAgents(agents.values(), body);
			respondJson(response, 200, {
				agents: filtered,
				total: filtered.length,
				discoveryEvidence: {
					schema: "evalops.local-a2a-swarm.discovery.v1",
					decision: filtered.length > 0 ? "allow" : "deny",
					workspaceId: stringValue(body, "workspaceId") ?? WORKSPACE_ID,
					capability: stringValue(body, "capability"),
					a2aSkillId: stringValue(body, "a2aSkillId"),
					taskClass: stringValue(body, "taskClass"),
					candidateCount: agents.size,
					matchedCount: filtered.length,
				},
			});
			return;
		}

		respondJson(response, 404, { error: "unknown method" });
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	});

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		requests,
		agents,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
		waitForAgents: async (count: number) => {
			const deadline = Date.now() + REGISTRY_READY_TIMEOUT_MS;
			while (Date.now() < deadline) {
				const heartbeated = [...agents.values()].filter(
					(agent) => agent.heartbeatReceived && agent.a2a?.publicEndpointUrl,
				);
				if (heartbeated.length >= count) {
					return;
				}
				await delay(100);
			}
			throw new Error(
				`mock Agent Registry saw ${agents.size} registered agents, expected ${count}`,
			);
		},
	};
}

async function startPushReceiver(): Promise<PushReceiver> {
	const port = await openPort();
	const requests: CapturedRequest[] = [];
	const server = createServer(async (request, response) => {
		const rawBody = await readBody(request);
		if (request.method !== "POST") {
			respondJson(response, 405, { error: "method not allowed" });
			return;
		}
		if (request.headers["x-a2a-notification-token"] !== PUSH_TOKEN) {
			respondJson(response, 401, { error: "missing push token" });
			return;
		}
		if (rawBody.includes(PUSH_TOKEN)) {
			respondJson(response, 400, { error: "push token leaked into body" });
			return;
		}
		const body = rawBody.trim()
			? (JSON.parse(rawBody) as Record<string, unknown>)
			: {};
		requests.push({
			body,
			headers: request.headers,
			method: request.method,
			url: request.url,
		});
		respondJson(response, 202, { ok: true });
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	});

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		requests,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
		waitForTaskEvents: async (taskIds: string[]) => {
			const deadline = Date.now() + PUSH_EVENT_TIMEOUT_MS;
			while (Date.now() < deadline) {
				const missing = taskIds.filter((taskId) => {
					const events = requests
						.map(pushEventSummary)
						.filter(
							(event): event is NonNullable<typeof event> =>
								Boolean(event) && event.taskId === taskId,
						);
					return (
						!events.some(
							(event) =>
								event.type === "statusUpdate" &&
								event.state === "TASK_STATE_COMPLETED",
						) ||
						!events.some((event) => event.type === "artifactUpdate") ||
						!events.some(
							(event) =>
								event.type === "task" &&
								event.state === "TASK_STATE_COMPLETED",
						)
					);
				});
				if (missing.length === 0) {
					return;
				}
				await delay(100);
			}
			throw new Error(
				`push receiver missed terminal task events for ${taskIds.join(", ")}; saw ${JSON.stringify(
					requests.map(pushEventSummary).filter(Boolean),
				)}`,
			);
		},
	};
}

async function proveInvalidPushTokenRejected(
	pushReceiver: PushReceiver,
): Promise<void> {
	const response = await fetch(`${pushReceiver.baseUrl}/a2a/push`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-a2a-notification-token": "wrong-local-token",
		},
		body: JSON.stringify({
			taskId: "unauthorized-local-swarm-task",
			status: { state: "TASK_STATE_COMPLETED" },
		}),
	});
	if (response.status !== 401) {
		throw new Error(`expected invalid push token to return 401, got ${response.status}`);
	}
	if (pushReceiver.requests.length !== 0) {
		throw new Error("invalid push token was recorded as an accepted push event");
	}
}

async function waitForHealth(
	baseUrl: string,
	stderr: () => string,
): Promise<void> {
	const deadline = Date.now() + CONTROL_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) {
				return;
			}
		} catch {
			// The Rust server may still be compiling or binding the port.
		}
		await delay(250);
	}
	throw new Error(`Rust control-plane did not become ready:\n${stderr()}`);
}

async function startControlPlane(input: {
	agentId: string;
	name: string;
	response: string;
	port: number;
	registryUrl: string;
	rootDir: string;
	objectiveId: string;
	seedResumeTask?: boolean;
}): Promise<ControlPlaneInstance> {
	const baseUrl = `http://127.0.0.1:${input.port}`;
	const tasksPath = join(input.rootDir, `${input.agentId}-tasks.json`);
	if (input.seedResumeTask) {
		await seedInputRequiredTask(tasksPath);
	}
	let stderr = "";
	const child = spawn(
		"cargo",
		[
			"run",
			"--quiet",
			"--manifest-path",
			"packages/control-plane-rs/Cargo.toml",
			"--bin",
			"maestro-control-plane",
		],
		{
			env: {
				...process.env,
				MAESTRO_A2A_AGENT_ID: input.agentId,
				MAESTRO_A2A_AGENT_NAME: input.name,
				MAESTRO_A2A_CURRENT_OBJECTIVE_IDS: input.objectiveId,
				MAESTRO_A2A_FAKE_RESPONSE: input.response,
				MAESTRO_A2A_INTERNAL_URL: baseUrl,
				MAESTRO_A2A_MAX_CONCURRENT_OBJECTIVES: "2",
				MAESTRO_A2A_PLATFORM_HEARTBEAT_INTERVAL_MS: "500",
				MAESTRO_A2A_PLATFORM_REGISTER: "1",
				MAESTRO_A2A_PLATFORM_STATUS: "AGENT_STATUS_IDLE",
				MAESTRO_A2A_PUBLIC_URL: baseUrl,
				MAESTRO_A2A_PUSH_ALLOW_INSECURE: "1",
				MAESTRO_A2A_PUSH_ALLOW_PRIVATE: "1",
				MAESTRO_A2A_PUSH_TIMEOUT_MS: "1000",
				MAESTRO_A2A_TASKS_FILE: tasksPath,
				MAESTRO_AGENT_REGISTRY_SERVICE_TOKEN: REGISTRY_TOKEN,
				MAESTRO_AGENT_REGISTRY_SERVICE_URL: input.registryUrl,
				MAESTRO_AGENT_REGISTRY_ORG_ID: ORGANIZATION_ID,
				MAESTRO_AGENT_REGISTRY_WORKSPACE_ID: WORKSPACE_ID,
				MAESTRO_CONTROL_HOST: "127.0.0.1",
				MAESTRO_WEB_REQUIRE_KEY: "0",
				PORT: String(input.port),
			},
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	await waitForHealth(baseUrl, () => stderr);
	return {
		agentId: input.agentId,
		name: input.name,
		baseUrl,
		tasksPath,
		process: child,
		stderr: () => stderr,
	};
}

async function seedInputRequiredTask(path: string): Promise<void> {
	await writeFile(
		path,
		`${JSON.stringify(
			{
				tasks: [
					{
						id: RESUME_TASK_ID,
						contextId: "local-swarm-resume-context",
						status: {
							state: "TASK_STATE_INPUT_REQUIRED",
							message: {
								messageId: "local-swarm-resume-question",
								contextId: "local-swarm-resume-context",
								role: "ROLE_AGENT",
								parts: [
									{
										text: "Need one more bounded instruction before finishing.",
										mediaType: "text/plain",
									},
								],
							},
						},
						history: [
							{
								messageId: "local-swarm-resume-user",
								contextId: "local-swarm-resume-context",
								role: "ROLE_USER",
								parts: [
									{
										text: "Start a resumable local swarm task.",
										mediaType: "text/plain",
									},
								],
							},
						],
						metadata: {
							workspaceId: WORKSPACE_ID,
							source: "smoke-maestro-a2a-local-swarm",
						},
					},
				],
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	child.kill("SIGTERM");
	await Promise.race([once(child, "exit"), delay(2_000)]);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
	}
}

function snapshotEnv(keys: string[]): EnvSnapshot {
	return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: EnvSnapshot): void {
	for (const [key, value] of Object.entries(snapshot)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

function configurePlatformEnv(registryUrl: string): EnvSnapshot {
	const keys = [
		"MAESTRO_AGENT_REGISTRY_SERVICE_URL",
		"MAESTRO_AGENT_REGISTRY_SERVICE_TOKEN",
		"MAESTRO_AGENT_REGISTRY_ORG_ID",
		"MAESTRO_AGENT_REGISTRY_WORKSPACE_ID",
		"MAESTRO_AGENT_REGISTRY_TIMEOUT_MS",
		"MAESTRO_AGENT_REGISTRY_MAX_ATTEMPTS",
	];
	const snapshot = snapshotEnv(keys);
	process.env.MAESTRO_AGENT_REGISTRY_SERVICE_URL = registryUrl;
	process.env.MAESTRO_AGENT_REGISTRY_SERVICE_TOKEN = REGISTRY_TOKEN;
	process.env.MAESTRO_AGENT_REGISTRY_ORG_ID = ORGANIZATION_ID;
	process.env.MAESTRO_AGENT_REGISTRY_WORKSPACE_ID = WORKSPACE_ID;
	process.env.MAESTRO_AGENT_REGISTRY_TIMEOUT_MS = "1500";
	process.env.MAESTRO_AGENT_REGISTRY_MAX_ATTEMPTS = "1";
	return snapshot;
}

async function provePolicyDenial(registryUrl: string): Promise<number> {
	const snapshot = configurePlatformEnv(registryUrl);
	try {
		const denied = await listA2APeerCandidatesWithPlatform({
			workspaceId: WORKSPACE_ID,
			capability: "code:review",
			surface: "a2a",
			status: "AGENT_STATUS_IDLE",
			skillId: SKILL_ID,
			taskClass: DENIED_TASK_CLASS,
			requireA2ADispatch: true,
			eligibleForDelegation: true,
		});
		return denied?.length ?? 0;
	} finally {
		restoreEnv(snapshot);
	}
}

function peerConfig(instance: ControlPlaneInstance): A2AServiceConfig {
	return {
		baseUrl: instance.baseUrl,
		workspaceId: WORKSPACE_ID,
		organizationId: ORGANIZATION_ID,
		token: REGISTRY_TOKEN,
		agentId: instance.agentId,
		actorId: "local-a2a-swarm-smoke",
		timeoutMs: 1_500,
		maxAttempts: 1,
	};
}

async function proveResume(instance: ControlPlaneInstance, taskId: string) {
	const config = peerConfig(instance);
	const response = await sendA2AMessage(config, {
		message: buildA2AUserMessage({
			messageId: `local-swarm-resume-${Date.now()}`,
			contextId: "local-swarm-resume-context",
			taskId,
			text: "Resume this existing A2A task and return the deterministic response again.",
		}),
		configuration: {
			acceptedOutputModes: ["text/plain"],
			returnImmediately: false,
		},
	});
	const task = await getA2ATask(config, response.task.id);
	if (task.id !== taskId) {
		throw new Error(`resume created sibling task ${task.id}, expected ${taskId}`);
	}
	if (task.status.state !== "TASK_STATE_COMPLETED") {
		throw new Error(`resumed task ended in ${task.status.state}`);
	}
	return {
		taskId: task.id,
		state: task.status.state,
	};
}

function taskText(state: SwarmState, taskId: string): string | undefined {
	return state.teammates.find((teammate) =>
		teammate.completedTasks.includes(taskId),
	)?.output;
}

async function runSwarm(
	registryUrl: string,
	rootDir: string,
	pushReceiver: PushReceiver,
): Promise<SwarmState> {
	const planFile = join(rootDir, "local-a2a-swarm-plan.md");
	await writeFile(
		planFile,
		[
			"# Local A2A Swarm Smoke",
			"",
			"- alpha-review: prove Platform-discovered peer alpha can complete remote A2A work.",
			"- beta-review: prove Platform-discovered peer beta can complete remote A2A work.",
		].join("\n"),
		"utf8",
	);
	const config: SwarmConfig = {
		teammateCount: 2,
		planFile,
		cwd: process.cwd(),
		mode: "smart",
		modelProvider: "anthropic",
		transport: "a2a",
		tasks: [
			{
				id: "alpha-review",
				prompt: "Return the alpha deterministic A2A swarm response.",
				subagentType: "reviewer",
			},
			{
				id: "beta-review",
				prompt: "Return the beta deterministic A2A swarm response.",
				subagentType: "reviewer",
			},
		],
		a2a: {
			discover: true,
			workspaceId: WORKSPACE_ID,
			capability: "code:review",
			surface: "a2a",
			skillId: SKILL_ID,
			preferInternalEndpoint: true,
			tasksPath: join(rootDir, "swarm-a2a-tasks.json"),
			timeoutMs: 1_500,
			maxAttempts: 1,
			maxWaitMs: 20_000,
			pollIntervalMs: 100,
			pushNotificationConfig: {
				id: "local-swarm-push",
				url: `${pushReceiver.baseUrl}/a2a/push`,
				token: PUSH_TOKEN,
			},
		},
		taskTimeout: 20_000,
	};
	const snapshot = configurePlatformEnv(registryUrl);
	try {
		const executor = new SwarmExecutor(config);
		const result = await executor.execute();
		if (result.status !== "completed") {
			throw new Error(`A2A swarm did not complete: ${result.status}`);
		}
		if (
			taskText(result, "alpha-review") !== "A2A local swarm response from alpha"
		) {
			throw new Error("alpha task did not return the alpha peer response");
		}
		if (taskText(result, "beta-review") !== "A2A local swarm response from beta") {
			throw new Error("beta task did not return the beta peer response");
		}
		return result;
	} finally {
		restoreEnv(snapshot);
	}
}

async function main(): Promise<void> {
	const rootDir = await mkdtemp(join(tmpdir(), "maestro-a2a-local-swarm-"));
	const registry = await startMockRegistry();
	const pushReceiver = await startPushReceiver();
	const instances: ControlPlaneInstance[] = [];
	try {
		await proveInvalidPushTokenRejected(pushReceiver);
		await mkdir(rootDir, { recursive: true });
		const alphaPort = await openPort();
		const betaPort = await openPort();
		instances.push(
			await startControlPlane({
				agentId: "maestro-a2a-local-alpha",
				name: "Maestro Local A2A Alpha",
				response: "A2A local swarm response from alpha",
				port: alphaPort,
				registryUrl: registry.baseUrl,
				rootDir,
				objectiveId: "objective-alpha",
				seedResumeTask: true,
			}),
		);
		instances.push(
			await startControlPlane({
				agentId: "maestro-a2a-local-beta",
				name: "Maestro Local A2A Beta",
				response: "A2A local swarm response from beta",
				port: betaPort,
				registryUrl: registry.baseUrl,
				rootDir,
				objectiveId: "objective-beta",
			}),
		);
		await registry.waitForAgents(2);
		const deniedCandidateCount = await provePolicyDenial(registry.baseUrl);
		if (deniedCandidateCount !== 0) {
			throw new Error(
				`denied discovery returned ${deniedCandidateCount} candidates`,
			);
		}
		const swarm = await runSwarm(registry.baseUrl, rootDir, pushReceiver);
		const completedExecutions = swarm.teammates
			.map((teammate) => teammate.a2a)
			.filter((a2a): a2a is NonNullable<typeof a2a> => Boolean(a2a));
		const peersUsed = new Set(completedExecutions.map((a2a) => a2a.peer));
		if (peersUsed.size !== 2) {
			throw new Error(
				`expected swarm to use both local peers, used ${[...peersUsed].join(", ")}`,
			);
		}
		await pushReceiver.waitForTaskEvents(
			completedExecutions.map((a2a) => a2a.taskId),
		);
		const alpha = instances.find(
			(instance) => instance.name === "Maestro Local A2A Alpha",
		);
		if (!alpha) {
			throw new Error("missing alpha control plane");
		}
		const resume = await proveResume(alpha, RESUME_TASK_ID);
		const ledger = JSON.parse(
			await readFile(join(rootDir, "swarm-a2a-tasks.json"), "utf8"),
		) as Record<string, unknown>;
		const ledgerTasks = Array.isArray(ledger.tasks)
			? (ledger.tasks.filter(
					(task): task is Record<string, unknown> =>
						Boolean(task) && typeof task === "object" && !Array.isArray(task),
				) as Record<string, unknown>[])
			: [];
		const ledgerWorkGraphs = ledgerTasks.filter((task) =>
			Boolean(objectValue(task, "workGraph")),
		);
		if (ledgerWorkGraphs.length !== completedExecutions.length) {
			throw new Error(
				`expected ${completedExecutions.length} ledger work graphs, saw ${ledgerWorkGraphs.length}`,
			);
		}
		const pushBodyJson = JSON.stringify(
			pushReceiver.requests.map((request) => request.body),
		);
		if (pushBodyJson.includes(PUSH_TOKEN)) {
			throw new Error("push token leaked into push notification payload body");
		}
		console.log(
			JSON.stringify(
				{
					ok: true,
					registry: {
						url: registry.baseUrl,
						registeredAgents: [...registry.agents.keys()],
						registerCount: registry.requests.filter((request) =>
							request.url?.endsWith("/Register"),
						).length,
						heartbeatCount: registry.requests.filter((request) =>
							request.url?.endsWith("/Heartbeat"),
						).length,
						heartbeatReceivedAgents: [...registry.agents.values()].filter(
							(agent) => agent.heartbeatReceived,
						).length,
						listCount: registry.requests.filter((request) =>
							request.url?.endsWith("/List"),
						).length,
						policyDeniedCandidateCount: deniedCandidateCount,
					},
					swarm: {
						id: swarm.id,
						status: swarm.status,
						completedTasks: [...swarm.completedTasks],
						peersUsed: [...peersUsed],
						remoteTasks: completedExecutions.map((a2a) => ({
							peer: a2a.peer,
							source: a2a.source,
							taskId: a2a.taskId,
							contextId: a2a.contextId,
							skillId: a2a.skillId,
						})),
						ledgerTasks: Array.isArray(ledger.tasks)
							? ledger.tasks.length
							: undefined,
						ledgerWorkGraphs: ledgerWorkGraphs.length,
					},
					pushNotifications: {
						url: pushReceiver.baseUrl,
						received: pushReceiver.requests.length,
						eventCounts: pushEventCounts(pushReceiver.requests),
						remoteTaskIds: completedExecutions.map((a2a) => a2a.taskId),
					},
					resume,
				},
				null,
				2,
			),
		);
	} finally {
		await Promise.all(
			instances.map((instance) => stopProcess(instance.process)),
		);
		await registry.close();
		await pushReceiver.close();
		if (process.env.MAESTRO_A2A_LOCAL_SWARM_KEEP_TMP !== "1") {
			await rm(rootDir, { recursive: true, force: true });
		}
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exit(1);
});
