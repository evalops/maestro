/**
 * Tests for the comprehensive hook system.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type HookConfiguration,
	type HookJsonOutput,
	type PreToolUseHookInput,
	clearHookConfigCache,
	clearRegisteredHooks,
	createHookMessage,
	createSessionHookService,
	createToolHookService,
	executeHook,
	getMatchingHooks,
	isAsyncHookResponse,
	loadHookConfiguration,
	matchesPattern,
	parseHookOutput,
	registerHook,
	safeParseHookOutput,
	validateHookOutput,
} from "../src/hooks/index.js";

describe("Hook System", () => {
	beforeEach(() => {
		clearHookConfigCache();
		clearRegisteredHooks();
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		clearHookConfigCache();
		clearRegisteredHooks();
	});

	describe("matchesPattern", () => {
		it("should match everything with undefined pattern", () => {
			expect(matchesPattern("anything", undefined)).toBe(true);
		});

		it("should match everything with * pattern", () => {
			expect(matchesPattern("anything", "*")).toBe(true);
		});

		it("should match exact string", () => {
			expect(matchesPattern("bash", "bash")).toBe(true);
			expect(matchesPattern("bash", "edit")).toBe(false);
		});

		it("should match pipe-separated alternatives", () => {
			expect(matchesPattern("bash", "bash|edit|read")).toBe(true);
			expect(matchesPattern("edit", "bash|edit|read")).toBe(true);
			expect(matchesPattern("write", "bash|edit|read")).toBe(false);
		});

		it("should match regex patterns", () => {
			expect(matchesPattern("bash_command", "bash.*")).toBe(true);
			expect(matchesPattern("edit_file", "bash.*")).toBe(false);
			expect(matchesPattern("gh_pr", "gh_.*")).toBe(true);
		});
	});

	describe("loadHookConfiguration", () => {
		it("should load hooks from environment variables", () => {
			vi.stubEnv("COMPOSER_HOOKS_PRE_TOOL_USE", "my-validator.sh");

			const config = loadHookConfiguration("/tmp/test");

			expect(config.PreToolUse).toBeDefined();
			expect(config.PreToolUse?.[0]?.hooks[0]).toEqual({
				type: "command",
				command: "my-validator.sh",
			});
		});

		it("should support multiple commands in env var", () => {
			vi.stubEnv("COMPOSER_HOOKS_PRE_TOOL_USE", "validator1.sh\nvalidator2.sh");

			const config = loadHookConfiguration("/tmp/test");

			expect(config.PreToolUse?.[0]?.hooks).toHaveLength(2);
		});
	});

	describe("registerHook", () => {
		it("should register a programmatic hook", () => {
			const unregister = registerHook("PreToolUse", {
				type: "callback",
				callback: async () => ({ continue: true }),
			});

			const config = loadHookConfiguration("/tmp/test");
			expect(config.PreToolUse).toBeDefined();
			expect(config.PreToolUse?.[0]?.hooks[0].type).toBe("callback");

			unregister();
			clearHookConfigCache();

			const config2 = loadHookConfiguration("/tmp/test");
			// After unregistering, the array should be empty (no registered hooks)
			expect(config2.PreToolUse ?? []).toHaveLength(0);
		});

		it("should register hooks with matchers", () => {
			registerHook(
				"PreToolUse",
				{
					type: "callback",
					callback: async () => null,
				},
				"bash|edit",
			);

			const config = loadHookConfiguration("/tmp/test");
			expect(config.PreToolUse?.[0]?.matcher).toBe("bash|edit");
		});
	});

	describe("getMatchingHooks", () => {
		it("should return matching hooks for tool events", () => {
			registerHook(
				"PreToolUse",
				{
					type: "callback",
					callback: async () => null,
				},
				"bash",
			);

			registerHook(
				"PreToolUse",
				{
					type: "callback",
					callback: async () => null,
				},
				"edit",
			);

			const config = loadHookConfiguration("/tmp/test");

			const bashInput: PreToolUseHookInput = {
				hook_event_name: "PreToolUse",
				cwd: "/tmp/test",
				timestamp: new Date().toISOString(),
				tool_name: "bash",
				tool_call_id: "test-1",
				tool_input: {},
			};

			const hooks = getMatchingHooks(config, bashInput);
			expect(hooks).toHaveLength(1);
		});

		it("should return all hooks for wildcard matchers", () => {
			registerHook(
				"PreToolUse",
				{
					type: "callback",
					callback: async () => null,
				},
				"*",
			);

			const config = loadHookConfiguration("/tmp/test");

			const input: PreToolUseHookInput = {
				hook_event_name: "PreToolUse",
				cwd: "/tmp/test",
				timestamp: new Date().toISOString(),
				tool_name: "anything",
				tool_call_id: "test-1",
				tool_input: {},
			};

			const hooks = getMatchingHooks(config, input);
			expect(hooks).toHaveLength(1);
		});
	});

	describe("parseHookOutput", () => {
		it("should parse valid JSON", () => {
			const output = parseHookOutput('{"continue": true}');
			expect(output).toEqual({ continue: true });
		});

		it("should return null for empty output", () => {
			expect(parseHookOutput("")).toBeNull();
			expect(parseHookOutput("   ")).toBeNull();
		});

		it("should extract JSON from mixed output", () => {
			const output = parseHookOutput(
				'Some text\n{"continue": false}\nMore text',
			);
			expect(output).toEqual({ continue: false });
		});

		it("should return null for invalid JSON", () => {
			expect(parseHookOutput("not json")).toBeNull();
		});
	});

	describe("validateHookOutput", () => {
		it("should validate valid output", () => {
			const result = validateHookOutput({
				continue: true,
				decision: "approve",
			});
			expect(result.valid).toBe(true);
		});

		it("should reject invalid continue type", () => {
			const result = validateHookOutput({ continue: "yes" });
			expect(result.valid).toBe(false);
		});

		it("should reject invalid decision", () => {
			const result = validateHookOutput({ decision: "maybe" });
			expect(result.valid).toBe(false);
		});

		it("should validate hookSpecificOutput", () => {
			const result = validateHookOutput({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "allow",
				},
			});
			expect(result.valid).toBe(true);
		});

		it("should reject invalid hookSpecificOutput", () => {
			const result = validateHookOutput({
				hookSpecificOutput: {
					hookEventName: "InvalidEvent",
				},
			});
			expect(result.valid).toBe(false);
		});
	});

	describe("safeParseHookOutput", () => {
		it("should return validated output", () => {
			const output = safeParseHookOutput('{"continue": true}');
			expect(output).toEqual({ continue: true });
		});

		it("should return null for invalid output", () => {
			const output = safeParseHookOutput('{"continue": "invalid"}');
			expect(output).toBeNull();
		});
	});

	describe("isAsyncHookResponse", () => {
		it("should identify async response", () => {
			expect(isAsyncHookResponse({ async: true, processId: "test-123" })).toBe(
				true,
			);
		});

		it("should reject non-async responses", () => {
			expect(isAsyncHookResponse({ continue: true })).toBe(false);
			expect(isAsyncHookResponse(null)).toBe(false);
			expect(isAsyncHookResponse("string")).toBe(false);
		});
	});

	describe("createHookMessage", () => {
		it("should create success message", () => {
			const msg = createHookMessage({
				type: "hook_success",
				hookName: "test-hook",
				hookEvent: "PreToolUse",
				toolUseID: "tool-1",
			});

			expect(msg.type).toBe("hook_success");
			expect(msg.hookName).toBe("test-hook");
			expect(msg.hookEvent).toBe("PreToolUse");
			expect(msg.toolUseID).toBe("tool-1");
		});

		it("should create blocking error message", () => {
			const msg = createHookMessage({
				type: "hook_blocking_error",
				hookName: "validator",
				hookEvent: "PreToolUse",
				blockingError: {
					blockingError: "Dangerous command detected",
					command: "rm -rf /",
				},
			});

			expect(msg.type).toBe("hook_blocking_error");
			expect(msg.blockingError?.blockingError).toBe(
				"Dangerous command detected",
			);
		});
	});

	describe("executeHook with callback", () => {
		it("should execute callback hook and return result", async () => {
			const result = await executeHook(
				{
					type: "callback",
					callback: async () => ({
						continue: true,
						hookSpecificOutput: {
							hookEventName: "PreToolUse",
							permissionDecision: "allow",
						},
					}),
				},
				{
					hook_event_name: "PreToolUse",
					cwd: "/tmp/test",
					timestamp: new Date().toISOString(),
					tool_name: "bash",
					tool_call_id: "test-1",
					tool_input: { command: "ls" },
				},
			);

			expect(result).not.toBeNull();
			expect(result?.permissionBehavior).toBe("allow");
		});

		it("should handle blocking callback", async () => {
			const result = await executeHook(
				{
					type: "callback",
					callback: async () => ({
						decision: "block",
						reason: "Not allowed",
					}),
				},
				{
					hook_event_name: "PreToolUse",
					cwd: "/tmp/test",
					timestamp: new Date().toISOString(),
					tool_name: "bash",
					tool_call_id: "test-1",
					tool_input: { command: "rm -rf /" },
				},
			);

			expect(result).not.toBeNull();
			expect(result?.permissionBehavior).toBe("deny");
			expect(result?.blockingError?.blockingError).toBe("Not allowed");
		});

		it("should handle null callback result", async () => {
			const result = await executeHook(
				{
					type: "callback",
					callback: async () => null,
				},
				{
					hook_event_name: "PreToolUse",
					cwd: "/tmp/test",
					timestamp: new Date().toISOString(),
					tool_name: "bash",
					tool_call_id: "test-1",
					tool_input: {},
				},
			);

			expect(result).toBeNull();
		});

		it("should handle callback errors gracefully", async () => {
			const result = await executeHook(
				{
					type: "callback",
					callback: async () => {
						throw new Error("Callback failed");
					},
				},
				{
					hook_event_name: "PreToolUse",
					cwd: "/tmp/test",
					timestamp: new Date().toISOString(),
					tool_name: "bash",
					tool_call_id: "test-1",
					tool_input: {},
				},
			);

			expect(result).toBeNull();
		});
	});

	describe("ToolHookService", () => {
		it("should create service with context", () => {
			const service = createToolHookService({
				cwd: "/tmp/test",
				sessionId: "session-1",
			});

			expect(service).toBeDefined();
			expect(service.runPreToolUseHooks).toBeDefined();
			expect(service.runPostToolUseHooks).toBeDefined();
			expect(service.runPostToolUseFailureHooks).toBeDefined();
		});

		it("should run PreToolUse hooks and aggregate results", async () => {
			registerHook("PreToolUse", {
				type: "callback",
				callback: async () => ({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "allow",
					},
				}),
			});

			const service = createToolHookService({
				cwd: "/tmp/test",
				sessionId: "session-1",
			});

			const result = await service.runPreToolUseHooks({
				type: "toolCall",
				id: "test-1",
				name: "bash",
				arguments: { command: "ls" },
			});

			expect(result.blocked).toBe(false);
			expect(result.hookResults).toHaveLength(1);
		});

		it("should block on deny decision", async () => {
			registerHook("PreToolUse", {
				type: "callback",
				callback: async () => ({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "deny",
						permissionDecisionReason: "Security policy",
					},
				}),
			});

			const service = createToolHookService({
				cwd: "/tmp/test",
			});

			const result = await service.runPreToolUseHooks({
				type: "toolCall",
				id: "test-1",
				name: "bash",
				arguments: { command: "rm -rf /" },
			});

			expect(result.blocked).toBe(true);
			expect(result.blockReason).toBe("Security policy");
		});

		it("should collect updated input from hooks", async () => {
			registerHook("PreToolUse", {
				type: "callback",
				callback: async () => ({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						updatedInput: { command: "ls -la" },
					},
				}),
			});

			const service = createToolHookService({
				cwd: "/tmp/test",
			});

			const result = await service.runPreToolUseHooks({
				type: "toolCall",
				id: "test-1",
				name: "bash",
				arguments: { command: "ls" },
			});

			expect(result.updatedInput).toEqual({ command: "ls -la" });
		});
	});

	describe("SessionHookService", () => {
		it("should create service with context", () => {
			const service = createSessionHookService({
				cwd: "/tmp/test",
				sessionId: "session-1",
				userId: "user-1",
				orgId: "org-1",
			});

			expect(service).toBeDefined();
			expect(service.runSessionStartHooks).toBeDefined();
			expect(service.runSessionEndHooks).toBeDefined();
			expect(service.runSubagentStartHooks).toBeDefined();
			expect(service.runUserPromptSubmitHooks).toBeDefined();
		});

		it("should run SessionStart hooks", async () => {
			registerHook(
				"SessionStart",
				{
					type: "callback",
					callback: async () => ({
						hookSpecificOutput: {
							hookEventName: "SessionStart",
							additionalContext: "Welcome to the session!",
						},
					}),
				},
				"interactive",
			);

			const service = createSessionHookService({
				cwd: "/tmp/test",
				sessionId: "session-1",
			});

			const result = await service.runSessionStartHooks("interactive");

			expect(result.blocked).toBe(false);
			expect(result.additionalContext).toBe("Welcome to the session!");
		});

		it("should run UserPromptSubmit hooks and inject context", async () => {
			registerHook("UserPromptSubmit", {
				type: "callback",
				callback: async () => ({
					hookSpecificOutput: {
						hookEventName: "UserPromptSubmit",
						additionalContext:
							"Note: This project uses TypeScript strict mode.",
					},
				}),
			});

			const service = createSessionHookService({
				cwd: "/tmp/test",
			});

			const result = await service.runUserPromptSubmitHooks("Fix the bug", 0);

			expect(result.additionalContext).toBe(
				"Note: This project uses TypeScript strict mode.",
			);
		});

		it("should check if hooks exist", () => {
			const service = createSessionHookService({
				cwd: "/tmp/test",
			});

			expect(service.hasHooks("SessionStart")).toBe(false);

			registerHook("SessionStart", {
				type: "callback",
				callback: async () => null,
			});

			clearHookConfigCache();
			expect(service.hasHooks("SessionStart")).toBe(true);
		});
	});

	describe("Hook Output Processing", () => {
		it("should handle continue: false", async () => {
			const result = await executeHook(
				{
					type: "callback",
					callback: async () => ({
						continue: false,
						stopReason: "Rate limit exceeded",
					}),
				},
				{
					hook_event_name: "PreToolUse",
					cwd: "/tmp/test",
					timestamp: new Date().toISOString(),
					tool_name: "bash",
					tool_call_id: "test-1",
					tool_input: {},
				},
			);

			expect(result?.preventContinuation).toBe(true);
			expect(result?.stopReason).toBe("Rate limit exceeded");
		});

		it("should handle system message injection", async () => {
			const result = await executeHook(
				{
					type: "callback",
					callback: async () => ({
						systemMessage: "Remember to follow the coding guidelines.",
					}),
				},
				{
					hook_event_name: "PreToolUse",
					cwd: "/tmp/test",
					timestamp: new Date().toISOString(),
					tool_name: "bash",
					tool_call_id: "test-1",
					tool_input: {},
				},
			);

			expect(result?.systemMessage).toBe(
				"Remember to follow the coding guidelines.",
			);
		});

		it("should handle PostToolUse additionalContext", async () => {
			registerHook("PostToolUse", {
				type: "callback",
				callback: async () => ({
					hookSpecificOutput: {
						hookEventName: "PostToolUse",
						additionalContext: "Note: File was modified successfully.",
					},
				}),
			});

			const service = createToolHookService({
				cwd: "/tmp/test",
			});

			const result = await service.runPostToolUseHooks(
				{
					type: "toolCall",
					id: "test-1",
					name: "edit",
					arguments: { file: "test.ts" },
				},
				{
					role: "toolResult",
					toolCallId: "test-1",
					toolName: "edit",
					content: [{ type: "text", text: "File edited" }],
					isError: false,
					timestamp: Date.now(),
				},
			);

			expect(result.additionalContext).toBe(
				"Note: File was modified successfully.",
			);
		});
	});
});
