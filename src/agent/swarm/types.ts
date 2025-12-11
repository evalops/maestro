/**
 * Swarm Mode Types
 *
 * Type definitions for the swarm execution system that enables
 * parallel agent execution for implementing plans.
 */

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
	/** Maximum time per task in milliseconds */
	taskTimeout?: number;
	/** Whether to continue on individual task failures */
	continueOnFailure?: boolean;
	/** Git branch to work on (creates if doesn't exist) */
	gitBranch?: string;
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
