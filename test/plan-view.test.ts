import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Container, type TUI } from "../src/tui-lib/index.js";
import { PlanView, loadTodoStore } from "../src/tui/plan-view.js";

describe("PlanView command actions", () => {
	let tempDir: string;
	let filePath: string;
	let container: Container;
	let ui: TUI;
	let showInfo: ReturnType<typeof vi.fn>;
	let setPlanHint: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "plan-view-test-"));
		filePath = join(tempDir, "todos.json");
		container = new Container();
		ui = { requestRender: vi.fn() } as unknown as TUI;
		showInfo = vi.fn();
		setPlanHint = vi.fn();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	const createView = () =>
		new PlanView({
			filePath,
			chatContainer: container,
			ui,
			showInfoMessage: showInfo,
			setPlanHint,
		});

	it("creates a plan via /plan new", () => {
		const view = createView();
		view.handlePlanCommand("/plan new Release Checklist");
		const store = loadTodoStore(filePath);
		expect(store["Release Checklist"]).toBeDefined();
		expect(setPlanHint).toHaveBeenCalledWith("Release Checklist: no tasks yet");
	});

	it("adds a task with explicit priority", () => {
		const initial = {
			"Launch Plan": {
				goal: "Launch Plan",
				items: [],
				updatedAt: new Date().toISOString(),
			},
		};
		writeFileSync(filePath, JSON.stringify(initial, null, 2));
		const view = createView();
		view.handlePlanCommand("/plan add Launch Plan :: Ship docs :: high");
		const store = loadTodoStore(filePath);
		const goal = store["Launch Plan"];
		expect(goal.items).toHaveLength(1);
		expect(goal.items[0].content).toBe("Ship docs");
		expect(goal.items[0].priority).toBe("high");
	});

	it("completes a task by number", () => {
		const initial = {
			"Launch Plan": {
				goal: "Launch Plan",
				items: [
					{ id: "task-1", content: "Ship docs", status: "pending" },
					{ id: "task-2", content: "Cut release", status: "pending" },
				],
				updatedAt: new Date().toISOString(),
			},
		};
		writeFileSync(filePath, JSON.stringify(initial, null, 2));
		const view = createView();
		view.handlePlanCommand("/plan complete Launch Plan :: 2");
		const store = loadTodoStore(filePath);
		const goal = store["Launch Plan"];
		expect(goal.items[1].status).toBe("completed");
	});
});
