import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleA2ATuiCommand } from "../../../src/cli-tui/commands/a2a-handlers.js";
import type { CommandExecutionContext } from "../../../src/cli-tui/commands/types.js";

describe("A2A TUI command handler", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("renders the durable A2A task ledger", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-tui-"));
		const tasksPath = join(dir, "tasks.json");
		await writeFile(
			tasksPath,
			JSON.stringify({
				tasks: [
					{
						id: "maestro-a2a-local-task-1",
						peer: "dev-desktop",
						taskId: "task-dev-1",
						text: "run full workspace checks",
						state: "TASK_STATE_WORKING",
						createdAt: "2026-05-16T00:00:00.000Z",
						updatedAt: "2026-05-16T00:00:00.000Z",
					},
				],
			}),
		);
		vi.stubEnv("MAESTRO_A2A_TASKS_FILE", tasksPath);
		const content: string[] = [];
		const context = createContext("tasks");

		await handleA2ATuiCommand(context, {
			addContent(text) {
				content.push(text);
			},
			requestRender: vi.fn(),
		});

		expect(content.join("\n")).toContain("A2A tasks");
		expect(content.join("\n")).toContain("dev-desktop");
		expect(content.join("\n")).toContain("task-dev-1");
		expect(content.join("\n")).toContain("TASK_STATE_WORKING");
		expect(context.showError).not.toHaveBeenCalled();
	});
});

function createContext(argumentText: string): CommandExecutionContext {
	return {
		command: { name: "a2a", description: "A2A" },
		rawInput: `/a2a ${argumentText}`,
		argumentText,
		showInfo: vi.fn(),
		showError: vi.fn(),
		renderHelp: vi.fn(),
	};
}
