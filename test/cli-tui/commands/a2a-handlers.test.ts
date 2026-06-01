import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleA2ATuiCommand } from "../../../src/cli-tui/commands/a2a-handlers.js";
import type { CommandExecutionContext } from "../../../src/cli-tui/commands/types.js";
import { buildA2ACockpit } from "../../../src/platform/a2a-cockpit.js";
import { inspectA2AFleet } from "../../../src/platform/a2a-fleet.js";

vi.mock("../../../src/platform/a2a-cockpit.js", () => ({
	buildA2ACockpit: vi.fn(),
}));

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
						workGraph: {
							state: "waiting",
							itemCount: 3,
							activeItemCount: 3,
							childRunCount: 1,
							childRunIds: ["agent_run_child_1"],
							toolCallCount: 2,
							pendingToolCallCount: 1,
							toolExecutionIds: ["tool_exec_1"],
							waitItemCount: 1,
							waitIds: ["thread_child_1"],
							codexSubagents: {
								edgeCount: 1,
								edges: [
									{
										spawnToolCallId: "toolu_spawn_child",
										childRunId: "agent_run_child_1",
										operation: "spawn_agent",
										status: "running",
									},
								],
								childRunIds: ["agent_run_child_1"],
								toolCallIds: ["toolu_spawn_child"],
								threadIds: ["thread_child_1"],
							},
							correlationPath:
								"platform_agent_run_id=run_1 active_work_items=3 blocked_work_items=0 child_runs=1",
						},
						createdAt: "2026-05-16T00:00:00.000Z",
						updatedAt: "2026-05-16T00:00:00.000Z",
					},
				],
			}),
		);
		vi.stubEnv("MAESTRO_A2A_TASKS_FILE", tasksPath);
		const content: string[] = [];
		const context = createContext("tasks --work-graph");

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
		expect(content.join("\n")).toContain("Work graph: waiting");
		expect(content.join("\n")).toContain("Codex subagents: edges 1");
		expect(content.join("\n")).toContain(
			"lifecycle spawn_agent:running(agent_run_child_1)",
		);
		expect(content.join("\n")).toContain(
			"Correlation: platform_agent_run_id=run_1 active_work_items=3 blocked_work_items=0 child_runs=1",
		);
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

	it("renders the A2A cockpit with next actions", async () => {
		vi.mocked(buildA2ACockpit).mockResolvedValueOnce({
			generatedAt: "2026-05-16T00:00:00.000Z",
			registryPath: "/tmp/peers.json",
			tasksPath: "/tmp/tasks.json",
			counts: {
				peers: 1,
				onlinePeers: 1,
				unreachablePeers: 0,
				tasks: 1,
				runningTasks: 0,
				actionRequiredTasks: 1,
				failedTasks: 0,
				completedTasks: 0,
			},
			peers: [
				{
					name: "mac-mini",
					url: "http://127.0.0.1:4111",
					status: "online",
					taskCounts: {
						tasks: 1,
						runningTasks: 0,
						actionRequiredTasks: 1,
						failedTasks: 0,
						completedTasks: 0,
					},
					lastTask: {
						id: "task-1",
						state: "TASK_STATE_INPUT_REQUIRED",
						status: "waiting",
						updatedAt: "2026-05-16T00:00:00.000Z",
						text: "Need test approval",
					},
				},
			],
			tasks: [
				{
					ledgerId: "ledger-1",
					peer: "mac-mini",
					taskId: "task-1",
					state: "TASK_STATE_INPUT_REQUIRED",
					status: "waiting",
					requiresInput: true,
					terminal: true,
					final: false,
					text: "Need test approval",
					updatedAt: "2026-05-16T00:00:00.000Z",
					nextCommand:
						"maestro a2a reply mac-mini task-1 <response> --wait --work-graph",
				},
			],
			nextActions: [
				{
					id: "reply:mac-mini:task-1",
					label: "Reply to mac-mini task task-1",
					command:
						"maestro a2a reply mac-mini task-1 <response> --wait --work-graph",
					severity: "critical",
					peer: "mac-mini",
					taskId: "task-1",
					reason: "Peer needs input.",
				},
			],
		});
		const content: string[] = [];
		const context = createContext(
			"cockpit --registry /tmp/peers.json --tasks /tmp/tasks.json --timeout-ms 2500 --peer mac-mini --limit 5",
		);

		await handleA2ATuiCommand(context, {
			addContent(text) {
				content.push(text);
			},
			requestRender: vi.fn(),
		});

		expect(buildA2ACockpit).toHaveBeenCalledWith({
			registryPath: "/tmp/peers.json",
			tasksPath: "/tmp/tasks.json",
			timeoutMs: 2500,
			peer: "mac-mini",
			limit: 5,
		});
		expect(content.join("\n")).toContain("A2A cockpit");
		expect(content.join("\n")).toContain("1/1 peers online");
		expect(content.join("\n")).toContain("waiting mac-mini task-1");
		expect(content.join("\n")).toContain("Next actions");
		expect(content.join("\n")).toContain("maestro a2a reply mac-mini task-1");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("renders coordinate as a TUI-aware CLI placeholder", async () => {
		const context = createContext(
			"coordinate mac-mini --reply use the short smoke",
		);

		await handleA2ATuiCommand(context, {
			addContent: vi.fn(),
			requestRender: vi.fn(),
		});

		expect(context.showInfo).toHaveBeenCalledWith(
			expect.stringContaining("maestro a2a coordinate [peer] --refresh"),
		);
		expect(context.showInfo).toHaveBeenCalledWith(
			expect.stringContaining("--reply <text>"),
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
