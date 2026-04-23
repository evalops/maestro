import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadInteractionTracker() {
	return import("../src/interaction/user-interaction.js");
}

describe("Notification Hooks", () => {
	const testDir = join(tmpdir(), `composer-hooks-test-${Date.now()}`);
	const originalEnv = { ...process.env };

	beforeEach(async () => {
		// Reset environment by setting to empty string (not undefined which becomes "undefined")
		process.env.MAESTRO_NOTIFY_PROGRAM = "";
		process.env.MAESTRO_NOTIFY_EVENTS = "";
		process.env.MAESTRO_NOTIFY_TIMEOUT = "";
		process.env.MAESTRO_NOTIFY_IDLE_MS = "";
		process.env.MAESTRO_NOTIFY_TERMINAL = "";

		// Create test directory
		mkdirSync(testDir, { recursive: true });

		// Clear module cache to reset config
		vi.resetModules();
		vi.useRealTimers();
		const { resetUserInteractionTracking } = await loadInteractionTracker();
		resetUserInteractionTracking(0);
	});

	afterEach(() => {
		// Restore environment
		process.env = { ...originalEnv };

		// Clean up test directory
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("loadNotificationConfig", () => {
		it("should return empty config when no environment variables set", async () => {
			const { loadNotificationConfig, clearNotificationConfigCache } =
				await import("../src/hooks/notification-hooks.js");
			clearNotificationConfigCache();

			const config = loadNotificationConfig();

			expect(config.program).toBeUndefined();
			expect(config.events).toEqual([]);
		});

		it("should load config from environment variables", async () => {
			process.env.MAESTRO_NOTIFY_PROGRAM = "/usr/bin/my-notifier";
			process.env.MAESTRO_NOTIFY_EVENTS = "turn-complete,session-end";

			const { loadNotificationConfig, clearNotificationConfigCache } =
				await import("../src/hooks/notification-hooks.js");
			clearNotificationConfigCache();

			const config = loadNotificationConfig();

			expect(config.program).toBe("/usr/bin/my-notifier");
			expect(config.events).toContain("turn-complete");
			expect(config.events).toContain("session-end");
		});

		it("should expand 'all' to all event types", async () => {
			process.env.MAESTRO_NOTIFY_PROGRAM = "/usr/bin/notifier";
			process.env.MAESTRO_NOTIFY_EVENTS = "all";

			const { loadNotificationConfig, clearNotificationConfigCache } =
				await import("../src/hooks/notification-hooks.js");
			clearNotificationConfigCache();

			const config = loadNotificationConfig();

			expect(config.events).toContain("turn-complete");
			expect(config.events).toContain("session-start");
			expect(config.events).toContain("session-end");
			expect(config.events).toContain("tool-execution");
			expect(config.events).toContain("error");
		});

		it("should parse custom timeout from environment", async () => {
			process.env.MAESTRO_NOTIFY_PROGRAM = "/usr/bin/notifier";
			process.env.MAESTRO_NOTIFY_EVENTS = "turn-complete";
			process.env.MAESTRO_NOTIFY_TIMEOUT = "60000";

			const { loadNotificationConfig, clearNotificationConfigCache } =
				await import("../src/hooks/notification-hooks.js");
			clearNotificationConfigCache();

			const config = loadNotificationConfig();

			expect(config.timeout).toBe(60000);
		});

		it("should filter invalid event types", async () => {
			process.env.MAESTRO_NOTIFY_PROGRAM = "/usr/bin/notifier";
			process.env.MAESTRO_NOTIFY_EVENTS = "turn-complete,invalid-event,error";

			const { loadNotificationConfig, clearNotificationConfigCache } =
				await import("../src/hooks/notification-hooks.js");
			clearNotificationConfigCache();

			const config = loadNotificationConfig();

			expect(config.events).toContain("turn-complete");
			expect(config.events).toContain("error");
			expect(config.events).not.toContain("invalid-event");
		});
	});

	describe("isNotificationEnabled", () => {
		it("should return false when no program configured", async () => {
			const { isNotificationEnabled, clearNotificationConfigCache } =
				await import("../src/hooks/notification-hooks.js");
			clearNotificationConfigCache();

			expect(isNotificationEnabled("turn-complete")).toBe(false);
		});

		it("should return true when terminal notifications are enabled for the event", async () => {
			process.env.MAESTRO_NOTIFY_TERMINAL = "true";
			process.env.MAESTRO_NOTIFY_EVENTS = "turn-complete";

			const { isNotificationEnabled, clearNotificationConfigCache } =
				await import("../src/hooks/notification-hooks.js");
			clearNotificationConfigCache();

			expect(isNotificationEnabled("turn-complete")).toBe(true);
		});

		it("should return false when event not in configured events", async () => {
			process.env.MAESTRO_NOTIFY_PROGRAM = "/usr/bin/notifier";
			process.env.MAESTRO_NOTIFY_EVENTS = "session-end";

			const { isNotificationEnabled, clearNotificationConfigCache } =
				await import("../src/hooks/notification-hooks.js");
			clearNotificationConfigCache();

			expect(isNotificationEnabled("turn-complete")).toBe(false);
		});

		it("should return true when event is configured", async () => {
			process.env.MAESTRO_NOTIFY_PROGRAM = "/usr/bin/notifier";
			process.env.MAESTRO_NOTIFY_EVENTS = "turn-complete,error";

			const { isNotificationEnabled, clearNotificationConfigCache } =
				await import("../src/hooks/notification-hooks.js");
			clearNotificationConfigCache();

			expect(isNotificationEnabled("turn-complete")).toBe(true);
			expect(isNotificationEnabled("error")).toBe(true);
			expect(isNotificationEnabled("session-start")).toBe(false);
		});
	});

	describe("createNotificationFromAgentEvent", () => {
		it("should create payload for agent_start event", async () => {
			const { createNotificationFromAgentEvent } = await import(
				"../src/hooks/notification-hooks.js"
			);

			const payload = createNotificationFromAgentEvent(
				{ type: "agent_start" },
				{ cwd: "/test/dir", sessionId: "test-session" },
			);

			expect(payload).not.toBeNull();
			expect(payload?.type).toBe("session-start");
			expect(payload?.cwd).toBe("/test/dir");
			expect(payload?.threadId).toBe("test-session");
		});

		it("should create payload for agent_end event", async () => {
			const { createNotificationFromAgentEvent } = await import(
				"../src/hooks/notification-hooks.js"
			);

			const payload = createNotificationFromAgentEvent(
				{
					type: "agent_end",
					messages: [
						{
							role: "user",
							content: "Hello",
							timestamp: Date.now(),
						},
						{
							role: "assistant",
							content: [{ type: "text", text: "Hi there!" }],
							api: "anthropic-messages",
							provider: "anthropic",
							model: "claude-3",
							usage: {
								input: 10,
								output: 5,
								cacheRead: 0,
								cacheWrite: 0,
								cost: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									total: 0,
								},
							},
							stopReason: "stop",
							timestamp: Date.now(),
						},
					],
				},
				{ cwd: "/test/dir" },
			);

			expect(payload).not.toBeNull();
			expect(payload?.type).toBe("session-end");
			expect(payload?.lastAssistantMessage).toBe("Hi there!");
		});

		it("should create payload for turn_end event", async () => {
			const { createNotificationFromAgentEvent } = await import(
				"../src/hooks/notification-hooks.js"
			);

			const payload = createNotificationFromAgentEvent(
				{
					type: "turn_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Done!" }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-3",
						usage: {
							input: 10,
							output: 5,
							cacheRead: 0,
							cacheWrite: 0,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
					toolResults: [],
				},
				{ cwd: "/test/dir" },
			);

			expect(payload).not.toBeNull();
			expect(payload?.type).toBe("turn-complete");
			expect(payload?.lastAssistantMessage).toBe("Done!");
		});

		it("should create payload for tool_execution_end event", async () => {
			const { createNotificationFromAgentEvent } = await import(
				"../src/hooks/notification-hooks.js"
			);

			const payload = createNotificationFromAgentEvent(
				{
					type: "tool_execution_end",
					toolCallId: "call-123",
					toolName: "bash",
					errorCode: "governance_denied",
					approvalRequestId: "approval-123",
					governedOutcome: "denied",
					result: {
						role: "toolResult",
						toolCallId: "call-123",
						toolName: "bash",
						content: [{ type: "text", text: "Command output here" }],
						isError: false,
						timestamp: Date.now(),
					},
					isError: false,
				},
				{ cwd: "/test/dir" },
			);

			expect(payload).not.toBeNull();
			expect(payload?.type).toBe("tool-execution");
			expect(payload?.toolName).toBe("bash");
			expect(payload?.toolResult).toBe("Command output here");
			expect(payload?.toolErrorCode).toBe("governance_denied");
			expect(payload?.approvalRequestId).toBe("approval-123");
			expect(payload?.governedOutcome).toBe("denied");
		});

		it("should create payload for error event", async () => {
			const { createNotificationFromAgentEvent } = await import(
				"../src/hooks/notification-hooks.js"
			);

			const payload = createNotificationFromAgentEvent(
				{ type: "error", message: "Something went wrong" },
				{ cwd: "/test/dir" },
			);

			expect(payload).not.toBeNull();
			expect(payload?.type).toBe("error");
			expect(payload?.error).toBe("Something went wrong");
		});

		it("should return null for unhandled event types", async () => {
			const { createNotificationFromAgentEvent } = await import(
				"../src/hooks/notification-hooks.js"
			);

			const payload = createNotificationFromAgentEvent(
				{ type: "message_start", message: {} as never },
				{ cwd: "/test/dir" },
			);

			expect(payload).toBeNull();
		});

		it("dispatches notification hooks even when desktop notifications are disabled", async () => {
			const { clearNotificationConfigCache, dispatchAgentNotification } =
				await import("../src/hooks/notification-hooks.js");
			clearNotificationConfigCache();

			const runNotificationHooks = vi.fn().mockResolvedValue({});
			const logger = { warn: vi.fn() };
			const payload = dispatchAgentNotification(
				{
					type: "turn_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Done" }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-sonnet-4-5-20250929",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
					toolResults: [],
				},
				{
					cwd: "/tmp/project",
					sessionId: "session-123",
					messages: [
						{ role: "user", content: "Summarize", timestamp: Date.now() },
					],
				},
				{
					sessionHookService: {
						hasHooks: () => true,
						runNotificationHooks,
					} as never,
					logger,
				},
			);

			expect(payload?.type).toBe("turn-complete");
			expect(runNotificationHooks).toHaveBeenCalledWith(
				"turn-complete",
				"Done",
			);
			expect(logger.warn).not.toHaveBeenCalled();
		});
	});

	describe("sendNotification", () => {
		it("sends terminal notifications without an external program", async () => {
			process.env.MAESTRO_NOTIFY_TERMINAL = "true";
			process.env.MAESTRO_NOTIFY_EVENTS = "turn-complete";
			process.env.MAESTRO_NOTIFY_IDLE_MS = "0";

			const stdoutSpy = vi
				.spyOn(process.stdout, "write")
				.mockImplementation(() => true);

			const { sendNotification, clearNotificationConfigCache } = await import(
				"../src/hooks/notification-hooks.js"
			);
			clearNotificationConfigCache();

			await sendNotification({
				type: "turn-complete",
				timestamp: new Date().toISOString(),
				cwd: "/tmp/project",
				lastAssistantMessage: "Done!",
			});

			expect(stdoutSpy).toHaveBeenCalled();
			expect(stdoutSpy.mock.calls[0]?.[0]).toContain("Done!");

			stdoutSpy.mockRestore();
		});

		it("waits for idle before sending completion notifications", async () => {
			process.env.MAESTRO_NOTIFY_TERMINAL = "true";
			process.env.MAESTRO_NOTIFY_EVENTS = "turn-complete";
			process.env.MAESTRO_NOTIFY_IDLE_MS = "6000";

			vi.useFakeTimers();
			vi.setSystemTime(0);
			const { recordUserInteraction, resetUserInteractionTracking } =
				await loadInteractionTracker();
			resetUserInteractionTracking(0);

			const stdoutSpy = vi
				.spyOn(process.stdout, "write")
				.mockImplementation(() => true);

			const { sendNotification, clearNotificationConfigCache } = await import(
				"../src/hooks/notification-hooks.js"
			);
			clearNotificationConfigCache();

			const promise = sendNotification({
				type: "turn-complete",
				timestamp: new Date().toISOString(),
				cwd: "/tmp/project",
				lastAssistantMessage: "Done!",
			});

			await vi.advanceTimersByTimeAsync(3000);
			expect(stdoutSpy).not.toHaveBeenCalled();

			recordUserInteraction(3000);

			await vi.advanceTimersByTimeAsync(3000);
			await promise;

			expect(stdoutSpy).not.toHaveBeenCalled();
			stdoutSpy.mockRestore();
		});
	});
});
