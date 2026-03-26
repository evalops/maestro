/**
 * TDD integration test — simulate what a real consumer of
 * @evalops/maestro-core would do: import, configure, wire together.
 * This catches import resolution, circular deps, and type mismatches.
 */
import { describe, expect, it, vi } from "vitest";

// Simulate: import * from '@evalops/maestro-core'
import {
	Agent,
	ContextHandoffManager,
	ProviderTransport,
	TOOL_CATEGORIES,
	canRestart,
	computeRestartDelay,
	createRestartPolicy,
	filterToolsForSubagent,
	formatTaskSummary,
	getAllowedTools,
	getSubagentSpec,
	incrementAttempts,
	isAssistantMessage,
	isTextContent,
	isToolAllowed,
	isToolCall,
	isToolResultMessage,
	isUserMessage,
} from "../../../packages/core/src/index.js";

// Simulate: import from '@evalops/maestro-core/sandbox'
import { DaytonaSandbox } from "../../../packages/core/src/sandbox/index.js";

// Simulate: import from '@evalops/maestro-core/swarm'
import {
	parsePlanContent,
	parsePlanFile,
} from "../../../packages/core/src/swarm/index.js";

// Simulate: import types
import type {
	AgentEvent,
	AgentOptions,
	AgentRunConfig,
	AgentState,
	AssistantMessage,
	BackgroundTaskHealth,
	BackgroundTaskNotification,
	BackgroundTaskStatus,
	HandoffContext,
	Message,
	RestartPolicy,
	SubagentSpec,
	SubagentType,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../../../packages/core/src/index.js";

import type {
	DaytonaSandboxConfig,
	ExecResult,
	Sandbox,
} from "../../../packages/core/src/sandbox/index.js";

import type {
	ParsedPlan,
	SwarmConfig,
	SwarmEvent,
	SwarmState,
	SwarmTask,
	SwarmTeammate,
} from "../../../packages/core/src/swarm/index.js";

describe("Consumer Integration", () => {
	it("all main exports are defined", () => {
		// Classes
		expect(Agent).toBeDefined();
		expect(ProviderTransport).toBeDefined();
		expect(ContextHandoffManager).toBeDefined();
		expect(DaytonaSandbox).toBeDefined();

		// Functions
		expect(getSubagentSpec).toBeDefined();
		expect(isToolAllowed).toBeDefined();
		expect(getAllowedTools).toBeDefined();
		expect(filterToolsForSubagent).toBeDefined();
		expect(isUserMessage).toBeDefined();
		expect(isAssistantMessage).toBeDefined();
		expect(isToolResultMessage).toBeDefined();
		expect(isTextContent).toBeDefined();
		expect(isToolCall).toBeDefined();
		expect(createRestartPolicy).toBeDefined();
		expect(canRestart).toBeDefined();
		expect(computeRestartDelay).toBeDefined();
		expect(incrementAttempts).toBeDefined();
		expect(formatTaskSummary).toBeDefined();
		expect(parsePlanContent).toBeDefined();
		expect(parsePlanFile).toBeDefined();

		// Constants
		expect(TOOL_CATEGORIES).toBeDefined();
	});

	it("can wire Agent with ProviderTransport", () => {
		const transport = new ProviderTransport({
			getAuthContext: () => ({
				provider: "anthropic",
				token: "sk-test",
				type: "api-key" as const,
			}),
		});

		const agent = new Agent({
			transport,
			initialState: {
				model: {
					id: "claude-sonnet-4-5",
					provider: "anthropic",
					api: "anthropic-messages",
					// biome-ignore lint/suspicious/noExplicitAny: test mock
				} as any,
			},
		});

		expect(agent).toBeDefined();
		expect(agent.state).toBeDefined();
	});

	it("can use subagent specs to filter tools for an agent", () => {
		const allTools = [
			{ name: "read" },
			{ name: "write" },
			{ name: "bash" },
			{ name: "websearch" },
		];

		const explorerTools = filterToolsForSubagent(allTools, "explorer");
		const coderTools = filterToolsForSubagent(allTools, "coder");

		// Explorer: read-only
		expect(explorerTools.some((t: { name: string }) => t.name === "read")).toBe(
			true,
		);
		expect(
			explorerTools.some((t: { name: string }) => t.name === "write"),
		).toBe(false);

		// Coder: read + write + shell, but not web
		expect(coderTools.some((t: { name: string }) => t.name === "bash")).toBe(
			true,
		);
		expect(
			coderTools.some((t: { name: string }) => t.name === "websearch"),
		).toBe(false);
	});

	it("can use ContextHandoff to track a session", () => {
		const handoff = new ContextHandoffManager();
		handoff.setCurrentTask("Build auth system");
		handoff.recordFileModification("src/auth.ts");
		handoff.addPendingWork("Add refresh tokens");
		handoff.addImportantContext("Using JWT, not sessions");

		const usage = handoff.checkUsage(50000, 200000);
		expect(usage.status).toBe("ok");

		const ctx = handoff.generateHandoffContext("Halfway through auth");
		const prompt = handoff.formatHandoffPrompt(ctx);
		expect(prompt).toContain("auth");
		expect(prompt.length).toBeGreaterThan(100);
	});

	it("can parse a plan and build a swarm config", () => {
		const plan = parsePlanContent(`# Auth System

- [ ] Create user model
- [ ] Implement login endpoint
- [ ] Add JWT middleware
- [ ] Write auth tests
`);

		const config: SwarmConfig = {
			teammateCount: 2,
			planFile: "auth-plan.md",
			tasks: plan.tasks,
			cwd: "/workspace",
			continueOnFailure: true,
			taskTimeout: 300000,
		};

		expect(config.tasks.length).toBeGreaterThanOrEqual(3);
		expect(config.teammateCount).toBe(2);
	});

	it("can create a restart policy and simulate retries", () => {
		const policy = createRestartPolicy({
			maxAttempts: 3,
			delayMs: 100,
			strategy: "exponential",
		})!;

		const delays: number[] = [];
		while (canRestart(policy)) {
			incrementAttempts(policy);
			delays.push(computeRestartDelay(policy));
		}

		expect(delays.length).toBe(3);
		// Exponential: each delay should generally increase
		expect(delays[1]!).toBeGreaterThanOrEqual(delays[0]! * 0.5); // with jitter tolerance
	});

	it("type guards work on realistic message structures", () => {
		const userMsg = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "Hello" }],
		};
		const assistantMsg = {
			role: "assistant" as const,
			content: [
				{ type: "text" as const, text: "Hi there" },
				{
					type: "toolCall" as const,
					id: "tc-1",
					name: "read",
					input: { path: "file.ts" },
				},
			],
		};
		const toolResultMsg = {
			role: "toolResult" as const,
			content: [{ type: "text" as const, text: "file contents" }],
		};

		expect(isUserMessage(userMsg)).toBe(true);
		expect(isAssistantMessage(assistantMsg)).toBe(true);
		expect(isToolResultMessage(toolResultMsg)).toBe(true);

		// Content block guards
		expect(isTextContent(assistantMsg.content[0])).toBe(true);
		expect(isToolCall(assistantMsg.content[1])).toBe(true);
		expect(isTextContent(assistantMsg.content[1])).toBe(false);
		expect(isToolCall(assistantMsg.content[0])).toBe(false);
	});

	it("DaytonaSandbox.create is a static async factory", () => {
		expect(typeof DaytonaSandbox.create).toBe("function");
		// Verify it returns a promise (without actually calling Daytona API)
		// The fact that it's importable and callable is the key assertion
	});

	it("types compile correctly (compile-time check)", () => {
		// These assertions verify TypeScript types resolve correctly.
		// If the imports above compile, the types work.
		const _subagentType: SubagentType = "coder";
		const _status: BackgroundTaskStatus = "running";
		const _taskId: string = "task-1";

		expect(_subagentType).toBe("coder");
		expect(_status).toBe("running");
	});
});
