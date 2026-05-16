import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleA2ATuiCommand } from "../../../src/cli-tui/commands/a2a-handlers.js";
import type { CommandExecutionContext } from "../../../src/cli-tui/commands/types.js";
import { inspectA2AFleet } from "../../../src/platform/a2a-fleet.js";

vi.mock("../../../src/platform/a2a-fleet.js", () => ({
	inspectA2AFleet: vi.fn(),
}));

describe("A2A TUI command handler", () => {
	afterEach(() => {
		vi.clearAllMocks();
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

	it("forwards fleet timeout flags to the inspector", async () => {
		vi.mocked(inspectA2AFleet).mockResolvedValueOnce({
			generatedAt: "2026-05-16T00:00:00.000Z",
			registryPath: "/tmp/peers.json",
			tasksPath: "/tmp/tasks.json",
			peers: [],
		});
		const content: string[] = [];
		const context = createContext(
			"fleet --registry /tmp/peers.json --tasks /tmp/tasks.json --timeout-ms 2500",
		);

		await handleA2ATuiCommand(context, {
			addContent(text) {
				content.push(text);
			},
			requestRender: vi.fn(),
		});

		expect(inspectA2AFleet).toHaveBeenCalledWith({
			registryPath: "/tmp/peers.json",
			tasksPath: "/tmp/tasks.json",
			timeoutMs: 2500,
		});
		expect(content.join("\n")).toContain("A2A fleet");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("reports reply commands as unavailable", async () => {
		const context = createContext(
			"reply dev-desktop task-123 use the short smoke",
		);

		await handleA2ATuiCommand(context, {
			addContent: vi.fn(),
			requestRender: vi.fn(),
		});

		expect(context.showInfo).toHaveBeenCalledWith(
			"A2A task replies are not available in the TUI or CLI yet.",
		);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("omits reply commands from the fallback help", async () => {
		const content: string[] = [];
		const context = createContext("wat");

		await handleA2ATuiCommand(context, {
			addContent(text) {
				content.push(text);
			},
			requestRender: vi.fn(),
		});

		expect(content.join("\n")).not.toContain(
			"/a2a reply <peer> <task-id> <text>",
		);
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
