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
import {
	buildEvalOpsDelegationEnvironment,
	issueEvalOpsDelegationToken,
} from "../../oauth/index.js";
import { createLogger } from "../../utils/logger.js";
import type {
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
	};
}

function cloneConfig(config: SwarmConfig): SwarmConfig {
	return {
		...config,
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

/**
 * SwarmExecutor manages a swarm of parallel agent instances.
 */
export class SwarmExecutor {
	private state: SwarmState;
	private processes: Map<string, ChildProcess> = new Map();
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
				const allDepsCompleted = task.dependsOn.every(
					(depId) =>
						this.state.completedTasks.has(depId) ||
						this.state.failedTasks.has(depId),
				);
				if (!allDepsCompleted) continue;
			}
			return task;
		}
		return null;
	}

	/**
	 * Spawn a subprocess agent for a teammate.
	 */
	private async buildTeammateEnv(
		teammate: SwarmTeammate,
		task: SwarmTask,
	): Promise<Record<string, string>> {
		const baseEnv: Record<string, string> = {
			...process.env,
			MAESTRO_SWARM_MODE: "1",
			MAESTRO_SWARM_ID: this.state.id,
			MAESTRO_TEAMMATE_ID: teammate.id,
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

	private async spawnTeammate(
		teammate: SwarmTeammate,
		task: SwarmTask,
	): Promise<void> {
		const tmpFile = join(
			tmpdir(),
			`${this.state.id}-${toSafeTaskTempBasename(task.id)}`,
		);

		// Build prompt for the teammate
		let prompt = `# Swarm Task: ${task.id}\n\n`;
		prompt += `You are teammate "${teammate.name}" in a swarm working on a plan.\n\n`;
		prompt += `## Your Task\n\n${task.prompt}\n\n`;
		if (task.files && task.files.length > 0) {
			prompt += `## Relevant Files\n\n${task.files.map((f) => `- ${f}`).join("\n")}\n\n`;
		}
		prompt += "## Instructions\n\n";
		prompt += "1. Focus ONLY on your assigned task\n";
		prompt += "2. Make changes directly - do not ask for confirmation\n";
		prompt += "3. Report completion by summarizing what you did\n";

		writeFileSync(tmpFile, prompt);

		const args = [
			"--no-session",
			...(task.model
				? ["--model", task.model]
				: this.state.config.model
					? ["--model", this.state.config.model]
					: []),
			"exec",
			tmpFile,
		];
		const env = await this.buildTeammateEnv(teammate, task);

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
