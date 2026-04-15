import { describe, expect, it } from "vitest";
import {
	ComposerAgentEventSchema,
	ComposerApprovalsStatusResponseSchema,
	ComposerApprovalsUpdateResponseSchema,
	ComposerBackgroundHistoryResponseSchema,
	ComposerBackgroundStatusResponseSchema,
	ComposerBackgroundUpdateResponseSchema,
	ComposerChatRequestSchema,
	ComposerCommandListResponseSchema,
	ComposerCommandPrefsSchema,
	ComposerConfigResponseSchema,
	ComposerConfigWriteResponseSchema,
	ComposerFilesResponseSchema,
	ComposerFrameworkListResponseSchema,
	ComposerFrameworkStatusResponseSchema,
	ComposerFrameworkUpdateResponseSchema,
	ComposerGuardianConfigResponseSchema,
	ComposerGuardianRunResponseSchema,
	ComposerGuardianStatusResponseSchema,
	ComposerMessageSchema,
	ComposerModelListResponseSchema,
	ComposerModelSchema,
	ComposerPlanActionResponseSchema,
	ComposerPlanStatusResponseSchema,
	ComposerStatusResponseSchema,
	ComposerUndoOperationResponseSchema,
	ComposerUndoStatusResponseSchema,
	ComposerUsageResponseSchema,
} from "../../packages/contracts/src/schemas.js";
import {
	assertComposerChatRequest,
	assertHeadlessFromAgentMessage,
	assertHeadlessRuntimeStreamEnvelope,
	assertHeadlessToAgentMessage,
	isComposerAgentEvent,
	validateSchema,
} from "../../packages/contracts/src/validators.js";

describe("contracts validators", () => {
	it("accepts a minimal chat request", () => {
		const request = {
			messages: [{ role: "user", content: "Hello" }],
		};
		const result = validateSchema(ComposerChatRequestSchema, request);
		expect(result.ok).toBe(true);
		assertComposerChatRequest(request);
	});

	it("rejects invalid roles", () => {
		const request = {
			messages: [{ role: "invalid", content: "Hello" }],
		};
		const result = validateSchema(ComposerChatRequestSchema, request);
		expect(result.ok).toBe(false);
	});

	it("allows empty content arrays for streaming messages", () => {
		const message = { role: "assistant", content: [] };
		const result = validateSchema(ComposerMessageSchema, message);
		expect(result.ok).toBe(true);
	});

	it("validates agent events with required fields", () => {
		expect(isComposerAgentEvent({ type: "heartbeat" })).toBe(true);
		expect(isComposerAgentEvent({ type: "message_start" })).toBe(false);
		const eventResult = validateSchema(ComposerAgentEventSchema, {
			type: "message_start",
			message: { role: "assistant", content: "Hi" },
		});
		expect(eventResult.ok).toBe(true);
		const summaryEventResult = validateSchema(ComposerAgentEventSchema, {
			type: "tool_batch_summary",
			summary: "Read README.md +1 more",
			summaryLabels: ["Read README.md", "Wrote notes.txt"],
			toolCallIds: ["tool_0", "tool_1"],
			toolNames: ["read", "write"],
			callsSucceeded: 2,
			callsFailed: 0,
		});
		expect(summaryEventResult.ok).toBe(true);
		const toolStartEvent = validateSchema(ComposerAgentEventSchema, {
			type: "tool_execution_start",
			toolCallId: "tool_0",
			toolName: "read",
			displayName: "Read",
			summaryLabel: "Read README.md",
			args: { path: "README.md" },
		});
		expect(toolStartEvent.ok).toBe(true);
		const approvalEvent = validateSchema(ComposerAgentEventSchema, {
			type: "action_approval_required",
			request: {
				id: "approval_1",
				toolName: "bash",
				displayName: "Bash",
				summaryLabel: "Ran rm -rf dist",
				actionDescription: "Running rm -rf dist",
				args: { command: "rm -rf dist" },
				reason: "Dangerous command",
			},
		});
		expect(approvalEvent.ok).toBe(true);
	});

	it("rejects malformed headless commands with generated per-type schemas", () => {
		expect(() =>
			assertHeadlessToAgentMessage({
				type: "prompt",
				content: "hello",
				unexpected: true,
			}),
		).toThrow(/Invalid headless command/);
		expect(() =>
			assertHeadlessToAgentMessage({ type: "totally_unknown_command" }),
		).toThrow("Unknown headless command type");
	});

	it("accepts generated headless outbound envelopes", () => {
		expect(() =>
			assertHeadlessFromAgentMessage({
				type: "status",
				message: "ok",
			}),
		).not.toThrow();
		expect(() =>
			assertHeadlessRuntimeStreamEnvelope({
				type: "heartbeat",
				cursor: 3,
			}),
		).not.toThrow();
	});

	it("accepts slim toolcall updates without partial messages", () => {
		const startEvent = validateSchema(ComposerAgentEventSchema, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				toolCallId: "call_1",
				toolCallName: "read_file",
				toolCallArgs: { path: "/tmp/start.txt" },
			},
		});
		expect(startEvent.ok).toBe(true);

		const deltaEvent = validateSchema(ComposerAgentEventSchema, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: '{"path":"/tmp/one.txt"}',
				toolCallId: "call_1",
				toolCallName: "read_file",
				toolCallArgs: { path: "/tmp/one.txt" },
			},
		});
		expect(deltaEvent.ok).toBe(true);

		const truncatedEvent = validateSchema(ComposerAgentEventSchema, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: '{"path":"/tmp/large.txt"}',
				toolCallId: "call_2",
				toolCallName: "read_file",
				toolCallArgsTruncated: true,
			},
		});
		expect(truncatedEvent.ok).toBe(true);

		const endEvent = validateSchema(ComposerAgentEventSchema, {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: {
					type: "toolCall",
					id: "call_1",
					name: "read_file",
					arguments: { path: "/tmp/one.txt" },
				},
			},
		});
		expect(endEvent.ok).toBe(true);
	});

	it("accepts a minimal status response", () => {
		const status = {
			cwd: "/tmp/project",
			git: null,
			context: { agentMd: false, claudeMd: false },
			server: { uptime: 1, version: "v20.0.0" },
			database: { configured: false, connected: false },
			backgroundTasks: null,
			hooks: {
				asyncInFlight: 0,
				concurrency: { max: 0, active: 0, queued: 0 },
			},
			lastUpdated: 1,
			lastLatencyMs: 1,
		};
		const result = validateSchema(ComposerStatusResponseSchema, status);
		expect(result.ok).toBe(true);
	});

	it("accepts status responses with onboarding guidance", () => {
		const status = {
			cwd: "/tmp/project",
			git: null,
			context: { agentMd: false, claudeMd: false },
			onboarding: {
				shouldShow: true,
				completed: false,
				seenCount: 1,
				steps: [
					{
						key: "workspace",
						text: "Ask Maestro to create a new app or clone a repository.",
						isComplete: true,
						isEnabled: false,
					},
					{
						key: "instructions",
						text: "Run /init to scaffold AGENTS.md instructions for this project.",
						isComplete: false,
						isEnabled: true,
					},
				],
			},
			server: { uptime: 1, version: "v20.0.0" },
			database: { configured: false, connected: false },
			backgroundTasks: null,
			hooks: {
				asyncInFlight: 0,
				concurrency: { max: 0, active: 0, queued: 0 },
			},
			lastUpdated: 1,
			lastLatencyMs: 1,
		};
		const result = validateSchema(ComposerStatusResponseSchema, status);
		expect(result.ok).toBe(true);
	});

	it("accepts model responses for models and model selection", () => {
		const model = {
			id: "test-model",
			provider: "test",
			name: "Test Model",
			contextWindow: 1000,
			maxTokens: 500,
			reasoning: false,
		};
		const modelResult = validateSchema(ComposerModelSchema, model);
		expect(modelResult.ok).toBe(true);
		const listResult = validateSchema(ComposerModelListResponseSchema, {
			models: [model],
		});
		expect(listResult.ok).toBe(true);
	});

	it("accepts command and file responses", () => {
		const commands = {
			commands: [
				{
					name: "hello",
					description: "Say hi",
					prompt: "Hello {{name}}",
					args: [{ name: "name", required: true }],
				},
			],
		};
		const commandResult = validateSchema(
			ComposerCommandListResponseSchema,
			commands,
		);
		expect(commandResult.ok).toBe(true);
		const prefsResult = validateSchema(ComposerCommandPrefsSchema, {
			favorites: ["hello"],
			recents: [],
		});
		expect(prefsResult.ok).toBe(true);
		const filesResult = validateSchema(ComposerFilesResponseSchema, {
			files: ["README.md"],
		});
		expect(filesResult.ok).toBe(true);
	});

	it("accepts config responses", () => {
		const configResult = validateSchema(ComposerConfigResponseSchema, {
			config: { model: "demo", limits: { maxTokens: 1000 } },
			configPath: "/tmp/composer.config.json",
		});
		expect(configResult.ok).toBe(true);
		const writeResult = validateSchema(ComposerConfigWriteResponseSchema, {
			success: true,
		});
		expect(writeResult.ok).toBe(true);
	});

	it("accepts plan, guardian, background, approvals, framework, and undo responses", () => {
		const guardianStatus = validateSchema(
			ComposerGuardianStatusResponseSchema,
			{
				enabled: true,
				state: { enabled: true },
			},
		);
		expect(guardianStatus.ok).toBe(true);
		const guardianRun = validateSchema(ComposerGuardianRunResponseSchema, {
			status: "passed",
			exitCode: 0,
			startedAt: 1,
			durationMs: 2,
			target: "staged",
			filesScanned: 0,
			summary: "ok",
			toolResults: [],
		});
		expect(guardianRun.ok).toBe(true);
		const guardianConfig = validateSchema(
			ComposerGuardianConfigResponseSchema,
			{
				success: true,
				enabled: true,
			},
		);
		expect(guardianConfig.ok).toBe(true);
		const planStatus = validateSchema(ComposerPlanStatusResponseSchema, {
			state: null,
			content: null,
		});
		expect(planStatus.ok).toBe(true);
		const planAction = validateSchema(ComposerPlanActionResponseSchema, {
			success: true,
		});
		expect(planAction.ok).toBe(true);
		const backgroundStatus = validateSchema(
			ComposerBackgroundStatusResponseSchema,
			{
				settings: {
					notificationsEnabled: true,
					statusDetailsEnabled: false,
				},
				snapshot: {
					running: 1,
					total: 2,
					failed: 0,
					detailsRedacted: false,
				},
			},
		);
		expect(backgroundStatus.ok).toBe(true);
		const backgroundHistory = validateSchema(
			ComposerBackgroundHistoryResponseSchema,
			{
				history: [
					{
						timestamp: "2024-01-01T00:00:00Z",
						event: "started",
						taskId: "task-1",
						command: "echo ok",
					},
				],
				truncated: false,
			},
		);
		expect(backgroundHistory.ok).toBe(true);
		const backgroundUpdate = validateSchema(
			ComposerBackgroundUpdateResponseSchema,
			{
				success: true,
				message: "Background task notify enabled",
			},
		);
		expect(backgroundUpdate.ok).toBe(true);
		const approvalsStatus = validateSchema(
			ComposerApprovalsStatusResponseSchema,
			{
				mode: "prompt",
				availableModes: ["auto", "prompt", "fail"],
			},
		);
		expect(approvalsStatus.ok).toBe(true);
		const approvalsUpdate = validateSchema(
			ComposerApprovalsUpdateResponseSchema,
			{
				success: true,
				mode: "auto",
				message: "Approval mode set to auto",
			},
		);
		expect(approvalsUpdate.ok).toBe(true);
		const frameworkStatus = validateSchema(
			ComposerFrameworkStatusResponseSchema,
			{
				framework: "none",
				source: "user",
				locked: false,
				scope: "user",
			},
		);
		expect(frameworkStatus.ok).toBe(true);
		const frameworkList = validateSchema(ComposerFrameworkListResponseSchema, {
			frameworks: [{ id: "node", summary: "Node.js" }],
		});
		expect(frameworkList.ok).toBe(true);
		const frameworkUpdate = validateSchema(
			ComposerFrameworkUpdateResponseSchema,
			{
				success: true,
				message: "Node.js (scope: user)",
				framework: "node",
				summary: "Node.js",
				scope: "user",
			},
		);
		expect(frameworkUpdate.ok).toBe(true);
		const undoStatus = validateSchema(ComposerUndoStatusResponseSchema, {
			totalChanges: 0,
			canUndo: false,
			checkpoints: [],
		});
		expect(undoStatus.ok).toBe(true);
		const undoOperation = validateSchema(ComposerUndoOperationResponseSchema, {
			success: true,
			undone: 1,
			errors: [],
		});
		expect(undoOperation.ok).toBe(true);
	});

	it("accepts a usage response with breakdowns", () => {
		const totals = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			total: 3,
		};
		const breakdown = {
			cost: 0.01,
			requests: 2,
			tokens: 3,
			tokensDetailed: totals,
			calls: 2,
			cachedTokens: 0,
		};
		const usage = {
			summary: {
				totalCost: 0.01,
				totalRequests: 2,
				totalTokens: 3,
				tokensDetailed: totals,
				totalTokensDetailed: totals,
				totalTokensBreakdown: totals,
				totalCachedTokens: 0,
				byProvider: { demo: breakdown },
				byModel: { demo: breakdown },
			},
			hasData: true,
		};
		const result = validateSchema(ComposerUsageResponseSchema, usage);
		expect(result.ok).toBe(true);
	});
});
