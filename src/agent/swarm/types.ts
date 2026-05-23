/**
 * Swarm Mode Types
 *
 * Type definitions for the swarm execution system that enables
 * parallel agent execution for implementing plans.
 */

import type { A2ATaskPushNotificationConfig } from "../../platform/a2a-client.js";
import type { AgentMode, ModelProvider, ReasoningEffort } from "../modes.js";
import type { SubagentType } from "../subagent-specs.js";

/**
 * Status of a swarm teammate.
 */
export type TeammateStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

/**
 * A single task assigned to a teammate in the swarm.
 */
export interface SwarmTask {
	/** Unique task identifier */
	id: string;
	/** Task description/prompt for the teammate */
	prompt: string;
	/** Files relevant to this task */
	files?: string[];
	/** Dependencies on other task IDs (must complete first) */
	dependsOn?: string[];
	/** Optional model override for this task */
	model?: string;
	/** Optional subagent type used for mode-level model dispatch */
	subagentType?: SubagentType;
	/** Optional A2A peer override when the swarm uses remote transport */
	a2aPeer?: string;
	/** Optional A2A skill override when the task maps to a remote Maestro lane */
	a2aSkillId?: string;
	/** Priority (higher = earlier execution when no dependencies) */
	priority?: number;
}

/**
 * A teammate in the swarm - an individual agent working on tasks.
 */
export interface SwarmTeammate {
	/** Unique teammate identifier */
	id: string;
	/** Display name for the teammate */
	name: string;
	/** Current status */
	status: TeammateStatus;
	/** Currently assigned task */
	currentTask?: SwarmTask;
	/** Tasks completed by this teammate */
	completedTasks: string[];
	/** Process ID if running as subprocess */
	pid?: number;
	/** Remote A2A task correlation when this teammate runs on a peer */
	a2a?: SwarmA2ATeammateExecution;
	/** Start timestamp */
	startedAt?: number;
	/** Completion timestamp */
	completedAt?: number;
	/** Error message if failed */
	error?: string;
	/** Output/results from the teammate */
	output?: string;
}

/**
 * Configuration for launching a swarm.
 */
export interface SwarmConfig {
	/** Number of teammates to spawn (1-10) */
	teammateCount: number;
	/** Plan file path to implement */
	planFile: string;
	/** Tasks to distribute among teammates */
	tasks: SwarmTask[];
	/** Working directory for all teammates */
	cwd: string;
	/** Session ID of the parent session */
	parentSessionId?: string;
	/** Model to use for teammates (defaults to parent's model) */
	model?: string;
	/** Agent mode used to resolve subagent model dispatch */
	mode?: AgentMode;
	/** Parent model provider used when dispatch falls back to a model tier */
	modelProvider?: ModelProvider;
	/** Default subagent type for teammate tasks without their own type */
	subagentType?: SubagentType;
	/** Default reasoning hint for teammate tasks */
	reasoningEffort?: ReasoningEffort;
	/** Execution transport for teammates; local preserves subprocess behavior. */
	transport?: "local" | "a2a";
	/** Remote A2A routing options for Platform-discovered or registry peers. */
	a2a?: SwarmA2AConfig;
	/** Maximum time per task in milliseconds */
	taskTimeout?: number;
	/** Whether to continue on individual task failures */
	continueOnFailure?: boolean;
	/** Git branch to work on (creates if doesn't exist) */
	gitBranch?: string;
}

/**
 * Configuration for remote A2A-backed swarm teammates.
 */
export interface SwarmA2AConfig {
	/** Named peers from the local A2A registry, used round-robin. */
	peers?: string[];
	/** Override for the local A2A peer registry path. */
	registryPath?: string;
	/** Override for the local A2A task ledger path. */
	tasksPath?: string;
	/** Default remote A2A skill id. */
	skillId?: string;
	/** Optional delegation role shown in task ledger metadata. */
	role?: string;
	/** Discover remote peers from Platform Agent Registry instead of local peers. */
	discover?: boolean;
	/** Platform workspace id for discovery. */
	workspaceId?: string;
	/** Capability filter for Platform discovery. */
	capability?: string;
	/** Surface filter for Platform discovery. Defaults to a2a. */
	surface?: string;
	/** Prefer internal endpoints returned by Platform Agent Registry. */
	preferInternalEndpoint?: boolean;
	/** Maximum Platform candidates to consider. */
	limit?: number;
	/** Timeout for individual A2A HTTP calls. */
	timeoutMs?: number;
	/** Max attempts for individual A2A HTTP calls. */
	maxAttempts?: number;
	/** Max time to wait for a remote task to reach terminal state. */
	maxWaitMs?: number;
	/** Poll interval while waiting for remote task state. */
	pollIntervalMs?: number;
	/** Optional push callback config sent to remote peers for task progress/artifact updates. */
	pushNotificationConfig?: A2ATaskPushNotificationConfig;
}

/**
 * Public, non-secret correlation metadata for a remote A2A swarm teammate.
 */
export interface SwarmA2ATeammateExecution {
	/** Peer selected for this teammate task. */
	peer: string;
	/** Optional human-readable peer label. */
	peerDisplayName?: string;
	/** Peer source used by the router. */
	source: "registry" | "platform-agent-registry";
	/** A2A task id returned by the peer. */
	taskId: string;
	/** A2A context id used for resume/reply. */
	contextId?: string;
	/** A2A message id sent by the coordinator. */
	messageId: string;
	/** A2A skill id used for remote routing. */
	skillId?: string;
	/** Delegation role recorded for the remote task. */
	role?: string;
}

/**
 * Status of the overall swarm execution.
 */
export type SwarmStatus =
	| "initializing"
	| "running"
	| "completing"
	| "completed"
	| "failed"
	| "cancelled";

/**
 * State of the swarm execution.
 */
export interface SwarmState {
	/** Unique swarm execution ID */
	id: string;
	/** Current status */
	status: SwarmStatus;
	/** Configuration used to launch */
	config: SwarmConfig;
	/** All teammates in the swarm */
	teammates: SwarmTeammate[];
	/** Tasks pending assignment */
	pendingTasks: SwarmTask[];
	/** Tasks currently being worked on */
	activeTasks: Map<string, string>; // taskId -> teammateId
	/** Completed task IDs */
	completedTasks: Set<string>;
	/** Failed task IDs */
	failedTasks: Set<string>;
	/** Start timestamp */
	startedAt: number;
	/** Completion timestamp */
	completedAt?: number;
	/** Error message if swarm failed */
	error?: string;
}

/**
 * Event emitted during swarm execution.
 */
export type SwarmEvent =
	| { type: "swarm_start"; swarmId: string; config: SwarmConfig }
	| { type: "teammate_spawn"; swarmId: string; teammate: SwarmTeammate }
	| {
			type: "task_start";
			swarmId: string;
			teammateId: string;
			task: SwarmTask;
	  }
	| {
			type: "task_complete";
			swarmId: string;
			teammateId: string;
			taskId: string;
			output: string;
	  }
	| {
			type: "task_fail";
			swarmId: string;
			teammateId: string;
			taskId: string;
			error: string;
	  }
	| {
			type: "teammate_complete";
			swarmId: string;
			teammate: SwarmTeammate;
	  }
	| { type: "swarm_complete"; swarmId: string; state: SwarmState }
	| { type: "swarm_fail"; swarmId: string; error: string };

/**
 * Callback for swarm events.
 */
export type SwarmEventHandler = (event: SwarmEvent) => void;

/**
 * Result of parsing a plan file into tasks.
 */
export interface ParsedPlan {
	/** Plan title/name */
	title: string;
	/** Extracted tasks */
	tasks: SwarmTask[];
	/** Raw plan content */
	content: string;
}
