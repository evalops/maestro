import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	BACKGROUND_TASKS_COMPACTION_CUSTOM_TYPE,
	HEADLESS_CLIENT_REQUESTS_COMPACTION_CUSTOM_TYPE,
	MCP_SERVERS_COMPACTION_CUSTOM_TYPE,
	PLAN_FILE_COMPACTION_CUSTOM_TYPE,
	PLAN_MODE_COMPACTION_CUSTOM_TYPE,
	collectBackgroundTaskMessagesForCompaction,
	collectHeadlessRequestMessagesForCompaction,
	collectMcpMessagesForCompaction,
	collectPlanMessagesForCompaction,
} from "../../src/agent/compaction-restoration.js";
import {
	getPlanFilePathForCompactionRestore,
	isPlanModeActive,
	readPlanFileForCompactionRestore,
} from "../../src/agent/plan-mode.js";
import { backgroundTaskManager } from "../../src/tools/background-tasks.js";

vi.mock("../../src/agent/plan-mode.js", () => ({
	getPlanFilePathForCompactionRestore: vi.fn(),
	isPlanModeActive: vi.fn(),
	readPlanFileForCompactionRestore: vi.fn(),
}));

vi.mock("../../src/tools/background-tasks.js", () => ({
	backgroundTaskManager: {
		getTasks: vi.fn(),
	},
}));

describe("collectPlanMessagesForCompaction", () => {
	beforeEach(() => {
		vi.mocked(isPlanModeActive).mockReset().mockReturnValue(false);
		vi.mocked(getPlanFilePathForCompactionRestore)
			.mockReset()
			.mockReturnValue(null);
		vi.mocked(readPlanFileForCompactionRestore)
			.mockReset()
			.mockReturnValue(null);
		vi.mocked(backgroundTaskManager.getTasks).mockReset().mockReturnValue([]);
	});

	it("returns no messages when no tracked plan file exists", () => {
		expect(collectPlanMessagesForCompaction([])).toEqual([]);
	});

	it("returns hidden plan file and plan-mode restoration messages when plan mode is active", () => {
		vi.mocked(isPlanModeActive).mockReturnValue(true);
		vi.mocked(getPlanFilePathForCompactionRestore).mockReturnValue(
			"/tmp/plan.md",
		);
		vi.mocked(readPlanFileForCompactionRestore).mockReturnValue(
			"# Current plan\n- [ ] Ship it",
		);

		expect(collectPlanMessagesForCompaction([])).toEqual([
			expect.objectContaining({
				role: "hookMessage",
				customType: PLAN_FILE_COMPACTION_CUSTOM_TYPE,
				display: false,
				content: expect.stringContaining("Current plan contents:"),
				details: { filePath: "/tmp/plan.md" },
			}),
			expect.objectContaining({
				role: "hookMessage",
				customType: PLAN_MODE_COMPACTION_CUSTOM_TYPE,
				display: false,
				content: expect.stringContaining("Plan file: /tmp/plan.md"),
				details: { filePath: "/tmp/plan.md" },
			}),
		]);
	});

	it("still restores plan mode when the active plan file cannot be read", () => {
		vi.mocked(isPlanModeActive).mockReturnValue(true);
		vi.mocked(getPlanFilePathForCompactionRestore).mockReturnValue(
			"/tmp/plan.md",
		);
		vi.mocked(readPlanFileForCompactionRestore).mockReturnValue(null);

		expect(collectPlanMessagesForCompaction([])).toEqual([
			expect.objectContaining({
				role: "hookMessage",
				customType: PLAN_MODE_COMPACTION_CUSTOM_TYPE,
			}),
		]);
	});

	it("restores the tracked plan file after compaction even when plan mode is inactive", () => {
		vi.mocked(getPlanFilePathForCompactionRestore).mockReturnValue(
			"/tmp/plan.md",
		);
		vi.mocked(readPlanFileForCompactionRestore).mockReturnValue(
			"# Current plan\n- [ ] Ship it",
		);

		expect(collectPlanMessagesForCompaction([])).toEqual([
			expect.objectContaining({
				role: "hookMessage",
				customType: PLAN_FILE_COMPACTION_CUSTOM_TYPE,
				display: false,
				details: { filePath: "/tmp/plan.md" },
			}),
		]);
	});

	it("deduplicates already-present plan restoration messages", () => {
		vi.mocked(isPlanModeActive).mockReturnValue(true);
		vi.mocked(getPlanFilePathForCompactionRestore).mockReturnValue(
			"/tmp/plan.md",
		);
		vi.mocked(readPlanFileForCompactionRestore).mockReturnValue(
			"# Current plan\n- [ ] Ship it",
		);

		const existingPlanContent = [
			"# Active plan file restored after compaction",
			"",
			"Plan file: /tmp/plan.md",
			"",
			"Current plan contents:",
			"# Current plan\n- [ ] Ship it",
		].join("\n");
		const existingMessages = [
			{
				role: "hookMessage" as const,
				customType: PLAN_FILE_COMPACTION_CUSTOM_TYPE,
				content: existingPlanContent,
				display: false,
				details: { filePath: "/tmp/plan.md" },
				timestamp: Date.now(),
			},
			{
				role: "hookMessage" as const,
				customType: PLAN_MODE_COMPACTION_CUSTOM_TYPE,
				content: "Plan file: /tmp/plan.md",
				display: false,
				details: { filePath: "/tmp/plan.md" },
				timestamp: Date.now(),
			},
		];

		expect(collectPlanMessagesForCompaction(existingMessages)).toEqual([]);
	});
});

describe("collectBackgroundTaskMessagesForCompaction", () => {
	it("returns no messages when no background tasks are active", () => {
		expect(collectBackgroundTaskMessagesForCompaction([])).toEqual([]);
	});

	it("returns a hidden restoration message for running background tasks", () => {
		vi.mocked(backgroundTaskManager.getTasks).mockReturnValue([
			{
				id: "task-running",
				command: "npm run dev -- --token sk-super-secret-value",
				cwd: "/tmp/app",
				startedAt: 20,
				status: "running",
				shellMode: "exec",
			},
			{
				id: "task-restarting",
				command: "bun run watch",
				cwd: "/tmp/app",
				startedAt: 10,
				status: "restarting",
				shellMode: "shell",
			},
			{
				id: "task-stopped",
				command: "npm run lint",
				cwd: "/tmp/app",
				startedAt: 5,
				status: "stopped",
				shellMode: "exec",
			},
		] as never);

		expect(collectBackgroundTaskMessagesForCompaction([])).toEqual([
			expect.objectContaining({
				role: "hookMessage",
				customType: BACKGROUND_TASKS_COMPACTION_CUSTOM_TYPE,
				display: false,
				content: expect.stringContaining(
					"# Background tasks restored after compaction",
				),
			}),
		]);

		const content = String(
			collectBackgroundTaskMessagesForCompaction([])[0]?.content,
		);
		expect(content).toContain("id=task-running; status=running");
		expect(content).toContain("id=task-restarting; status=restarting");
		expect(content).not.toContain("task-stopped");
		expect(content).toContain("command=npm run dev -- --token [secret]");
		expect(content).toContain("background_tasks` action=list");
	});

	it("deduplicates already-present background task restoration messages", () => {
		vi.mocked(backgroundTaskManager.getTasks).mockReturnValue([
			{
				id: "task-running",
				command: "npm run dev",
				cwd: "/tmp/app",
				startedAt: 20,
				status: "running",
				shellMode: "exec",
			},
		] as never);

		const existingMessages = collectBackgroundTaskMessagesForCompaction([]);
		expect(
			collectBackgroundTaskMessagesForCompaction(existingMessages),
		).toEqual([]);
	});
});

describe("collectMcpMessagesForCompaction", () => {
	it("returns no messages when no MCP servers are connected", () => {
		expect(
			collectMcpMessagesForCompaction(
				[],
				[
					{
						name: "context7",
						connected: false,
						transport: "stdio",
						tools: [],
						resources: [],
						prompts: [],
					},
				],
			),
		).toEqual([]);
	});

	it("returns a hidden restoration message for connected MCP servers", () => {
		const servers = [
			{
				name: "github",
				connected: true,
				transport: "http",
				tools: [{ name: "search" }] as never,
				resources: [],
				prompts: ["triage"],
			},
			{
				name: "context7",
				connected: true,
				transport: "stdio",
				tools: [{ name: "resolve" }, { name: "get-docs" }] as never,
				resources: ["lib://react"],
				prompts: [],
			},
			{
				name: "remote",
				connected: false,
				transport: "sse",
				tools: [{ name: "ignored" }] as never,
				resources: ["ignore://me"],
				prompts: ["ignored"],
			},
		];

		expect(collectMcpMessagesForCompaction([], servers)).toEqual([
			expect.objectContaining({
				role: "hookMessage",
				customType: MCP_SERVERS_COMPACTION_CUSTOM_TYPE,
				display: false,
				content: expect.stringContaining(
					"# Connected MCP servers restored after compaction",
				),
			}),
		]);

		const content = String(
			collectMcpMessagesForCompaction([], servers)[0]?.content,
		);
		expect(content).toContain(
			"context7; transport=stdio; tools=2 [get-docs, resolve]; resources=1 [lib://react]; prompts=0",
		);
		expect(content).toContain(
			"github; transport=http; tools=1 [search]; resources=0; prompts=1 [triage]",
		);
		expect(content).not.toContain("remote");
		expect(content).toContain("`list_mcp_servers`");
		expect(content).toContain("`list_mcp_tools`");
		expect(content).toContain("`list_mcp_prompts`");
		expect(content).toContain("`get_mcp_prompt`");
	});

	it("caps restored MCP item listings while keeping counts", () => {
		const servers = [
			{
				name: "big-server",
				connected: true,
				transport: "stdio",
				tools: [
					{ name: "tool-z" },
					{ name: "tool-a" },
					{ name: "tool-c" },
					{ name: "tool-d" },
					{ name: "tool-e" },
					{ name: "tool-f" },
				] as never,
				resources: [
					"res://c",
					"res://a",
					"res://b",
					"res://d",
					"res://e",
					"res://f",
				],
				prompts: [
					"prompt-c",
					"prompt-a",
					"prompt-b",
					"prompt-d",
					"prompt-e",
					"prompt-f",
				],
			},
		];

		const content = String(
			collectMcpMessagesForCompaction([], servers)[0]?.content,
		);
		expect(content).toContain(
			"tools=6 [tool-a, tool-c, tool-d, tool-e, tool-f (+1 more)]",
		);
		expect(content).toContain(
			"resources=6 [res://a, res://b, res://c, res://d, res://e (+1 more)]",
		);
		expect(content).toContain(
			"prompts=6 [prompt-a, prompt-b, prompt-c, prompt-d, prompt-e (+1 more)]",
		);
		expect(content).not.toContain("tool-z,");
		expect(content).not.toContain("res://f,");
		expect(content).not.toContain("prompt-f,");
	});

	it("deduplicates already-present MCP restoration messages", () => {
		const servers = [
			{
				name: "context7",
				connected: true,
				transport: "stdio",
				tools: [{ name: "resolve" }] as never,
				resources: [],
				prompts: [],
			},
		];

		const existingMessages = collectMcpMessagesForCompaction([], servers);
		expect(collectMcpMessagesForCompaction(existingMessages, servers)).toEqual(
			[],
		);
	});
});

describe("collectHeadlessRequestMessagesForCompaction", () => {
	it("returns no messages when no runtime requests are pending", () => {
		expect(
			collectHeadlessRequestMessagesForCompaction([], {
				pendingApprovals: [],
				pendingClientTools: [],
				pendingUserInputs: [],
				pendingToolRetries: [],
			}),
		).toEqual([]);
	});

	it("returns a hidden restoration message for pending headless runtime requests", () => {
		const restored = collectHeadlessRequestMessagesForCompaction([], {
			pendingApprovals: [
				{
					call_id: "call_bash",
					tool: "bash",
					args: { command: "git push --force" },
					action_description: "Force push requires approval",
				},
			],
			pendingClientTools: [
				{
					call_id: "call_client",
					tool: "artifacts",
					args: {
						command: "create",
						filename: "report.txt",
						token: "sk-secret-value",
					},
				},
			],
			pendingUserInputs: [
				{
					call_id: "call_user_input",
					request_id: "req_user_input",
					tool: "ask_user",
					args: {
						questions: [
							{
								header: "Stack",
								question: "Which schema library should we use?",
							},
							{
								header: "Tests",
								question: "Do we need integration coverage?",
							},
						],
					},
				},
			],
			pendingToolRetries: [
				{
					call_id: "call_retry",
					request_id: "retry_1",
					tool: "bash",
					args: {
						tool_call_id: "call_retry",
						args: { command: "ls" },
						error_message: "Command failed",
						attempt: 1,
						summary: "Retry bash command",
					},
				},
			],
		});

		expect(restored).toEqual([
			expect.objectContaining({
				role: "hookMessage",
				customType: HEADLESS_CLIENT_REQUESTS_COMPACTION_CUSTOM_TYPE,
				display: false,
				content: expect.stringContaining(
					"# Pending headless runtime requests restored after compaction",
				),
			}),
		]);

		const content = String(restored[0]?.content);
		expect(content).toContain(
			'type=approval; tool=bash; call_id=call_bash; action=Force push requires approval; args={"command":"git push --force"}',
		);
		expect(content).toContain(
			"type=client_tool; tool=artifacts; call_id=call_client",
		);
		expect(content).toContain(
			'args={"command":"create","filename":"report.txt","token":"[secret]"}',
		);
		expect(content).toContain(
			"type=user_input; tool=ask_user; call_id=call_user_input; request_id=req_user_input; questions=2 [Stack, Tests]",
		);
		expect(content).toContain(
			'type=tool_retry; tool=bash; call_id=call_retry; request_id=retry_1; attempt=1; summary=Retry bash command; error=Command failed; args={"command":"ls"}',
		);
		expect(content).toContain(
			"Reuse the existing approval, client-tool, `ask_user`, or tool-retry flow",
		);
	});

	it("does not double-prefix nested tool retry args in the summary output", () => {
		const restored = collectHeadlessRequestMessagesForCompaction([], {
			pendingApprovals: [],
			pendingClientTools: [],
			pendingUserInputs: [],
			pendingToolRetries: [
				{
					call_id: "call_retry",
					tool: "bash",
					args: {
						args: { command: "ls" },
					},
				},
			],
		});

		const content = String(restored[0]?.content);
		expect(content).toContain(
			'type=tool_retry; tool=bash; call_id=call_retry; args={"command":"ls"}',
		);
		expect(content).not.toContain("args=args=");
	});

	it("deduplicates already-present headless runtime request restoration messages", () => {
		const existing = collectHeadlessRequestMessagesForCompaction([], {
			pendingApprovals: [],
			pendingClientTools: [
				{
					call_id: "call_client",
					tool: "artifacts",
					args: { command: "create", filename: "report.txt" },
				},
			],
			pendingUserInputs: [],
			pendingToolRetries: [],
		});

		expect(
			collectHeadlessRequestMessagesForCompaction(existing, {
				pendingApprovals: [],
				pendingClientTools: [
					{
						call_id: "call_client",
						tool: "artifacts",
						args: { command: "create", filename: "report.txt" },
					},
				],
				pendingUserInputs: [],
				pendingToolRetries: [],
			}),
		).toEqual([]);
	});
});
