/**
 * Integration tests for Scheduler
 *
 * Tests the scheduler end-to-end with real timers and task execution
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../../../packages/slack-agent/src/scheduler.js";

describe("Scheduler Integration", () => {
	let testDir: string;
	let scheduler: Scheduler;
	let executedTasks: Array<{ id: string; description: string; prompt: string }>;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`scheduler-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
		executedTasks = [];
	});

	afterEach(() => {
		scheduler?.stop();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("persists scheduled tasks to disk", async () => {
		scheduler = new Scheduler({
			workingDir: testDir,
			onTaskDue: async (task) => {
				executedTasks.push({
					id: task.id,
					description: task.description,
					prompt: task.prompt,
				});
				return { success: true };
			},
		});

		// Schedule a task
		const task = await scheduler.schedule(
			"C123456",
			"U123456",
			"Test reminder",
			"Say hello",
			"in 1 hour",
		);

		expect(task).not.toBeNull();
		expect(task?.channelId).toBe("C123456");
		expect(task?.description).toBe("Test reminder");

		// Check it was persisted
		const tasksFile = join(testDir, "scheduled_tasks.json");
		expect(existsSync(tasksFile)).toBe(true);

		const savedTasks = JSON.parse(readFileSync(tasksFile, "utf-8"));
		expect(savedTasks).toHaveLength(1);
		expect(savedTasks[0].description).toBe("Test reminder");
	});

	it("loads tasks from disk on startup", async () => {
		// Create first scheduler and add a task
		const scheduler1 = new Scheduler({
			workingDir: testDir,
			onTaskDue: async () => ({ success: true }),
		});

		await scheduler1.schedule(
			"C123456",
			"U123456",
			"Persisted task",
			"Do something",
			"in 2 hours",
		);
		scheduler1.stop();

		// Create second scheduler - should load the task
		const scheduler2 = new Scheduler({
			workingDir: testDir,
			onTaskDue: async () => ({ success: true }),
		});

		const tasks = scheduler2.listTasks("C123456");
		expect(tasks).toHaveLength(1);
		expect(tasks[0].description).toBe("Persisted task");

		scheduler2.stop();
	});

	it("executes due tasks", async () => {
		vi.useFakeTimers();

		scheduler = new Scheduler({
			workingDir: testDir,
			onTaskDue: async (task) => {
				executedTasks.push({
					id: task.id,
					description: task.description,
					prompt: task.prompt,
				});
				return { success: true };
			},
		});

		// Schedule a task for "in 1 minute"
		const now = new Date();
		vi.setSystemTime(now);

		await scheduler.schedule(
			"C123456",
			"U123456",
			"Quick task",
			"Execute immediately",
			"in 1 minute",
		);

		scheduler.start();

		// Fast forward 2 minutes
		await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

		expect(executedTasks).toHaveLength(1);
		expect(executedTasks[0].description).toBe("Quick task");

		vi.useRealTimers();
	});

	it("handles recurring tasks", async () => {
		vi.useFakeTimers();

		scheduler = new Scheduler({
			workingDir: testDir,
			onTaskDue: async (task) => {
				executedTasks.push({
					id: task.id,
					description: task.description,
					prompt: task.prompt,
				});
				return { success: true };
			},
		});

		const now = new Date("2024-01-15T10:00:00Z");
		vi.setSystemTime(now);

		// Schedule a recurring task every hour
		const task = await scheduler.schedule(
			"C123456",
			"U123456",
			"Hourly check",
			"Check status",
			"every hour",
		);

		expect(task).not.toBeNull();
		expect(task?.schedule).toBe("0 * * * *");

		scheduler.start();

		// Fast forward 1.5 hours - should execute once
		await vi.advanceTimersByTimeAsync(90 * 60 * 1000);

		expect(executedTasks.length).toBeGreaterThanOrEqual(1);
		expect(executedTasks[0].description).toBe("Hourly check");

		// Task should still be active (recurring)
		const tasks = scheduler.listTasks("C123456");
		expect(tasks).toHaveLength(1);
		expect(tasks[0].active).toBe(true);

		vi.useRealTimers();
	});

	it("deactivates one-time tasks after execution", async () => {
		vi.useFakeTimers();

		scheduler = new Scheduler({
			workingDir: testDir,
			onTaskDue: async (task) => {
				executedTasks.push({
					id: task.id,
					description: task.description,
					prompt: task.prompt,
				});
				return { success: true };
			},
		});

		const now = new Date();
		vi.setSystemTime(now);

		await scheduler.schedule(
			"C123456",
			"U123456",
			"One-time task",
			"Do once",
			"in 1 minute",
		);

		scheduler.start();

		// Fast forward 2 minutes
		await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

		expect(executedTasks).toHaveLength(1);

		// Task should no longer be in active list
		const tasks = scheduler.listTasks("C123456");
		expect(tasks).toHaveLength(0);

		vi.useRealTimers();
	});

	it("cancels scheduled tasks", async () => {
		scheduler = new Scheduler({
			workingDir: testDir,
			onTaskDue: async () => ({ success: true }),
		});

		const task = await scheduler.schedule(
			"C123456",
			"U123456",
			"To be cancelled",
			"Never runs",
			"in 1 hour",
		);

		expect(scheduler.listTasks("C123456")).toHaveLength(1);
		expect(task).toBeDefined();
		if (!task) throw new Error("Task should be defined");

		const cancelled = await scheduler.cancel(task.id);
		expect(cancelled).toBe(true);

		expect(scheduler.listTasks("C123456")).toHaveLength(0);
	});

	it("handles multiple channels independently", async () => {
		scheduler = new Scheduler({
			workingDir: testDir,
			onTaskDue: async () => ({ success: true }),
		});

		await scheduler.schedule(
			"C111111",
			"U123456",
			"Channel 1 task",
			"Task 1",
			"in 1 hour",
		);

		await scheduler.schedule(
			"C222222",
			"U123456",
			"Channel 2 task",
			"Task 2",
			"in 1 hour",
		);

		await scheduler.schedule(
			"C111111",
			"U123456",
			"Another channel 1 task",
			"Task 3",
			"in 2 hours",
		);

		expect(scheduler.listTasks("C111111")).toHaveLength(2);
		expect(scheduler.listTasks("C222222")).toHaveLength(1);
		expect(scheduler.listTasks("C333333")).toHaveLength(0);
	});

	it("rejects invalid time expressions", async () => {
		scheduler = new Scheduler({
			workingDir: testDir,
			onTaskDue: async () => ({ success: true }),
		});

		const task = await scheduler.schedule(
			"C123456",
			"U123456",
			"Invalid task",
			"Won't work",
			"next blue moon",
		);

		expect(task).toBeNull();
		expect(scheduler.listTasks("C123456")).toHaveLength(0);
	});
});
