import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "@evalops/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PlanView,
	type PlanViewOptions,
	type TodoStore,
	calculatePlanHint,
	loadTodoStore,
	saveTodoStore,
} from "../../src/cli-tui/plan-view.js";

interface MockPlanViewOptions {
	filePath: string;
	chatContainer: Container;
	ui: { requestRender: ReturnType<typeof vi.fn> };
	showInfoMessage: ReturnType<typeof vi.fn>;
	setPlanHint: ReturnType<typeof vi.fn>;
	onStoreChanged?: ReturnType<typeof vi.fn>;
}

describe("calculatePlanHint", () => {
	it("returns null when no goals exist", () => {
		expect(calculatePlanHint({})).toBeNull();
	});

	it("prefers the most recently updated goal", () => {
		const store: TodoStore = {
			One: {
				goal: "One",
				updatedAt: new Date("2024-01-01").toISOString(),
				items: [
					{
						id: randomUUID(),
						content: "Task",
						status: "pending",
						priority: "medium",
					},
					{
						id: randomUUID(),
						content: "Task",
						status: "completed",
						priority: "medium",
					},
				],
			},
			Two: {
				goal: "Ship CLI",
				updatedAt: new Date("2024-05-01").toISOString(),
				items: [
					{
						id: randomUUID(),
						content: "Task",
						status: "completed",
						priority: "medium",
					},
					{
						id: randomUUID(),
						content: "Task",
						status: "completed",
						priority: "medium",
					},
				],
			},
		};
		const hint = calculatePlanHint(store);
		expect(hint).toBe("Ship CLI: 2/2 done");
	});
});

describe("PlanView clear functionality", () => {
	let tempDir: string;
	let planFilePath: string;
	let planView: PlanView;
	let mockOptions: MockPlanViewOptions;

	beforeEach(() => {
		// Create a temporary directory for test files
		tempDir = mkdtempSync(join(tmpdir(), "plan-view-test-"));
		planFilePath = join(tempDir, "plans.json");

		// Create mock options
		mockOptions = {
			filePath: planFilePath,
			chatContainer: new Container(),
			ui: {
				requestRender: vi.fn(),
			},
			showInfoMessage: vi.fn(),
			setPlanHint: vi.fn(),
		};

		planView = new PlanView(mockOptions as unknown as PlanViewOptions);
	});

	afterEach(() => {
		// Clean up temp directory
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("clears a specific plan by name", () => {
		// Create a store with multiple plans
		const store: TodoStore = {
			"Release Checklist": {
				goal: "Release Checklist",
				items: [
					{
						id: randomUUID(),
						content: "Update docs",
						status: "pending",
						priority: "high",
					},
				],
				updatedAt: new Date().toISOString(),
			},
			"Bug Fixes": {
				goal: "Bug Fixes",
				items: [
					{
						id: randomUUID(),
						content: "Fix memory leak",
						status: "in_progress",
						priority: "high",
					},
				],
				updatedAt: new Date().toISOString(),
			},
		};
		saveTodoStore(planFilePath, store);

		// Execute clear command
		planView.handlePlanCommand("/plan clear Release Checklist");

		// Load and verify
		const updated = loadTodoStore(planFilePath);
		expect(updated["Release Checklist"]).toBeUndefined();
		expect(updated["Bug Fixes"]).toBeDefined();
		expect(mockOptions.showInfoMessage).toHaveBeenCalledWith(
			'Deleted plan "Release Checklist".',
		);
	});

	it("clears all plans when given 'all' argument", () => {
		// Create a store with multiple plans
		const store: TodoStore = {
			"Plan A": {
				goal: "Plan A",
				items: [],
				updatedAt: new Date().toISOString(),
			},
			"Plan B": {
				goal: "Plan B",
				items: [],
				updatedAt: new Date().toISOString(),
			},
			"Plan C": {
				goal: "Plan C",
				items: [],
				updatedAt: new Date().toISOString(),
			},
		};
		saveTodoStore(planFilePath, store);

		// Execute clear all command
		planView.handlePlanCommand("/plan clear all");

		// Load and verify
		const updated = loadTodoStore(planFilePath);
		expect(Object.keys(updated).length).toBe(0);
		expect(mockOptions.showInfoMessage).toHaveBeenCalledWith(
			"Cleared all 3 plan(s).",
		);
		expect(mockOptions.setPlanHint).toHaveBeenCalledWith(null);
	});

	it("handles clearing non-existent plan gracefully", () => {
		// Create empty store
		saveTodoStore(planFilePath, {});

		// Try to clear non-existent plan
		planView.handlePlanCommand("/plan clear NonExistent");

		expect(mockOptions.showInfoMessage).toHaveBeenCalledWith(
			'No plan found matching "NonExistent".',
		);
	});

	it("handles clearing all with no plans", () => {
		// Create empty store
		saveTodoStore(planFilePath, {});

		// Try to clear all
		planView.handlePlanCommand("/plan clear all");

		expect(mockOptions.showInfoMessage).toHaveBeenCalledWith(
			"No plans to clear.",
		);
	});

	it("handles clear command without argument", () => {
		// Execute clear without argument
		planView.handlePlanCommand("/plan clear");

		expect(mockOptions.showInfoMessage).toHaveBeenCalledWith(
			"Provide a goal name or 'all', e.g. /plan clear Release Checklist",
		);
	});

	it("handles case-insensitive 'all' argument", () => {
		const store: TodoStore = {
			"Test Plan": {
				goal: "Test Plan",
				items: [],
				updatedAt: new Date().toISOString(),
			},
		};
		saveTodoStore(planFilePath, store);

		// Test with different cases
		planView.handlePlanCommand("/plan clear ALL");

		const updated = loadTodoStore(planFilePath);
		expect(Object.keys(updated).length).toBe(0);
	});

	it("updates plan hint after clearing specific plan", () => {
		const store: TodoStore = {
			"Plan A": {
				goal: "Plan A",
				items: [
					{
						id: randomUUID(),
						content: "Task 1",
						status: "completed",
						priority: "medium",
					},
				],
				updatedAt: new Date().toISOString(),
			},
			"Plan B": {
				goal: "Plan B",
				items: [
					{
						id: randomUUID(),
						content: "Task 2",
						status: "pending",
						priority: "medium",
					},
				],
				updatedAt: new Date().toISOString(),
			},
		};
		saveTodoStore(planFilePath, store);

		planView.handlePlanCommand("/plan clear Plan A");

		// Verify plan hint was updated (not null since Plan B remains)
		expect(mockOptions.setPlanHint).toHaveBeenCalled();
		const hintCall = mockOptions.setPlanHint.mock.calls[0][0];
		expect(hintCall).toContain("Plan B");
	});
});
