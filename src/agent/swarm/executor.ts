/**
 * Swarm Executor
 *
 * Manages parallel execution of multiple agent instances (teammates)
 * working on tasks from a plan. Uses subprocess spawning similar to
 * the Oracle tool pattern.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type DelegationPrompt, formatDelegation } from "@evalops/contracts";
import { codexSubagentTypeA2ASkillID } from "../../codex/subagent-dispatch-table.js";
import {
	buildEvalOpsDelegationEnvironment,
	issueEvalOpsDelegationToken,
} from "../../oauth/index.js";
import { rankA2ACapabilityPeers } from "../../platform/a2a-capability-market.js";
import {
	type A2AServiceConfig,
	type A2ATask,
	buildA2AUserMessage,
	cancelA2ATask,
	getA2ATask,
	normalizeA2ABaseUrl,
	sendA2AMessage,
} from "../../platform/a2a-client.js";
import {
	type ResolvedA2APeer,
	resolveA2APeer,
} from "../../platform/a2a-peer-registry.js";
import {
	extractA2ATaskText,
	isTerminalA2AState,
	recordA2ATaskStart,
	updateA2ATaskInLedger,
} from "../../platform/a2a-task-ledger.js";
import {
	type PlatformAgentRegistryA2APeerCandidate,
	PlatformAgentStatusValue,
	listA2APeerCandidatesWithPlatform,
	resolveAgentRegistryServiceConfig,
} from "../../platform/agent-registry-client.js";
import { getEnvValue, trimString } from "../../platform/client.js";
import { recordSubagentDispatch } from "../../telemetry.js";
import { createLogger } from "../../utils/logger.js";
import {
	type AgentMode,
	type ModelProvider,
	type ResolvedSubagentDispatch,
	parseMode,
	resolveSubagentDispatch,
} from "../modes.js";
import { publishSwarmRuntimeEvent } from "./runtime-events.js";
import type {
	SwarmA2AConfig,
	SwarmConfig,
	SwarmEvent,
	SwarmEventHandler,
	SwarmState,
	SwarmStatus,
	SwarmTask,
	SwarmTeammate,
	TeammateStatus,
} from "./types.js";

const logger = createLogger("agent:swarm:executor");

/** Default timeout per task (5 minutes) */
const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000;

/** Maximum concurrent teammates */
const MAX_TEAMMATES = 10;
const DEFAULT_A2A_POLL_INTERVAL_MS = 2_000;
const A2A_SKILL_PRIMARY_TASK_CLASSES = new Map<string, string>([
	["maestro.subagent.code-writer", "code.implementation"],
	["maestro.subagent.code-review", "code.review"],
	["maestro.subagent.test-runner", "test.execution"],
	["maestro.subagent.repo-explorer", "repo.inspect"],
	["maestro.subagent.release-shepherd", "release.follow-through"],
]);
const SWARM_SUBAGENT_TASK_CLASSES = new Map<string, string>([
	["coder", "code.implementation"],
	["worker", "code.implementation"],
	["review", "code.review"],
	["reviewer", "code.review"],
	["explore", "repo.inspect"],
	["explorer", "repo.inspect"],
	["research", "repo.inspect"],
	["researcher", "repo.inspect"],
	["test", "test.execution"],
	["ci", "test.execution"],
	["ci-monitor", "test.execution"],
	["planner", "agent.delegation"],
	["minimal", "agent.delegation"],
	["custom", "agent.delegation"],
]);

/** Teammate name prefixes for friendly identification */
const TEAMMATE_NAMES = [
	"Alpha",
	"Beta",
	"Gamma",
	"Delta",
	"Epsilon",
	"Zeta",
	"Eta",
	"Theta",
	"Iota",
	"Kappa",
];

const MODEL_PROVIDERS: ModelProvider[] = [
	"anthropic",
	"openai",
	"openai-codex",
	"google",
];

function toSafeTaskTempBasename(taskId: string): string {
	const safeId = taskId
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return `swarm-task-${safeId || "task"}.md`;
}

function cloneTask(task: SwarmTask): SwarmTask {
	return {
		...task,
		files: task.files ? [...task.files] : undefined,
		dependsOn: task.dependsOn ? [...task.dependsOn] : undefined,
	};
}

function cloneTeammate(teammate: SwarmTeammate): SwarmTeammate {
	return {
		...teammate,
		currentTask: teammate.currentTask
			? cloneTask(teammate.currentTask)
			: undefined,
		completedTasks: [...teammate.completedTasks],
		a2a: teammate.a2a ? { ...teammate.a2a } : undefined,
	};
}

function cloneConfig(config: SwarmConfig): SwarmConfig {
	return {
		...config,
		a2a: config.a2a
			? {
					...config.a2a,
					peers: config.a2a.peers ? [...config.a2a.peers] : undefined,
				}
			: undefined,
		tasks: config.tasks.map(cloneTask),
	};
}

function cloneState(state: SwarmState): SwarmState {
	return {
		...state,
		config: cloneConfig(state.config),
		teammates: state.teammates.map(cloneTeammate),
		pendingTasks: state.pendingTasks.map(cloneTask),
		activeTasks: new Map(state.activeTasks),
		completedTasks: new Set(state.completedTasks),
		failedTasks: new Set(state.failedTasks),
	};
}

function parseModelProvider(
	value: string | undefined,
): ModelProvider | undefined {
	const provider = value?.trim();
	if (!provider) {
		return undefined;
	}
	return MODEL_PROVIDERS.includes(provider as ModelProvider)
		? (provider as ModelProvider)
		: undefined;
}

function parseAgentMode(value: string | undefined): AgentMode | undefined {
	const mode = value?.trim();
	if (!mode) {
		return undefined;
	}
	return parseMode(mode) ?? undefined;
}

function providerFromPrefixedModel(
	model: string | undefined,
): ModelProvider | undefined {
	const slashIndex = model?.indexOf("/") ?? -1;
	if (!model || slashIndex <= 0) {
		return undefined;
	}
	return parseModelProvider(model.slice(0, slashIndex));
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) {
		return undefined;
	}
	if (["1", "true", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(normalized)) {
		return false;
	}
	return undefined;
}

function parsePositiveIntEnv(value: string | undefined): number | undefined {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseCSVEnv(value: string | undefined): string[] | undefined {
	const parsed = value
		?.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	return parsed && parsed.length > 0 ? parsed : undefined;
}

function a2aStateCompleted(state: string | undefined): boolean {
	return /COMPLETED/u.test(
		(state ?? "").toUpperCase().replace(/[\s-]+/gu, "_"),
	);
}

type A2ATeammateRoute = {
	name: string;
	displayName?: string;
	config: A2AServiceConfig;
	skillId?: string;
	role?: string;
	tasksPath?: string;
	source: "registry" | "platform-agent-registry";
};

type RemoteA2ARunningTask = {
	route: A2ATeammateRoute;
	taskId: string;
};

function buildDispatchEnv(
	dispatch: ResolvedSubagentDispatch | null,
	reasoningEffortOverride?: string,
	runtimeSelection?: {
		model?: string;
		provider?: string;
		source?: string;
	},
): Record<string, string> {
	if (!dispatch) {
		return {};
	}

	const env: Record<string, string> = {
		MAESTRO_SWARM_MODE_NAME: dispatch.mode,
		MAESTRO_SWARM_SUBAGENT_TYPE: dispatch.type,
		MAESTRO_SWARM_MODEL: runtimeSelection?.model ?? dispatch.model,
		MAESTRO_SWARM_REASONING_EFFORT:
			reasoningEffortOverride ?? dispatch.reasoningEffort,
		MAESTRO_SWARM_DISPATCH_SOURCE: runtimeSelection?.source ?? dispatch.source,
	};
	const provider = runtimeSelection?.provider ?? dispatch.provider;
	if (provider) {
		env.MAESTRO_SWARM_MODEL_PROVIDER = provider;
	}
	return env;
}

type TaskDispatchResolution = {
	dispatch: ResolvedSubagentDispatch;
	startedAt: number;
	latencyMs: number;
	parentMode: AgentMode;
	parentModelProvider?: ModelProvider;
};

/**
 * SwarmExecutor manages a swarm of parallel agent instances.
 */
export class SwarmExecutor {
	private state: SwarmState;
	private processes: Map<string, ChildProcess> = new Map();
	private remoteA2ATasks: Map<string, RemoteA2ARunningTask> = new Map();
	private a2aRouteCursor = 0;
	private eventHandlers: Set<SwarmEventHandler> = new Set();
	private abortController: AbortController;

	constructor(config: SwarmConfig) {
		// Validate config
		if (config.teammateCount < 1 || config.teammateCount > MAX_TEAMMATES) {
			throw new Error(
				`Teammate count must be between 1 and ${MAX_TEAMMATES}, got ${config.teammateCount}`,
			);
		}

		this.abortController = new AbortController();

		// Initialize state
		this.state = {
			id: randomUUID(),
			status: "initializing",
			config,
			teammates: [],
			pendingTasks: [...config.tasks],
			activeTasks: new Map(),
			completedTasks: new Set(),
			failedTasks: new Set(),
			startedAt: Date.now(),
		};

		// Create teammates
		for (let i = 0; i < config.teammateCount; i++) {
			this.state.teammates.push({
				id: randomUUID(),
				name: TEAMMATE_NAMES[i] || `Teammate-${i + 1}`,
				status: "pending",
				completedTasks: [],
			});
		}

		logger.info("Swarm initialized", {
			swarmId: this.state.id,
			teammateCount: config.teammateCount,
			taskCount: config.tasks.length,
		});
	}

	/**
	 * Subscribe to swarm events.
	 */
	onEvent(handler: SwarmEventHandler): () => void {
		this.eventHandlers.add(handler);
		return () => this.eventHandlers.delete(handler);
	}

	/**
	 * Emit an event to all handlers.
	 */
	private emit(event: SwarmEvent): void {
		publishSwarmRuntimeEvent({
			event,
			parentSessionId: this.state.config.parentSessionId,
			cwd: this.state.config.cwd,
			planFile: this.state.config.planFile,
		});
		for (const handler of this.eventHandlers) {
			try {
				handler(event);
			} catch (error) {
				logger.error(
					"Event handler error",
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
	}

	/**
	 * Get the current swarm state.
	 */
	getState(): SwarmState {
		return cloneState(this.state);
	}

	/**
	 * Cancel the swarm execution.
	 */
	cancel(): void {
		const remoteTasks = [...this.remoteA2ATasks.entries()];
		for (const [teammateId, remoteTask] of remoteTasks) {
			void this.cancelRemoteA2ATask(teammateId, remoteTask);
		}

		this.abortController.abort();
		this.state.status = "cancelled";

		// Kill all running processes
		for (const [teammateId, proc] of this.processes) {
			try {
				proc.kill("SIGTERM");
			} catch {
				// Process may already be dead
			}
			const teammate = this.state.teammates.find((t) => t.id === teammateId);
			if (teammate) {
				teammate.status = "cancelled";
				teammate.currentTask = undefined;
			}
		}

		for (const teammate of this.state.teammates) {
			if (teammate.status === "running" || teammate.currentTask) {
				teammate.status = "cancelled";
				teammate.currentTask = undefined;
				teammate.completedAt = Date.now();
			}
		}

		this.state.activeTasks.clear();
		this.processes.clear();
		logger.info("Swarm cancelled", { swarmId: this.state.id });
	}

	private async cancelRemoteA2ATask(
		teammateId: string,
		remoteTask: RemoteA2ARunningTask,
	): Promise<void> {
		try {
			const cancelledTask = await cancelA2ATask(
				remoteTask.route.config,
				remoteTask.taskId,
			);
			await this.updateA2ASwarmTaskLedger(remoteTask.route, cancelledTask);
		} catch (error) {
			logger.warn("Failed to cancel remote A2A swarm task", {
				error: error instanceof Error ? error.message : String(error),
				swarmId: this.state.id,
				teammateId,
				remoteTaskId: remoteTask.taskId,
				peer: remoteTask.route.name,
			});
		} finally {
			this.remoteA2ATasks.delete(teammateId);
		}
	}

	/**
	 * Execute the swarm - runs all tasks with available teammates.
	 */
	async execute(): Promise<SwarmState> {
		this.state.status = "running";
		this.emit({
			type: "swarm_start",
			swarmId: this.state.id,
			config: this.state.config,
		});

		try {
			// Sort tasks by priority (higher first) and dependencies
			this.state.pendingTasks.sort(
				(a, b) => (b.priority ?? 0) - (a.priority ?? 0),
			);

			// Main execution loop
			while (
				this.state.status === "running" &&
				(this.state.pendingTasks.length > 0 || this.state.activeTasks.size > 0)
			) {
				this.skipTasksBlockedByFailedDependencies();

				// Assign tasks to idle teammates
				await this.assignTasks();

				// Wait for any task to complete
				if (this.state.activeTasks.size > 0) {
					await this.waitForAnyCompletion();
				}
			}

			// Determine final status
			// Note: status may have been changed to "cancelled" asynchronously via cancel()
			const finalStatus = this.state.status as SwarmStatus;
			if (
				this.state.failedTasks.size > 0 &&
				!this.state.config.continueOnFailure
			) {
				this.state.status = "failed";
				this.state.error = `${this.state.failedTasks.size} task(s) failed`;
			} else if (finalStatus !== "cancelled") {
				this.state.status = "completed";
			}
		} catch (error) {
			this.state.status = "failed";
			this.state.error = error instanceof Error ? error.message : String(error);
			this.emit({
				type: "swarm_fail",
				swarmId: this.state.id,
				error: this.state.error,
			});
		}

		this.state.completedAt = Date.now();
		this.emit({
			type: "swarm_complete",
			swarmId: this.state.id,
			state: this.state,
		});

		logger.info("Swarm execution complete", {
			swarmId: this.state.id,
			status: this.state.status,
			completed: this.state.completedTasks.size,
			failed: this.state.failedTasks.size,
			duration: this.state.completedAt - this.state.startedAt,
		});

		return this.state;
	}

	/**
	 * Assign pending tasks to idle teammates.
	 */
	private async assignTasks(): Promise<void> {
		const idleTeammates = this.state.teammates.filter(
			(t) => t.status === "pending" || t.status === "completed",
		);
		const spawnPromises: Promise<void>[] = [];

		for (const teammate of idleTeammates) {
			const task = this.getNextTask();
			if (!task) break;

			// Update state
			teammate.status = "running";
			teammate.currentTask = task;
			teammate.startedAt = Date.now();
			this.state.activeTasks.set(task.id, teammate.id);

			// Remove from pending
			const pendingIdx = this.state.pendingTasks.findIndex(
				(t) => t.id === task.id,
			);
			if (pendingIdx >= 0) {
				this.state.pendingTasks.splice(pendingIdx, 1);
			}

			this.emit({ type: "teammate_spawn", swarmId: this.state.id, teammate });
			this.emit({
				type: "task_start",
				swarmId: this.state.id,
				teammateId: teammate.id,
				task,
			});

			// Spawn the agent process
			spawnPromises.push(this.spawnTeammate(teammate, task));
		}

		if (spawnPromises.length > 0) {
			await Promise.all(spawnPromises);
		}
	}

	/**
	 * Get the next task that can be executed (dependencies satisfied).
	 */
	private getNextTask(): SwarmTask | null {
		for (const task of this.state.pendingTasks) {
			// Check dependencies
			if (task.dependsOn && task.dependsOn.length > 0) {
				const allDepsCompleted = task.dependsOn.every((depId) =>
					this.state.completedTasks.has(depId),
				);
				if (!allDepsCompleted) continue;
			}
			return task;
		}
		return null;
	}

	private skipTasksBlockedByFailedDependencies(): void {
		const blockedTasks = this.state.pendingTasks.filter((task) =>
			task.dependsOn?.some((depId) => this.state.failedTasks.has(depId)),
		);
		for (const task of blockedTasks) {
			const pendingIndex = this.state.pendingTasks.findIndex(
				(candidate) => candidate.id === task.id,
			);
			if (pendingIndex >= 0) {
				this.state.pendingTasks.splice(pendingIndex, 1);
			}
			this.state.failedTasks.add(task.id);
			const failedDependency = task.dependsOn?.find((depId) =>
				this.state.failedTasks.has(depId),
			);
			const error = `Dependency ${failedDependency ?? "unknown"} failed`;
			this.emit({
				type: "task_fail",
				swarmId: this.state.id,
				teammateId: "dependency",
				taskId: task.id,
				error,
			});
			if (!this.state.config.continueOnFailure) {
				this.state.status = "failed";
			}
		}
	}

	/**
	 * Spawn a subprocess agent for a teammate.
	 */
	private async buildTeammateEnv(
		teammate: SwarmTeammate,
		task: SwarmTask,
		dispatch: ResolvedSubagentDispatch | null,
		runtimeSelection?: {
			model?: string;
			provider?: string;
			source?: string;
		},
	): Promise<Record<string, string>> {
		const baseEnv: Record<string, string> = {
			...process.env,
			MAESTRO_SWARM_MODE: "1",
			MAESTRO_SWARM_ID: this.state.id,
			MAESTRO_TEAMMATE_ID: teammate.id,
			...buildDispatchEnv(
				dispatch,
				this.state.config.reasoningEffort,
				runtimeSelection,
			),
		};

		try {
			const delegation = await issueEvalOpsDelegationToken({
				agentId: teammate.id,
				agentType: "swarm_teammate",
				capabilities: ["swarm_task"],
				runId: `${this.state.id}:${task.id}`,
				surface: "maestro-swarm",
				token: process.env.MAESTRO_EVALOPS_ACCESS_TOKEN,
				ttlSeconds: Math.max(
					60,
					Math.ceil(
						(this.state.config.taskTimeout ?? DEFAULT_TASK_TIMEOUT_MS) / 1000,
					),
				),
			});
			return {
				...baseEnv,
				...buildEvalOpsDelegationEnvironment(delegation),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (
				message.includes("Run /login evalops first") ||
				message.includes("EvalOps login requires")
			) {
				return baseEnv;
			}
			logger.warn(
				"Failed to issue delegated EvalOps token for swarm teammate; using inherited auth",
				{
					error: message,
					swarmId: this.state.id,
					taskId: task.id,
					teammateId: teammate.id,
				},
			);
			return baseEnv;
		}
	}

	private resolveTaskDispatch(
		task: SwarmTask,
		teammate: SwarmTeammate,
		options: { hasModelOverride?: boolean } = {},
	): TaskDispatchResolution | null {
		const startedAt = Date.now();
		const subagentType = task.subagentType ?? this.state.config.subagentType;
		if (!subagentType) {
			return null;
		}

		const mode = this.resolveParentMode();
		const parentProvider = this.resolveParentModelProvider();
		const dispatch = resolveSubagentDispatch(
			mode,
			subagentType,
			parentProvider ?? "anthropic",
		);
		if (!parentProvider && dispatch.modelTier && !options.hasModelOverride) {
			this.recordTaskDispatch(
				task,
				dispatch,
				Math.max(0, Date.now() - startedAt),
				false,
				{
					parentMode: mode,
					parentModelProvider: parentProvider,
					teammateId: teammate.id,
					reason: "missing_parent_model_provider",
				},
			);
			return null;
		}

		return {
			dispatch,
			startedAt,
			latencyMs: Math.max(0, Date.now() - startedAt),
			parentMode: mode,
			parentModelProvider: parentProvider,
		};
	}

	private recordTaskDispatch(
		task: SwarmTask,
		dispatch: ResolvedSubagentDispatch,
		latencyMs: number,
		success: boolean,
		options: {
			parentMode: AgentMode;
			parentModelProvider?: ModelProvider;
			teammateId?: string;
			model?: string;
			provider?: string;
			source?: string;
			modelOverride?: "task" | "config";
			reason?: string;
		},
	): void {
		recordSubagentDispatch({
			mode: dispatch.mode,
			subagentType: dispatch.type,
			model: options.model ?? dispatch.model,
			provider: options.provider ?? dispatch.provider,
			reasoningEffort:
				this.state.config.reasoningEffort ?? dispatch.reasoningEffort,
			latencyMs,
			success,
			source: options.source ?? dispatch.source,
			metadata: {
				swarmId: this.state.id,
				teammateId: options.teammateId,
				taskId: task.id,
				parentMode: options.parentMode,
				parentModelProvider: options.parentModelProvider,
				dispatchModel: dispatch.model,
				dispatchProvider: dispatch.provider,
				dispatchSource: dispatch.source,
				modelTier: dispatch.modelTier,
				modelOverride: options.modelOverride,
				reason: options.reason,
			},
		});
	}

	private resolveParentMode(): AgentMode {
		return (
			this.state.config.mode ??
			parseAgentMode(process.env.MAESTRO_MODE) ??
			"smart"
		);
	}

	private resolveParentModelProvider(): ModelProvider | undefined {
		return (
			this.state.config.modelProvider ??
			parseModelProvider(process.env.MAESTRO_MODEL_PROVIDER) ??
			providerFromPrefixedModel(process.env.MAESTRO_MODEL)
		);
	}

	private resolveA2AConfig(): SwarmA2AConfig | null {
		const transport =
			this.state.config.transport ??
			trimString(process.env.MAESTRO_SWARM_TRANSPORT);
		if (transport !== "a2a") {
			return null;
		}
		const configured = this.state.config.a2a ?? {};
		const peers =
			configured.peers ?? parseCSVEnv(getEnvValue(["MAESTRO_SWARM_A2A_PEERS"]));
		return {
			...configured,
			...(peers ? { peers } : {}),
			registryPath:
				configured.registryPath ??
				trimString(process.env.MAESTRO_SWARM_A2A_REGISTRY),
			tasksPath:
				configured.tasksPath ?? trimString(process.env.MAESTRO_SWARM_A2A_TASKS),
			skillId:
				configured.skillId ??
				trimString(process.env.MAESTRO_SWARM_A2A_SKILL_ID),
			role: configured.role ?? trimString(process.env.MAESTRO_SWARM_A2A_ROLE),
			discover:
				configured.discover ??
				parseBooleanEnv(process.env.MAESTRO_SWARM_A2A_DISCOVER),
			workspaceId:
				configured.workspaceId ??
				trimString(process.env.MAESTRO_SWARM_A2A_WORKSPACE_ID),
			capability:
				configured.capability ??
				trimString(process.env.MAESTRO_SWARM_A2A_CAPABILITY),
			surface:
				configured.surface ?? trimString(process.env.MAESTRO_SWARM_A2A_SURFACE),
			preferInternalEndpoint:
				configured.preferInternalEndpoint ??
				parseBooleanEnv(process.env.MAESTRO_SWARM_A2A_PREFER_INTERNAL),
			limit:
				configured.limit ??
				parsePositiveIntEnv(process.env.MAESTRO_SWARM_A2A_LIMIT),
			timeoutMs:
				configured.timeoutMs ??
				parsePositiveIntEnv(process.env.MAESTRO_SWARM_A2A_TIMEOUT_MS),
			maxAttempts:
				configured.maxAttempts ??
				parsePositiveIntEnv(process.env.MAESTRO_SWARM_A2A_MAX_ATTEMPTS),
			maxWaitMs:
				configured.maxWaitMs ??
				parsePositiveIntEnv(process.env.MAESTRO_SWARM_A2A_MAX_WAIT_MS),
			pollIntervalMs:
				configured.pollIntervalMs ??
				parsePositiveIntEnv(process.env.MAESTRO_SWARM_A2A_POLL_INTERVAL_MS),
		};
	}

	private async resolveA2ATeammateRoute(
		teammate: SwarmTeammate,
		task: SwarmTask,
		options: SwarmA2AConfig,
	): Promise<A2ATeammateRoute> {
		if (options.discover) {
			return this.resolvePlatformDiscoveredA2ATeammateRoute(
				teammate,
				task,
				options,
			);
		}
		const peerName = this.selectA2APeerName(teammate, task, options);
		const peer = await resolveA2APeer(peerName, {
			path: options.registryPath,
			timeoutMs: options.timeoutMs,
			maxAttempts: options.maxAttempts,
		});
		return {
			name: peer.name,
			displayName: peer.entry.displayName,
			config: peer.config,
			skillId: this.resolveA2ASkillId(task, options, peer),
			role: options.role ?? task.subagentType,
			tasksPath: options.tasksPath,
			source: "registry",
		};
	}

	private async resolvePlatformDiscoveredA2ATeammateRoute(
		teammate: SwarmTeammate,
		task: SwarmTask,
		options: SwarmA2AConfig,
	): Promise<A2ATeammateRoute> {
		const skillId = this.resolveA2ASkillId(task, options);
		const pinnedPeer = trimString(task.a2aPeer);
		const routeIndex = pinnedPeer ? 0 : this.nextA2ARouteIndex();
		const candidates = await listA2APeerCandidatesWithPlatform({
			workspaceId: options.workspaceId,
			capability: options.capability,
			surface: options.surface ?? "a2a",
			status: PlatformAgentStatusValue.Idle,
			limit:
				options.limit ??
				(pinnedPeer ? undefined : this.defaultA2ADiscoveryLimit()),
			skillId,
			preferInternalEndpoint: options.preferInternalEndpoint,
		});
		if (!candidates || candidates.length === 0) {
			throw new Error(
				`No Platform A2A peers available for swarm task ${task.id}${
					skillId ? ` with skill ${skillId}` : ""
				}`,
			);
		}
		const candidatePool = pinnedPeer
			? candidates.filter((candidate) =>
					platformA2ACandidateMatchesPeer(candidate, pinnedPeer),
				)
			: candidates;
		if (candidatePool.length === 0) {
			throw new Error(
				`No Platform A2A peer matched task ${task.id} a2aPeer ${pinnedPeer}`,
			);
		}
		const rankedCandidates = rankA2ACapabilityPeers(candidatePool, {
			skillId,
			taskClass: this.resolveA2ATaskClass(task, options, skillId),
			preferInternalEndpoint: options.preferInternalEndpoint,
		});
		if (rankedCandidates.length === 0) {
			throw new Error(
				`No Platform A2A peer satisfied capability policy for swarm task ${task.id}${
					skillId ? ` with skill ${skillId}` : ""
				}`,
			);
		}
		const candidateIndex = pinnedPeer
			? 0
			: routeIndex % rankedCandidates.length;
		const ranked = rankedCandidates[candidateIndex];
		const candidate = ranked?.candidate;
		if (!candidate || !ranked) {
			throw new Error(
				"Platform A2A peer discovery returned an invalid candidate",
			);
		}
		logger.info("Selected Platform A2A peer through capability market", {
			swarmId: this.state.id,
			taskId: task.id,
			agentId: candidate.agent.id,
			score: ranked.score,
			reasons: ranked.reasons,
			skillId,
		});
		const config = await this.a2aConfigForPlatformCandidate(candidate, options);
		return {
			name: candidate.agent.name ?? candidate.agent.id ?? candidate.endpointUrl,
			displayName: candidate.agent.name,
			config,
			skillId,
			role: options.role ?? task.subagentType,
			tasksPath: options.tasksPath,
			source: "platform-agent-registry",
		};
	}

	private async a2aConfigForPlatformCandidate(
		candidate: PlatformAgentRegistryA2APeerCandidate,
		options: SwarmA2AConfig,
	): Promise<A2AServiceConfig> {
		const platformConfig = await resolveAgentRegistryServiceConfig();
		if (!platformConfig) {
			throw new Error(
				"Platform Agent Registry service is not configured for A2A swarm discovery",
			);
		}
		return {
			baseUrl: normalizeA2ABaseUrl(candidate.endpointUrl),
			...(platformConfig.token ? { token: platformConfig.token } : {}),
			...(platformConfig.organizationId
				? { organizationId: platformConfig.organizationId }
				: {}),
			workspaceId:
				candidate.agent.workspaceId ??
				options.workspaceId ??
				platformConfig.workspaceId,
			...(candidate.agent.id ? { agentId: candidate.agent.id } : {}),
			actorId: "maestro-swarm",
			timeoutMs: options.timeoutMs ?? platformConfig.timeoutMs,
			maxAttempts: options.maxAttempts ?? platformConfig.maxAttempts,
		};
	}

	private selectA2APeerName(
		teammate: SwarmTeammate,
		task: SwarmTask,
		options: SwarmA2AConfig,
	): string {
		const peerName = trimString(task.a2aPeer);
		if (peerName) {
			return peerName;
		}
		const peers = options.peers ?? [];
		const selected = peers[this.nextA2ARouteIndex() % peers.length];
		if (!selected) {
			throw new Error(
				"Remote A2A swarm transport requires a task a2aPeer, a2a.peers, MAESTRO_SWARM_A2A_PEERS, or a2a.discover=true",
			);
		}
		return selected;
	}

	private resolveA2ASkillId(
		task: SwarmTask,
		options: SwarmA2AConfig,
		peer?: ResolvedA2APeer,
	): string | undefined {
		const configured =
			trimString(task.a2aSkillId) ??
			trimString(options.skillId) ??
			codexSubagentTypeA2ASkillID(
				task.subagentType ?? this.state.config.subagentType,
			);
		if (configured) {
			return configured;
		}
		return peer?.entry.skills?.[0]?.id;
	}

	private resolveA2ATaskClass(
		task: SwarmTask,
		options: SwarmA2AConfig,
		skillId: string | undefined,
	): string | undefined {
		const mappedSkillTaskClass = skillId
			? A2A_SKILL_PRIMARY_TASK_CLASSES.get(skillId)
			: undefined;
		if (mappedSkillTaskClass) {
			return mappedSkillTaskClass;
		}
		if (
			skillId &&
			(trimString(task.a2aSkillId) || trimString(options.skillId))
		) {
			return undefined;
		}
		const subagentType = trimString(
			task.subagentType ?? this.state.config.subagentType,
		);
		return (
			(subagentType
				? SWARM_SUBAGENT_TASK_CLASSES.get(subagentType)
				: undefined) ?? subagentType
		);
	}

	private teammateIndex(teammate: SwarmTeammate): number {
		const index = this.state.teammates.findIndex(
			(item) => item.id === teammate.id,
		);
		return index >= 0 ? index : 0;
	}

	private nextA2ARouteIndex(): number {
		const index = this.a2aRouteCursor;
		this.a2aRouteCursor += 1;
		return index;
	}

	private defaultA2ADiscoveryLimit(): number {
		return Math.max(
			1,
			this.state.config.teammateCount,
			this.state.config.tasks.length,
		);
	}

	private async spawnTeammate(
		teammate: SwarmTeammate,
		task: SwarmTask,
	): Promise<void> {
		const tmpFile = join(
			tmpdir(),
			`${this.state.id}-${toSafeTaskTempBasename(task.id)}`,
		);

		const delegationPrompt: DelegationPrompt = {
			goal: `Complete swarm task ${task.id} as teammate "${teammate.name}".`,
			context: `You are teammate "${teammate.name}" in swarm ${this.state.id}, working from plan file ${this.state.config.planFile}.`,
			task: task.prompt,
			evidence: task.files?.length
				? task.files.map((file) => `Relevant file: ${file}`)
				: [],
			validation:
				"Make the requested changes directly, add or update focused tests when behavior changes, and run the relevant verification before finishing.",
			stoppingCondition:
				"Stop when the assigned task is complete and report what changed, what you verified, and any blockers. Do not broaden into unrelated tasks.",
		};
		const prompt = formatDelegation(delegationPrompt);

		writeFileSync(tmpFile, prompt);

		const a2aConfig = this.resolveA2AConfig();
		if (a2aConfig) {
			void this.spawnA2ATeammate(teammate, task, prompt, tmpFile, a2aConfig);
			return;
		}

		const modelOverride =
			task.model !== undefined
				? "task"
				: this.state.config.model !== undefined
					? "config"
					: undefined;
		const hasModelOverride = Boolean(modelOverride);
		const dispatchResolution = this.resolveTaskDispatch(task, teammate, {
			hasModelOverride,
		});
		const dispatch = dispatchResolution?.dispatch ?? null;
		const model = task.model ?? this.state.config.model ?? dispatch?.model;
		const overrideProvider = hasModelOverride
			? (providerFromPrefixedModel(model) ?? "unknown")
			: undefined;
		const telemetryProvider =
			overrideProvider ?? (hasModelOverride ? "unknown" : dispatch?.provider);
		const dispatchSource = hasModelOverride ? "override" : dispatch?.source;
		const provider = hasModelOverride ? undefined : dispatch?.provider;
		const args = [
			"--no-session",
			...(provider ? ["--provider", provider] : []),
			...(model ? ["--model", model] : []),
			"exec",
			tmpFile,
		];
		const env = await this.buildTeammateEnv(
			teammate,
			task,
			dispatch,
			dispatch
				? {
						model,
						provider: telemetryProvider,
						source: dispatchSource,
					}
				: undefined,
		);

		if (
			this.state.status !== "running" ||
			this.abortController.signal.aborted
		) {
			try {
				unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}

			this.state.activeTasks.delete(task.id);
			teammate.currentTask = undefined;
			teammate.completedAt = Date.now();

			if (teammate.status !== "cancelled") {
				teammate.status =
					this.state.status === "failed" ? "failed" : "cancelled";
			}

			this.emit({
				type: "teammate_complete",
				swarmId: this.state.id,
				teammate,
			});
			return;
		}

		const proc = spawn("maestro", args, {
			cwd: this.state.config.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env,
		});

		teammate.pid = proc.pid;
		this.processes.set(teammate.id, proc);

		let dispatchRecorded = false;
		const recordDispatchOutcome = (success: boolean, reason?: string): void => {
			if (!dispatch || !dispatchResolution || dispatchRecorded) {
				return;
			}
			dispatchRecorded = true;
			this.recordTaskDispatch(
				task,
				dispatch,
				Math.max(0, Date.now() - dispatchResolution.startedAt),
				success,
				{
					parentMode: dispatchResolution.parentMode,
					parentModelProvider: dispatchResolution.parentModelProvider,
					teammateId: teammate.id,
					model,
					provider: telemetryProvider,
					source: dispatchSource,
					modelOverride,
					reason,
				},
			);
		};

		proc.once("spawn", () => {
			recordDispatchOutcome(true);
		});

		let output = "";
		let errorOutput = "";

		proc.stdout?.on("data", (data) => {
			output += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			errorOutput += data.toString();
		});

		const timeout = this.state.config.taskTimeout ?? DEFAULT_TASK_TIMEOUT_MS;
		const timeoutHandle = setTimeout(() => {
			proc.kill("SIGTERM");
			teammate.error = "Task timed out";
		}, timeout);

		proc.on("close", (code) => {
			clearTimeout(timeoutHandle);
			this.processes.delete(teammate.id);

			// Cleanup temp file
			try {
				unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}

			const taskId = task.id;
			teammate.completedAt = Date.now();
			teammate.currentTask = undefined;
			teammate.output = output;

			this.state.activeTasks.delete(taskId);

			if (
				this.state.status === "cancelled" ||
				teammate.status === "cancelled"
			) {
				teammate.status = "cancelled";
				this.emit({
					type: "teammate_complete",
					swarmId: this.state.id,
					teammate,
				});
				return;
			}

			if (code === 0 && !teammate.error) {
				teammate.status = "completed";
				teammate.completedTasks.push(taskId);
				this.state.completedTasks.add(taskId);
				this.emit({
					type: "task_complete",
					swarmId: this.state.id,
					teammateId: teammate.id,
					taskId,
					output,
				});
			} else {
				teammate.status = "failed";
				teammate.error = teammate.error || errorOutput || `Exit code ${code}`;
				this.state.failedTasks.add(taskId);
				this.emit({
					type: "task_fail",
					swarmId: this.state.id,
					teammateId: teammate.id,
					taskId,
					error: teammate.error,
				});

				// Stop swarm if not continuing on failure
				if (!this.state.config.continueOnFailure) {
					this.state.status = "failed";
				}
			}

			this.emit({
				type: "teammate_complete",
				swarmId: this.state.id,
				teammate,
			});

			// Only recycle idle teammates while the swarm still has work left.
			if (
				this.state.status === "running" &&
				(this.state.pendingTasks.length > 0 ||
					this.state.activeTasks.size > 0) &&
				(teammate.status === "completed" || this.state.config.continueOnFailure)
			) {
				teammate.status = "pending";
				teammate.error = undefined;
			}
		});

		proc.on("error", (err) => {
			recordDispatchOutcome(false, "spawn_error");
			clearTimeout(timeoutHandle);
			this.processes.delete(teammate.id);
			this.state.activeTasks.delete(task.id);

			try {
				unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}

			teammate.completedAt = Date.now();
			teammate.currentTask = undefined;
			teammate.output = output || errorOutput;

			if (
				this.state.status === "cancelled" ||
				teammate.status === "cancelled"
			) {
				teammate.status = "cancelled";
				teammate.currentTask = undefined;
				this.emit({
					type: "teammate_complete",
					swarmId: this.state.id,
					teammate,
				});
				return;
			}

			teammate.status = "failed";
			teammate.error = err.message;
			this.state.failedTasks.add(task.id);

			this.emit({
				type: "task_fail",
				swarmId: this.state.id,
				teammateId: teammate.id,
				taskId: task.id,
				error: err.message,
			});

			if (!this.state.config.continueOnFailure) {
				this.state.status = "failed";
			}

			this.emit({
				type: "teammate_complete",
				swarmId: this.state.id,
				teammate,
			});

			if (
				this.state.status === "running" &&
				(this.state.pendingTasks.length > 0 ||
					this.state.activeTasks.size > 0) &&
				this.state.config.continueOnFailure
			) {
				teammate.status = "pending";
				teammate.error = undefined;
			}
		});
	}

	private async spawnA2ATeammate(
		teammate: SwarmTeammate,
		task: SwarmTask,
		prompt: string,
		tmpFile: string,
		options: SwarmA2AConfig,
	): Promise<void> {
		try {
			const route = await this.resolveA2ATeammateRoute(teammate, task, options);
			const messageId = `maestro-swarm-message-${randomUUID()}`;
			const contextId = `maestro-swarm:${this.state.id}:${task.id}`;
			const sent = await sendA2AMessage(route.config, {
				message: buildA2AUserMessage({
					messageId,
					contextId,
					text: prompt,
					metadata: this.buildA2ASwarmMessageMetadata(teammate, task, route),
				}),
				configuration: {
					returnImmediately: true,
					acceptedOutputModes: ["text/plain", "application/json"],
				},
				metadata: {
					route: "maestro_swarm",
					transport: "a2a",
					swarmId: this.state.id,
					taskId: task.id,
					teammateId: teammate.id,
					peer: route.name,
					source: route.source,
				},
			});
			teammate.a2a = {
				peer: route.name,
				peerDisplayName: route.displayName,
				source: route.source,
				taskId: sent.task.id,
				contextId: sent.task.contextId ?? contextId,
				messageId,
				skillId: route.skillId,
				role: route.role,
			};
			this.remoteA2ATasks.set(teammate.id, {
				route,
				taskId: sent.task.id,
			});
			await this.recordA2ASwarmTaskStart(route, task, sent.task, {
				messageId,
				contextId,
			});
			if (
				this.state.status === "cancelled" ||
				this.abortController.signal.aborted
			) {
				await this.cancelRemoteA2ATask(teammate.id, {
					route,
					taskId: sent.task.id,
				});
				return;
			}
			const remoteTask = await this.waitForA2ASwarmTask(
				route.config,
				sent.task,
				options,
			);
			await this.updateA2ASwarmTaskLedger(route, remoteTask);
			this.completeA2ATeammate(teammate, task, remoteTask, route);
		} catch (error) {
			if (
				this.state.status !== "cancelled" &&
				!this.abortController.signal.aborted
			) {
				const remoteTask = this.remoteA2ATasks.get(teammate.id);
				if (remoteTask) {
					await this.cancelRemoteA2ATask(teammate.id, remoteTask);
				}
			}
			this.failA2ATeammate(teammate, task, error);
		} finally {
			this.remoteA2ATasks.delete(teammate.id);
			try {
				unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}
		}
	}

	private buildA2ASwarmMessageMetadata(
		teammate: SwarmTeammate,
		task: SwarmTask,
		route: A2ATeammateRoute,
	): Record<string, unknown> {
		const currentDelegationId = `${this.state.id}:${task.id}`;
		const lineage = {
			rootDelegationId: this.state.id,
			...(this.state.config.parentSessionId
				? { parentDelegationId: this.state.config.parentSessionId }
				: {}),
			currentDelegationId,
			delegationChain: [this.state.id, currentDelegationId],
			delegationChainDepth: 1,
			maxDelegationChainDepth: 1,
		};
		const subagentRequest = route.skillId
			? {
					skillId: route.skillId,
					role: route.role,
					cwd: this.state.config.cwd,
					taskId: task.id,
					swarmId: this.state.id,
				}
			: undefined;
		return {
			requestKind: "maestro-swarm-task",
			transport: "a2a",
			relayPeer: route.name,
			swarmId: this.state.id,
			teammateId: teammate.id,
			teammateName: teammate.name,
			taskId: task.id,
			...(route.skillId ? { a2aSkillId: route.skillId } : {}),
			...(task.files?.length ? { files: task.files } : {}),
			swarm: lineage,
			evalops: {
				swarm: lineage,
				transport: "a2a",
				peer: route.name,
			},
			...(subagentRequest
				? { "evalops.subagentRequest": subagentRequest }
				: {}),
		};
	}

	private async waitForA2ASwarmTask(
		config: A2AServiceConfig,
		initialTask: A2ATask,
		options: SwarmA2AConfig,
	): Promise<A2ATask> {
		const maxWaitMs =
			options.maxWaitMs ??
			this.state.config.taskTimeout ??
			DEFAULT_TASK_TIMEOUT_MS;
		const pollIntervalMs =
			options.pollIntervalMs ?? DEFAULT_A2A_POLL_INTERVAL_MS;
		const deadline = Date.now() + maxWaitMs;
		let task = initialTask;
		while (
			!isTerminalA2AState(task.status.state) &&
			Date.now() < deadline &&
			!this.abortController.signal.aborted
		) {
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
			task = await getA2ATask(config, task.id, {
				signal: this.abortController.signal,
			});
		}
		if (!isTerminalA2AState(task.status.state)) {
			throw new Error(
				`Timed out waiting for remote A2A task ${task.id}; last state ${task.status.state}`,
			);
		}
		return task;
	}

	private completeA2ATeammate(
		teammate: SwarmTeammate,
		task: SwarmTask,
		remoteTask: A2ATask,
		route: A2ATeammateRoute,
	): void {
		this.state.activeTasks.delete(task.id);
		teammate.completedAt = Date.now();
		teammate.currentTask = undefined;
		teammate.output =
			extractA2ATaskText(remoteTask) ??
			`Remote A2A task ${remoteTask.id} finished with ${remoteTask.status.state}`;
		if (this.state.status === "cancelled" || teammate.status === "cancelled") {
			teammate.status = "cancelled";
			this.emit({
				type: "teammate_complete",
				swarmId: this.state.id,
				teammate,
			});
			return;
		}
		if (a2aStateCompleted(remoteTask.status.state)) {
			teammate.status = "completed";
			teammate.completedTasks.push(task.id);
			this.state.completedTasks.add(task.id);
			this.emit({
				type: "task_complete",
				swarmId: this.state.id,
				teammateId: teammate.id,
				taskId: task.id,
				output: teammate.output,
			});
		} else {
			teammate.status = "failed";
			teammate.error = `Remote A2A task ${remoteTask.id} on ${route.name} ended in ${remoteTask.status.state}`;
			this.state.failedTasks.add(task.id);
			this.emit({
				type: "task_fail",
				swarmId: this.state.id,
				teammateId: teammate.id,
				taskId: task.id,
				error: teammate.error,
			});
			if (!this.state.config.continueOnFailure) {
				this.state.status = "failed";
			}
		}
		this.emit({
			type: "teammate_complete",
			swarmId: this.state.id,
			teammate,
		});
		if (
			this.state.status === "running" &&
			(this.state.pendingTasks.length > 0 || this.state.activeTasks.size > 0) &&
			(teammate.status === "completed" || this.state.config.continueOnFailure)
		) {
			teammate.status = "pending";
			teammate.error = undefined;
		}
	}

	private failA2ATeammate(
		teammate: SwarmTeammate,
		task: SwarmTask,
		error: unknown,
	): void {
		this.state.activeTasks.delete(task.id);
		teammate.completedAt = Date.now();
		teammate.currentTask = undefined;
		if (this.state.status === "cancelled" || teammate.status === "cancelled") {
			teammate.status = "cancelled";
			this.emit({
				type: "teammate_complete",
				swarmId: this.state.id,
				teammate,
			});
			return;
		}
		if (teammate.a2a && !this.remoteA2ATasks.has(teammate.id)) {
			teammate.a2a = undefined;
		}
		teammate.status = "failed";
		teammate.error = error instanceof Error ? error.message : String(error);
		this.state.failedTasks.add(task.id);
		this.emit({
			type: "task_fail",
			swarmId: this.state.id,
			teammateId: teammate.id,
			taskId: task.id,
			error: teammate.error,
		});
		if (!this.state.config.continueOnFailure) {
			this.state.status = "failed";
		}
		this.emit({
			type: "teammate_complete",
			swarmId: this.state.id,
			teammate,
		});

		if (
			this.state.status === "running" &&
			(this.state.pendingTasks.length > 0 || this.state.activeTasks.size > 0) &&
			this.state.config.continueOnFailure
		) {
			teammate.status = "pending";
			teammate.error = undefined;
			teammate.a2a = undefined;
		}
	}

	private async recordA2ASwarmTaskStart(
		route: A2ATeammateRoute,
		task: SwarmTask,
		remoteTask: A2ATask,
		ids: { messageId: string; contextId: string },
	): Promise<void> {
		try {
			await recordA2ATaskStart({
				path: route.tasksPath,
				peer: route.name,
				peerDisplayName: route.displayName,
				task: remoteTask,
				text: task.prompt,
				messageId: ids.messageId,
				contextId: remoteTask.contextId ?? ids.contextId,
				kind: "delegation",
				role: route.role,
				cwd: this.state.config.cwd,
				metadata: {
					requestKind: "maestro-swarm-task",
					relayPeer: route.name,
					swarmId: this.state.id,
					taskId: task.id,
					transport: "a2a",
					source: route.source,
					a2aSkillId: route.skillId,
				},
			});
		} catch (error) {
			logger.warn("Failed to record remote A2A swarm task in local ledger", {
				error: error instanceof Error ? error.message : String(error),
				swarmId: this.state.id,
				taskId: task.id,
				peer: route.name,
			});
		}
	}

	private async updateA2ASwarmTaskLedger(
		route: A2ATeammateRoute,
		remoteTask: A2ATask,
	): Promise<void> {
		try {
			await updateA2ATaskInLedger({
				path: route.tasksPath,
				peer: route.name,
				task: remoteTask,
			});
		} catch (error) {
			logger.warn("Failed to update remote A2A swarm task in local ledger", {
				error: error instanceof Error ? error.message : String(error),
				swarmId: this.state.id,
				remoteTaskId: remoteTask.id,
				peer: route.name,
			});
		}
	}

	/**
	 * Wait for any active task to complete.
	 */
	private waitForAnyCompletion(): Promise<void> {
		const initialActiveCount = this.state.activeTasks.size;
		return new Promise((resolve) => {
			const checkInterval = setInterval(() => {
				// Resolve as soon as at least one active task exits or the swarm stops.
				if (
					this.state.activeTasks.size < initialActiveCount ||
					this.state.status !== "running"
				) {
					clearInterval(checkInterval);
					resolve();
				}
			}, 100);
		});
	}
}

function platformA2ACandidateMatchesPeer(
	candidate: PlatformAgentRegistryA2APeerCandidate,
	peer: string,
): boolean {
	const selector = normalizePeerSelector(peer);
	const selectorBaseUrl = normalizePeerBaseUrl(peer);
	if (!selector) {
		return false;
	}
	const values = [
		candidate.agent.id,
		candidate.agent.name,
		candidate.endpointUrl,
		candidate.agentCardUrl,
	];
	return values.some((value) => {
		const candidateSelector = normalizePeerSelector(value);
		if (candidateSelector && candidateSelector === selector) {
			return true;
		}
		const candidateBaseUrl = normalizePeerBaseUrl(value);
		return Boolean(
			selectorBaseUrl &&
				candidateBaseUrl &&
				candidateBaseUrl === selectorBaseUrl,
		);
	});
}

function normalizePeerSelector(value: string | undefined): string | undefined {
	return trimString(value)?.toLowerCase();
}

function normalizePeerBaseUrl(value: string | undefined): string | undefined {
	const trimmed = trimString(value);
	return trimmed ? normalizeA2ABaseUrl(trimmed).toLowerCase() : undefined;
}

/**
 * Create and execute a swarm.
 */
export async function executeSwarm(
	config: SwarmConfig,
	onEvent?: SwarmEventHandler,
): Promise<SwarmState> {
	const executor = new SwarmExecutor(config);
	if (onEvent) {
		executor.onEvent(onEvent);
	}
	return executor.execute();
}
