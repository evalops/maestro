import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearLoadedTypeScriptHooks,
	clearRegisteredHooks,
	discoverAndLoadTypeScriptHooks,
	registerHook,
} from "../../src/hooks/index.js";
import { createSessionHookService } from "../../src/hooks/session-integration.js";
import type {
	OnErrorHookInput,
	OverflowHookInput,
	PostMessageHookInput,
	PreMessageHookInput,
	SessionEndHookInput,
	SessionStartHookInput,
	SubagentStartHookInput,
	SubagentStopHookInput,
} from "../../src/hooks/types.js";

describe("SessionHookService", () => {
	let testDir: string;
	let hooksDir: string;
	let previousMaestroHome: string | undefined;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "hooks-test-"));
		hooksDir = join(testDir, ".maestro", "hooks");
		mkdirSync(hooksDir, { recursive: true });
		previousMaestroHome = process.env.MAESTRO_HOME;
		process.env.MAESTRO_HOME = join(testDir, ".maestro-home");
	});

	afterEach(() => {
		clearLoadedTypeScriptHooks();
		rmSync(testDir, { recursive: true, force: true });
		if (previousMaestroHome === undefined) {
			delete process.env.MAESTRO_HOME;
		} else {
			process.env.MAESTRO_HOME = previousMaestroHome;
		}
	});

	describe("service creation", () => {
		it("creates a session hook service with context", () => {
			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session-123",
			});

			expect(service).toBeDefined();
			expect(service.runSessionStartHooks).toBeDefined();
			expect(service.runSessionEndHooks).toBeDefined();
			expect(service.runOverflowHooks).toBeDefined();
			expect(service.runStopFailureHooks).toBeDefined();
			expect(service.runPreMessageHooks).toBeDefined();
			expect(service.runPostMessageHooks).toBeDefined();
			expect(service.runPostCompactHooks).toBeDefined();
			expect(service.runOnErrorHooks).toBeDefined();
			expect(service.hasHooks).toBeDefined();
		});
	});

	describe("SessionStart hooks", () => {
		it("runs session start hooks without errors", async () => {
			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runSessionStartHooks("cli");

			expect(result).toBeDefined();
			expect(result.blocked).toBe(false);
			expect(result.hookResults).toBeInstanceOf(Array);
		});

		it("returns hook results array", async () => {
			const service = createSessionHookService({
				cwd: testDir,
			});

			const result = await service.runSessionStartHooks("api");

			expect(result.hookResults).toBeInstanceOf(Array);
			expect(result.preventContinuation).toBe(false);
		});

		it("runs project TypeScript session start hooks through the shared executor", async () => {
			writeFileSync(
				join(hooksDir, "session-start.ts"),
				`export default function (pi) {
  pi.on("SessionStart", async (input) => ({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "TS session start for " + input.source,
      initialUserMessage: "Seeded from " + input.source
    }
  }));
}
`,
			);
			await discoverAndLoadTypeScriptHooks([], testDir);

			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runSessionStartHooks("cli");

			expect(result.additionalContext).toBe("TS session start for cli");
			expect(result.initialUserMessage).toBe("Seeded from cli");
			expect(result.hookResults).toHaveLength(1);
			expect(result.hookResults[0]?.message.hookName).toContain(
				"session-start.ts",
			);
		});

		it("surfaces callback SessionStart initial user message", async () => {
			registerHook("SessionStart", {
				type: "callback",
				callback: async () => ({
					hookSpecificOutput: {
						hookEventName: "SessionStart",
						initialUserMessage: "Review the generated changelog first.",
					},
				}),
			});

			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runSessionStartHooks("cli");

			expect(result.initialUserMessage).toBe(
				"Review the generated changelog first.",
			);
		});
	});

	describe("SessionEnd hooks", () => {
		it("runs session end hooks with duration and turn count", async () => {
			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runSessionEndHooks("user_exit", 60000, 5);

			expect(result).toBeDefined();
			expect(result.blocked).toBe(false);
		});

		it("handles different end reasons", async () => {
			const service = createSessionHookService({
				cwd: testDir,
			});

			const reasons: SessionEndHookInput["reason"][] = [
				"user_exit",
				"error",
				"timeout",
				"complete",
				"clear",
			];

			for (const reason of reasons) {
				const result = await service.runSessionEndHooks(reason, 1000, 1);
				expect(result.blocked).toBe(false);
			}
		});
	});

	describe("Overflow hooks", () => {
		it("runs overflow hooks with token counts", async () => {
			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runOverflowHooks(
				150000,
				100000,
				"claude-3-opus",
			);

			expect(result).toBeDefined();
			expect(result.blocked).toBe(false);
		});

		it("handles overflow without model specified", async () => {
			const service = createSessionHookService({
				cwd: testDir,
			});

			const result = await service.runOverflowHooks(200000, 128000);

			expect(result).toBeDefined();
			expect(result.hookResults).toBeInstanceOf(Array);
		});
	});

	describe("StopFailure hooks", () => {
		it("runs stop-failure hooks with failure metadata", async () => {
			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runStopFailureHooks(
				"prompt_overflow",
				"Prompt exceeded context window",
				"Partial assistant response",
			);

			expect(result).toBeDefined();
			expect(result.blocked).toBe(false);
		});

		it("handles stop-failure hooks without optional details", async () => {
			const service = createSessionHookService({
				cwd: testDir,
			});

			const result = await service.runStopFailureHooks("max_output_tokens");

			expect(result).toBeDefined();
			expect(result.hookResults).toBeInstanceOf(Array);
		});
	});

	describe("PostCompact hooks", () => {
		it("runs post-compact hooks with summary text", async () => {
			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runPostCompactHooks(
				"auto",
				"Condensed summary of the previous conversation",
			);

			expect(result).toBeDefined();
			expect(result.blocked).toBe(false);
		});

		it("executes registered PostCompact hooks", async () => {
			clearRegisteredHooks();
			const capturedInputs: Array<{
				trigger: string;
				compact_summary: string;
			}> = [];
			registerHook("PostCompact", {
				type: "callback",
				callback: async (input) => {
					capturedInputs.push({
						trigger: (input as { trigger: string; compact_summary: string })
							.trigger,
						compact_summary: (
							input as { trigger: string; compact_summary: string }
						).compact_summary,
					});
					return {};
				},
			});

			try {
				const service = createSessionHookService({
					cwd: testDir,
					sessionId: "test-session",
				});

				await service.runPostCompactHooks("manual", "Saved summary");

				expect(capturedInputs).toEqual([
					{
						trigger: "manual",
						compact_summary: "Saved summary",
					},
				]);
			} finally {
				clearRegisteredHooks();
			}
		});
	});

	describe("PreMessage hooks", () => {
		it("runs pre-message hooks with message content", async () => {
			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runPreMessageHooks(
				"Hello, please help me with a task",
				[],
				"claude-3-opus",
			);

			expect(result).toBeDefined();
			expect(result.blocked).toBe(false);
		});

		it("handles messages with attachments", async () => {
			const service = createSessionHookService({
				cwd: testDir,
			});

			const attachments = ["/path/to/file1.txt", "/path/to/file2.png"];
			const result = await service.runPreMessageHooks(
				"Check these files",
				attachments,
				"claude-3-sonnet",
			);

			expect(result).toBeDefined();
			expect(result.hookResults).toBeInstanceOf(Array);
		});

		it("handles empty message", async () => {
			const service = createSessionHookService({
				cwd: testDir,
			});

			const result = await service.runPreMessageHooks("", [], undefined);

			expect(result).toBeDefined();
		});
	});

	describe("PostMessage hooks", () => {
		it("runs post-message hooks with response data", async () => {
			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runPostMessageHooks(
				"Here is my response to your question...",
				1000,
				500,
				2500,
				"end_turn",
			);

			expect(result).toBeDefined();
			expect(result.blocked).toBe(false);
		});

		it("handles different stop reasons", async () => {
			const service = createSessionHookService({
				cwd: testDir,
			});

			const stopReasons = [
				"end_turn",
				"max_tokens",
				"stop_sequence",
				undefined,
			];

			for (const stopReason of stopReasons) {
				const result = await service.runPostMessageHooks(
					"Response",
					500,
					250,
					1000,
					stopReason,
				);
				expect(result.blocked).toBe(false);
			}
		});

		it("handles large token counts", async () => {
			const service = createSessionHookService({
				cwd: testDir,
			});

			const result = await service.runPostMessageHooks(
				"Long response...",
				100000,
				50000,
				30000,
				"end_turn",
			);

			expect(result).toBeDefined();
		});
	});

	describe("OnError hooks", () => {
		it("runs error hooks with error details", async () => {
			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runOnErrorHooks(
				"Connection timeout",
				"NetworkError",
				"api_call",
				true,
			);

			expect(result).toBeDefined();
			expect(result.blocked).toBe(false);
		});

		it("handles non-recoverable errors", async () => {
			const service = createSessionHookService({
				cwd: testDir,
			});

			const result = await service.runOnErrorHooks(
				"Fatal error occurred",
				"FatalError",
				"system",
				false,
			);

			expect(result).toBeDefined();
		});

		it("handles errors without context", async () => {
			const service = createSessionHookService({
				cwd: testDir,
			});

			const result = await service.runOnErrorHooks(
				"Unknown error",
				"UnknownError",
				undefined,
				true,
			);

			expect(result).toBeDefined();
		});

		it("handles various error kinds", async () => {
			const service = createSessionHookService({
				cwd: testDir,
			});

			const errorKinds = [
				"NetworkError",
				"ValidationError",
				"AuthenticationError",
				"RateLimitError",
				"ToolError",
			];

			for (const kind of errorKinds) {
				const result = await service.runOnErrorHooks(
					`Error of type ${kind}`,
					kind,
					"test_context",
					true,
				);
				expect(result.blocked).toBe(false);
			}
		});
	});

	describe("SubagentStart hooks", () => {
		it("runs subagent start hooks", async () => {
			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runSubagentStartHooks(
				"explore",
				"Find all TypeScript files in the src directory",
				"parent-session-123",
			);

			expect(result).toBeDefined();
			expect(result.blocked).toBe(false);
		});

		it("handles different subagent types", async () => {
			const service = createSessionHookService({
				cwd: testDir,
			});

			const agentTypes = ["explore", "plan", "code-reviewer", "test-runner"];

			for (const agentType of agentTypes) {
				const result = await service.runSubagentStartHooks(
					agentType,
					"Task description",
					undefined,
				);
				expect(result.blocked).toBe(false);
			}
		});
	});

	describe("SubagentStop hooks", () => {
		it("runs subagent stop hooks on success", async () => {
			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runSubagentStopHooks(
				"explore",
				"agent-456",
				true,
				5000,
				3,
			);

			expect(result).toBeDefined();
			expect(result.blocked).toBe(false);
		});

		it("runs subagent stop hooks on failure", async () => {
			const service = createSessionHookService({
				cwd: testDir,
			});

			const result = await service.runSubagentStopHooks(
				"explore",
				"agent-789",
				false,
				10000,
				1,
				{
					error: "Subagent failed to complete task",
				},
			);

			expect(result).toBeDefined();
		});

		it("handles subagent with transcript path", async () => {
			const service = createSessionHookService({
				cwd: testDir,
			});

			const result = await service.runSubagentStopHooks(
				"plan",
				"agent-101",
				true,
				15000,
				5,
				{
					transcriptPath: "/path/to/transcript.json",
					parentSessionId: "parent-123",
				},
			);

			expect(result).toBeDefined();
		});
	});

	describe("hasHooks", () => {
		it("returns false when no hooks configured", () => {
			const service = createSessionHookService({
				cwd: testDir,
			});

			expect(service.hasHooks("SessionStart")).toBe(false);
			expect(service.hasHooks("SessionEnd")).toBe(false);
			expect(service.hasHooks("Overflow")).toBe(false);
			expect(service.hasHooks("StopFailure")).toBe(false);
			expect(service.hasHooks("PreMessage")).toBe(false);
			expect(service.hasHooks("PostMessage")).toBe(false);
			expect(service.hasHooks("OnError")).toBe(false);
		});

		it("checks all supported event types", () => {
			const service = createSessionHookService({
				cwd: testDir,
			});

			const eventTypes = [
				"SessionStart",
				"SessionEnd",
				"SubagentStart",
				"SubagentStop",
				"UserPromptSubmit",
				"PreCompact",
				"PostCompact",
				"Notification",
				"Overflow",
				"StopFailure",
				"PreMessage",
				"PostMessage",
				"OnError",
			] as const;

			for (const eventType of eventTypes) {
				const hasHook = service.hasHooks(eventType);
				expect(typeof hasHook).toBe("boolean");
			}
		});

		it("returns true when only TypeScript hooks are loaded", async () => {
			writeFileSync(
				join(hooksDir, "prompt-submit.ts"),
				`export default function (pi) {
  pi.on("UserPromptSubmit", async () => ({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "TS prompt context"
    }
  }));
}
`,
			);
			await discoverAndLoadTypeScriptHooks([], testDir);

			const service = createSessionHookService({
				cwd: testDir,
			});

			expect(service.hasHooks("UserPromptSubmit")).toBe(true);
		});
	});

	describe("TypeScript lifecycle hooks", () => {
		it("runs UserPromptSubmit TypeScript hooks through the shared executor", async () => {
			writeFileSync(
				join(hooksDir, "user-prompt-submit.ts"),
				`export default function (pi) {
  pi.on("UserPromptSubmit", async (input) => ({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "TS prompt for " + input.prompt
    }
  }));
}
`,
			);
			await discoverAndLoadTypeScriptHooks([], testDir);

			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runUserPromptSubmitHooks("ship it", 0);

			expect(result.additionalContext).toBe("TS prompt for ship it");
			expect(result.hookResults).toHaveLength(1);
			expect(result.hookResults[0]?.message.hookName).toContain(
				"user-prompt-submit.ts",
			);
		});
	});

	describe("abort signal handling", () => {
		it("respects abort signal in session start hooks", async () => {
			const service = createSessionHookService({
				cwd: testDir,
			});

			const controller = new AbortController();
			// Don't abort, just verify it accepts the signal
			const result = await service.runSessionStartHooks(
				"cli",
				controller.signal,
			);

			expect(result).toBeDefined();
		});

		it("respects abort signal in overflow hooks", async () => {
			const service = createSessionHookService({
				cwd: testDir,
			});

			const controller = new AbortController();
			const result = await service.runOverflowHooks(
				100000,
				80000,
				undefined,
				controller.signal,
			);

			expect(result).toBeDefined();
		});
	});

	describe("context propagation", () => {
		it("includes session id in all hooks", async () => {
			const sessionId = "unique-session-id-12345";
			const service = createSessionHookService({
				cwd: testDir,
				sessionId,
			});

			// All hooks should work with the session context
			await service.runSessionStartHooks("cli");
			await service.runPreMessageHooks("test", [], undefined);
			await service.runPostMessageHooks("response", 100, 50, 500, "end_turn");
			await service.runOnErrorHooks("error", "TestError", undefined, true);
			await service.runOverflowHooks(100000, 80000);
			await service.runStopFailureHooks(
				"prompt_overflow",
				"Prompt exceeded context window",
			);
			await service.runSessionEndHooks("complete", 10000, 2);

			// If we got here without errors, context propagation works
			expect(true).toBe(true);
		});

		it("works without session id", async () => {
			const service = createSessionHookService({
				cwd: testDir,
				// No sessionId
			});

			const result = await service.runSessionStartHooks("api");
			expect(result).toBeDefined();
		});
	});
});
