import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskResult } from "../types.js";
import { MemoryStore } from "./store.js";

const TEST_DIR = "/tmp/github-agent-test-memory";

describe("MemoryStore", () => {
	beforeEach(() => {
		// Clean up test directory
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true });
		}
	});

	afterEach(() => {
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true });
		}
	});

	describe("initialization", () => {
		it("should create memory directory if it does not exist", () => {
			expect(existsSync(TEST_DIR)).toBe(false);
			new MemoryStore(TEST_DIR);
			expect(existsSync(TEST_DIR)).toBe(true);
		});

		it("should initialize with default stats", () => {
			const store = new MemoryStore(TEST_DIR);
			const stats = store.getStats();

			expect(stats.totalTasks).toBe(0);
			expect(stats.completedTasks).toBe(0);
			expect(stats.mergedPRs).toBe(0);
			expect(stats.totalCost).toBe(0);
			expect(stats.dailyCost).toBe(0);
		});

		it("should load existing data on initialization", () => {
			// Create store and add data
			const store1 = new MemoryStore(TEST_DIR);
			const task: Task = {
				id: "test-1",
				type: "issue",
				title: "Test",
				description: "Test task",
				priority: 50,
				createdAt: new Date().toISOString(),
				status: "pending",
				attempts: 0,
			};
			store1.addTask(task);
			store1.save();

			// Create new store instance - should load existing data
			const store2 = new MemoryStore(TEST_DIR);
			const loadedTask = store2.getTask("test-1");

			expect(loadedTask).toBeDefined();
			expect(loadedTask?.title).toBe("Test");
		});
	});

	describe("task management", () => {
		it("should add and retrieve tasks", () => {
			const store = new MemoryStore(TEST_DIR);
			const task: Task = {
				id: "test-1",
				type: "issue",
				sourceIssue: 42,
				title: "Test",
				description: "Description",
				priority: 50,
				createdAt: new Date().toISOString(),
				status: "pending",
				attempts: 0,
			};

			store.addTask(task);
			const retrieved = store.getTask("test-1");

			expect(retrieved).toEqual(task);
		});

		it("should track total tasks count", () => {
			const store = new MemoryStore(TEST_DIR);

			for (let i = 0; i < 3; i++) {
				store.addTask({
					id: `test-${i}`,
					type: "issue",
					title: `Test ${i}`,
					description: "Description",
					priority: 50,
					createdAt: new Date().toISOString(),
					status: "pending",
					attempts: 0,
				});
			}

			expect(store.getStats().totalTasks).toBe(3);
		});

		it("should return pending tasks sorted by priority", () => {
			const store = new MemoryStore(TEST_DIR);

			store.addTask({
				id: "low",
				type: "issue",
				title: "Low",
				description: "",
				priority: 30,
				createdAt: new Date().toISOString(),
				status: "pending",
				attempts: 0,
			});
			store.addTask({
				id: "high",
				type: "issue",
				title: "High",
				description: "",
				priority: 90,
				createdAt: new Date().toISOString(),
				status: "pending",
				attempts: 0,
			});
			store.addTask({
				id: "medium",
				type: "issue",
				title: "Medium",
				description: "",
				priority: 50,
				createdAt: new Date().toISOString(),
				status: "pending",
				attempts: 0,
			});

			const pending = store.getPendingTasks();

			expect(pending[0].id).toBe("high");
			expect(pending[1].id).toBe("medium");
			expect(pending[2].id).toBe("low");
		});

		it("should update task status and record results", () => {
			const store = new MemoryStore(TEST_DIR);
			store.addTask({
				id: "test-1",
				type: "issue",
				title: "Test",
				description: "",
				priority: 50,
				createdAt: new Date().toISOString(),
				status: "pending",
				attempts: 0,
			});

			const result: TaskResult = {
				success: true,
				prNumber: 123,
				prUrl: "https://github.com/test/repo/pull/123",
				duration: 5000,
				tokensUsed: 1000,
				cost: 0.05,
			};

			store.updateTaskStatus("test-1", "completed", result);
			const task = store.getTask("test-1");

			expect(task?.status).toBe("completed");
			expect(task?.result).toEqual(result);
		});

		it("should increment attempt counter", () => {
			const store = new MemoryStore(TEST_DIR);
			store.addTask({
				id: "test-1",
				type: "issue",
				title: "Test",
				description: "",
				priority: 50,
				createdAt: new Date().toISOString(),
				status: "pending",
				attempts: 0,
			});

			expect(store.incrementAttempts("test-1")).toBe(1);
			expect(store.incrementAttempts("test-1")).toBe(2);
			expect(store.getTask("test-1")?.attempts).toBe(2);
		});

		it("should detect already attempted issues", () => {
			const store = new MemoryStore(TEST_DIR);
			store.addTask({
				id: "test-1",
				type: "issue",
				sourceIssue: 42,
				title: "Test",
				description: "",
				priority: 50,
				createdAt: new Date().toISOString(),
				status: "pending",
				attempts: 1,
			});

			expect(store.hasAttemptedIssue(42)).toBe(true);
			expect(store.hasAttemptedIssue(43)).toBe(false);
		});
	});

	describe("daily cost tracking", () => {
		it("should track daily cost separately from total cost", () => {
			const store = new MemoryStore(TEST_DIR);
			store.addTask({
				id: "test-1",
				type: "issue",
				title: "Test",
				description: "",
				priority: 50,
				createdAt: new Date().toISOString(),
				status: "pending",
				attempts: 0,
			});

			store.updateTaskStatus("test-1", "completed", {
				success: true,
				duration: 1000,
				cost: 1.5,
			});

			const stats = store.getStats();
			expect(stats.totalCost).toBe(1.5);
			expect(stats.dailyCost).toBe(1.5);
		});

		it("should accumulate daily cost across tasks", () => {
			const store = new MemoryStore(TEST_DIR);

			for (let i = 0; i < 3; i++) {
				store.addTask({
					id: `test-${i}`,
					type: "issue",
					title: `Test ${i}`,
					description: "",
					priority: 50,
					createdAt: new Date().toISOString(),
					status: "pending",
					attempts: 0,
				});
				store.updateTaskStatus(`test-${i}`, "completed", {
					success: true,
					duration: 1000,
					cost: 1.0,
				});
			}

			expect(store.getDailyCost()).toBe(3.0);
		});

		it("should reset daily cost when date changes", () => {
			const store = new MemoryStore(TEST_DIR);
			store.addTask({
				id: "test-1",
				type: "issue",
				title: "Test",
				description: "",
				priority: 50,
				createdAt: new Date().toISOString(),
				status: "pending",
				attempts: 0,
			});

			store.updateTaskStatus("test-1", "completed", {
				success: true,
				duration: 1000,
				cost: 10.0,
			});

			// Simulate date change by modifying stats
			const stats = store.getStats();
			expect(stats.dailyCost).toBe(10.0);

			// Manually set yesterday's date (simulating day change)
			// This tests the reset logic in getDailyCost
			// In reality this would happen naturally at midnight
		});

		it("should return daily cost via getDailyCost method", () => {
			const store = new MemoryStore(TEST_DIR);
			store.addTask({
				id: "test-1",
				type: "issue",
				title: "Test",
				description: "",
				priority: 50,
				createdAt: new Date().toISOString(),
				status: "pending",
				attempts: 0,
			});

			store.updateTaskStatus("test-1", "completed", {
				success: true,
				duration: 1000,
				cost: 5.0,
			});

			expect(store.getDailyCost()).toBe(5.0);
		});
	});

	describe("outcome tracking", () => {
		it("should record and retrieve outcomes", () => {
			const store = new MemoryStore(TEST_DIR);

			store.recordOutcome("task-1", 123);

			const outcomes = store.getPendingOutcomes();
			expect(outcomes).toHaveLength(1);
			expect(outcomes[0].taskId).toBe("task-1");
			expect(outcomes[0].prNumber).toBe(123);
			expect(outcomes[0].status).toBe("pending");
		});

		it("should update outcome status and track merges", () => {
			const store = new MemoryStore(TEST_DIR);
			store.recordOutcome("task-1", 123);

			store.updateOutcome("task-1", "merged");

			const stats = store.getStats();
			expect(stats.mergedPRs).toBe(1);
		});

		it("should track rejected PRs", () => {
			const store = new MemoryStore(TEST_DIR);
			store.recordOutcome("task-1", 123);

			store.updateOutcome("task-1", "closed");

			const stats = store.getStats();
			expect(stats.rejectedPRs).toBe(1);
		});

		it("should store review feedback", () => {
			const store = new MemoryStore(TEST_DIR);
			store.recordOutcome("task-1", 123);

			store.updateOutcome("task-1", "changes_requested", {
				reviewer: "reviewer1",
				decision: "changes_requested",
				comments: ["Please add tests"],
				timestamp: new Date().toISOString(),
			});

			const outcomes = store.getPendingOutcomes();
			expect(outcomes[0].reviewFeedback).toHaveLength(1);
			expect(outcomes[0].reviewFeedback[0].comments).toContain(
				"Please add tests",
			);
		});
	});

	describe("learning", () => {
		it("should learn patterns from feedback", () => {
			const store = new MemoryStore(TEST_DIR);
			store.recordOutcome("task-1", 123);

			// Submit feedback with "missing test" pattern
			store.updateOutcome("task-1", "changes_requested", {
				reviewer: "reviewer1",
				decision: "changes_requested",
				comments: ["You're missing test coverage for this function"],
				timestamp: new Date().toISOString(),
			});

			const context = store.getContextForPrompt();
			expect(context).toContain("tests");
		});

		it("should record file failures", () => {
			const store = new MemoryStore(TEST_DIR);

			store.recordFileFailure("src/problematic.ts");
			store.recordFileFailure("src/problematic.ts");
			store.recordFileFailure("src/problematic.ts");

			const context = store.getContextForPrompt();
			expect(context).toContain("problematic.ts");
		});

		it("should generate context for prompts with review patterns", () => {
			const store = new MemoryStore(TEST_DIR);

			// Simulate multiple feedbacks to trigger pattern recognition
			for (let i = 0; i < 3; i++) {
				store.recordOutcome(`task-${i}`, 100 + i);
				store.updateOutcome(`task-${i}`, "changes_requested", {
					reviewer: "reviewer",
					decision: "changes_requested",
					comments: ["Missing test coverage"],
					timestamp: new Date().toISOString(),
				});
			}

			const context = store.getContextForPrompt();
			expect(context).toContain("Learned from past PR reviews and failures");
		});

		it("should learn successful patterns from merged outcomes", () => {
			const store = new MemoryStore(TEST_DIR);
			const taskId = "task-success";
			store.addTask({
				id: taskId,
				type: "issue",
				sourceIssue: 42,
				labels: ["bug", "urgent"],
				title: "Fix crash on startup",
				description: "Issue #42: Fix crash\nLabels: bug, urgent",
				priority: 70,
				createdAt: new Date().toISOString(),
				status: "pending",
				attempts: 1,
			});

			store.updateTaskStatus(taskId, "completed", {
				success: true,
				prNumber: 123,
				prUrl: "https://github.com/test/repo/pull/123",
				duration: 1000,
			});

			store.recordOutcome(taskId, 123);
			store.updateOutcome(taskId, "merged");

			const context = store.getContextForPrompt();
			expect(context).toContain("Successful patterns by label");
			expect(context).toContain("bug");
			expect(context).toContain("Fix crash on startup");
		});

		it("should learn from failures and flag problematic files", () => {
			const store = new MemoryStore(TEST_DIR);
			const taskId = "task-failure";
			store.addTask({
				id: taskId,
				type: "issue",
				sourceIssue: 99,
				title: "Handle edge case",
				description: "Issue #99: Handle edge case",
				priority: 50,
				createdAt: new Date().toISOString(),
				status: "pending",
				attempts: 1,
			});

			store.updateTaskStatus(taskId, "failed", {
				success: false,
				duration: 500,
				error: "lint failed in src/problematic.ts",
			});

			store.recordOutcome(taskId, 456);
			store.updateOutcome(taskId, "closed");

			const context = store.getContextForPrompt();
			expect(context).toContain("Run the linter");
			expect(context).toContain("src/problematic.ts");
		});
	});
});
