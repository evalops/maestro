import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "@evalops/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PlanView,
	type TodoStore,
	loadTodoStore,
	saveTodoStore,
} from "../../src/tui/plan-view.js";

describe("PlanView editor functionality", () => {
	let tempDir: string;
	let planFilePath: string;
	let planView: PlanView;
	let mockOptions: any;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "plan-view-editor-test-"));
		planFilePath = join(tempDir, "plans.json");

		mockOptions = {
			filePath: planFilePath,
			chatContainer: new Container(),
			ui: {
				requestRender: vi.fn(),
			},
			showInfoMessage: vi.fn(),
			setPlanHint: vi.fn(),
			onStoreChanged: vi.fn(),
		};

		planView = new PlanView(mockOptions);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("moves a task up", () => {
		const id1 = randomUUID();
		const id2 = randomUUID();
		const id3 = randomUUID();
		const store: TodoStore = {
			"My Goal": {
				goal: "My Goal",
				items: [
					{ id: id1, content: "Task 1", status: "pending", priority: "medium" },
					{ id: id2, content: "Task 2", status: "pending", priority: "medium" },
					{ id: id3, content: "Task 3", status: "pending", priority: "medium" },
				],
				updatedAt: new Date().toISOString(),
			},
		};
		saveTodoStore(planFilePath, store);

		planView.moveTask("My Goal", id2, "up");

		const updated = loadTodoStore(planFilePath);
		const items = updated["My Goal"].items;
		expect(items[0].id).toBe(id2);
		expect(items[1].id).toBe(id1);
		expect(items[2].id).toBe(id3);
		expect(mockOptions.onStoreChanged).toHaveBeenCalled();
	});

	it("moves a task down", () => {
		const id1 = randomUUID();
		const id2 = randomUUID();
		const id3 = randomUUID();
		const store: TodoStore = {
			"My Goal": {
				goal: "My Goal",
				items: [
					{ id: id1, content: "Task 1", status: "pending", priority: "medium" },
					{ id: id2, content: "Task 2", status: "pending", priority: "medium" },
					{ id: id3, content: "Task 3", status: "pending", priority: "medium" },
				],
				updatedAt: new Date().toISOString(),
			},
		};
		saveTodoStore(planFilePath, store);

		planView.moveTask("My Goal", id2, "down");

		const updated = loadTodoStore(planFilePath);
		const items = updated["My Goal"].items;
		expect(items[0].id).toBe(id1);
		expect(items[1].id).toBe(id3);
		expect(items[2].id).toBe(id2);
		expect(mockOptions.onStoreChanged).toHaveBeenCalled();
	});

	it("does nothing if moving out of bounds", () => {
		const id1 = randomUUID();
		const id2 = randomUUID();
		const store: TodoStore = {
			"My Goal": {
				goal: "My Goal",
				items: [
					{ id: id1, content: "Task 1", status: "pending", priority: "medium" },
					{ id: id2, content: "Task 2", status: "pending", priority: "medium" },
				],
				updatedAt: new Date().toISOString(),
			},
		};
		saveTodoStore(planFilePath, store);

		// Move top task up
		planView.moveTask("My Goal", id1, "up");
		let updated = loadTodoStore(planFilePath);
		expect(updated["My Goal"].items[0].id).toBe(id1);

		// Move bottom task down
		planView.moveTask("My Goal", id2, "down");
		updated = loadTodoStore(planFilePath);
		expect(updated["My Goal"].items[1].id).toBe(id2);
	});
});
