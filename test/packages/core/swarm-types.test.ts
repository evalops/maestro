/**
 * TDD tests for swarm type contracts — verify the type system
 * enforces correct shapes for task scheduling and execution.
 */
import { describe, expect, it } from "vitest";

import type {
	ParsedPlan,
	SwarmConfig,
	SwarmEvent,
	SwarmState,
	SwarmStatus,
	SwarmTask,
	SwarmTeammate,
	TeammateStatus,
} from "../../../packages/core/src/swarm/index.js";

import { parsePlanContent } from "../../../packages/core/src/swarm/index.js";

describe("Swarm Types", () => {
	describe("SwarmTask", () => {
		it("requires id and prompt", () => {
			const task: SwarmTask = {
				id: "task-1",
				prompt: "Implement the login page",
			};
			expect(task.id).toBe("task-1");
			expect(task.prompt).toBeTruthy();
		});

		it("supports optional files array", () => {
			const task: SwarmTask = {
				id: "task-2",
				prompt: "Update auth module",
				files: ["src/auth.ts", "src/middleware.ts"],
			};
			expect(task.files).toHaveLength(2);
		});

		it("supports optional dependencies", () => {
			const task: SwarmTask = {
				id: "task-3",
				prompt: "Write tests",
				dependsOn: ["task-1", "task-2"],
			};
			expect(task.dependsOn).toContain("task-1");
		});

		it("supports optional priority", () => {
			const task: SwarmTask = {
				id: "task-4",
				prompt: "Critical fix",
				priority: 10,
			};
			expect(task.priority).toBe(10);
		});
	});

	describe("TeammateStatus", () => {
		it("includes all expected statuses", () => {
			const statuses: TeammateStatus[] = [
				"pending",
				"running",
				"completed",
				"failed",
				"cancelled",
			];
			expect(statuses).toHaveLength(5);
		});
	});

	describe("SwarmStatus", () => {
		it("includes all expected statuses", () => {
			const statuses: SwarmStatus[] = [
				"initializing",
				"running",
				"completing",
				"completed",
				"failed",
				"cancelled",
			];
			expect(statuses).toHaveLength(6);
		});
	});

	describe("SwarmEvent", () => {
		it("supports swarm_start event", () => {
			const event: SwarmEvent = {
				type: "swarm_start",
				swarmId: "swarm-1",
				config: {} as SwarmConfig,
			};
			expect(event.type).toBe("swarm_start");
		});

		it("supports task_complete event", () => {
			const event: SwarmEvent = {
				type: "task_complete",
				swarmId: "swarm-1",
				teammateId: "alpha",
				taskId: "task-1",
				output: "Done",
			};
			expect(event.type).toBe("task_complete");
			expect(event.output).toBe("Done");
		});

		it("supports task_fail event", () => {
			const event: SwarmEvent = {
				type: "task_fail",
				swarmId: "swarm-1",
				teammateId: "beta",
				taskId: "task-2",
				error: "Build failed",
			};
			expect(event.type).toBe("task_fail");
			expect(event.error).toBe("Build failed");
		});

		it("supports swarm_complete event", () => {
			const event: SwarmEvent = {
				type: "swarm_complete",
				swarmId: "swarm-1",
				state: {} as SwarmState,
			};
			expect(event.type).toBe("swarm_complete");
		});
	});

	describe("ParsedPlan integration", () => {
		it("parsed plan tasks satisfy SwarmTask interface", () => {
			const plan: ParsedPlan = parsePlanContent(`# Plan

- [ ] Create the database schema
- [ ] Implement API endpoints
- [ ] Write integration tests
`);
			for (const task of plan.tasks) {
				// Each task should have id and prompt
				expect(task.id).toBeTruthy();
				expect(task.prompt).toBeTruthy();
				// TypeScript ensures these satisfy SwarmTask at compile time
				const _typeCheck: SwarmTask = task;
			}
		});

		it("plan tasks have unique IDs", () => {
			const plan = parsePlanContent(`# Plan

- [ ] Create models
- [ ] Create controllers
- [ ] Create views
- [ ] Create tests
`);
			const ids = plan.tasks.map((t) => t.id);
			const uniqueIds = new Set(ids);
			expect(uniqueIds.size).toBe(ids.length);
		});

		it("tasks can be used to build a SwarmConfig", () => {
			const plan = parsePlanContent(`# Build Feature X

- [ ] Implement backend API
- [ ] Build frontend components
`);
			const config: SwarmConfig = {
				teammateCount: 2,
				planFile: "plan.md",
				tasks: plan.tasks,
				cwd: "/workspace",
			};
			expect(config.tasks.length).toBe(plan.tasks.length);
			expect(config.teammateCount).toBe(2);
		});
	});

	describe("SwarmTeammate", () => {
		it("tracks teammate lifecycle", () => {
			const teammate: SwarmTeammate = {
				id: "teammate-alpha",
				name: "Alpha",
				status: "pending",
				completedTasks: [],
			};
			expect(teammate.status).toBe("pending");

			// Simulate lifecycle
			teammate.status = "running";
			teammate.currentTask = {
				id: "task-1",
				prompt: "Build something",
			};
			expect(teammate.status).toBe("running");

			teammate.status = "completed";
			teammate.completedTasks.push("task-1");
			teammate.completedAt = Date.now();
			expect(teammate.completedTasks).toContain("task-1");
		});

		it("captures errors on failure", () => {
			const teammate: SwarmTeammate = {
				id: "teammate-beta",
				name: "Beta",
				status: "failed",
				completedTasks: [],
				error: "Process exited with code 1",
			};
			expect(teammate.error).toContain("code 1");
		});
	});
});
