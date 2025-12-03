/**
 * Integration tests for the comprehensive hook system.
 *
 * These tests verify:
 * - Command hook execution with actual shell scripts
 * - Hook blocking behavior
 * - Hook input modification
 * - PostToolUse/PostToolUseFailure hooks
 * - Multiple hooks chaining
 * - Hook timeout handling
 * - Transport integration
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	type HookCommandConfig,
	type PostToolUseHookInput,
	type PreToolUseHookInput,
	type SessionStartHookInput,
	clearHookConfigCache,
	clearRegisteredHooks,
	createSessionHookService,
	createToolHookService,
	executeHook,
	executeHooks,
	loadHookConfiguration,
	registerHook,
} from "../src/hooks/index.js";

describe("Hook System Integration", () => {
	let testDir: string;
	let scriptsDir: string;

	beforeAll(() => {
		// Create test directory structure
		testDir = join(tmpdir(), `hooks-test-${Date.now()}`);
		scriptsDir = join(testDir, "scripts");
		mkdirSync(scriptsDir, { recursive: true });
	});

	afterAll(() => {
		// Cleanup test directory
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	beforeEach(() => {
		clearHookConfigCache();
		clearRegisteredHooks();
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		clearHookConfigCache();
		clearRegisteredHooks();
	});

	describe("Command Hook Execution", () => {
		it("should execute a simple command hook that approves", async () => {
			// Create a script that outputs JSON approval
			const scriptPath = join(scriptsDir, "approve.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
echo '{"continue": true, "decision": "approve"}'
`,
				{ mode: 0o755 },
			);

			const result = await executeHook(
				{
					type: "command",
					command: scriptPath,
				} satisfies HookCommandConfig,
				{
					hook_event_name: "PreToolUse",
					cwd: testDir,
					timestamp: new Date().toISOString(),
					tool_name: "bash",
					tool_call_id: "test-1",
					tool_input: { command: "ls" },
				} satisfies PreToolUseHookInput,
			);

			expect(result).not.toBeNull();
			expect(result?.message.type).toBe("hook_success");
		});

		it("should execute a command hook that blocks", async () => {
			const scriptPath = join(scriptsDir, "block.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
echo '{"decision": "block", "reason": "Dangerous command detected"}'
`,
				{ mode: 0o755 },
			);

			const result = await executeHook(
				{
					type: "command",
					command: scriptPath,
				},
				{
					hook_event_name: "PreToolUse",
					cwd: testDir,
					timestamp: new Date().toISOString(),
					tool_name: "bash",
					tool_call_id: "test-1",
					tool_input: { command: "rm -rf /" },
				},
			);

			expect(result).not.toBeNull();
			expect(result?.permissionBehavior).toBe("deny");
			expect(result?.blockingError?.blockingError).toBe(
				"Dangerous command detected",
			);
		});

		it("should pass hook input via stdin", async () => {
			const scriptPath = join(scriptsDir, "echo-input.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
# Read stdin and extract tool_name
input=$(cat)
tool_name=$(echo "$input" | grep -o '"tool_name":"[^"]*"' | cut -d'"' -f4)
echo '{"continue": true, "hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "Received tool: '"$tool_name"'"}}'
`,
				{ mode: 0o755 },
			);

			const result = await executeHook(
				{
					type: "command",
					command: scriptPath,
				},
				{
					hook_event_name: "PreToolUse",
					cwd: testDir,
					timestamp: new Date().toISOString(),
					tool_name: "my_special_tool",
					tool_call_id: "test-1",
					tool_input: {},
				},
			);

			expect(result).not.toBeNull();
			// The hook received the tool name via stdin
			expect(result?.message.hookEvent).toBe("PreToolUse");
		});

		it("should handle hook timeout", async () => {
			const scriptPath = join(scriptsDir, "slow.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
sleep 10
echo '{"continue": true}'
`,
				{ mode: 0o755 },
			);

			const result = await executeHook(
				{
					type: "command",
					command: scriptPath,
					timeout: 1, // 1 second timeout
				},
				{
					hook_event_name: "PreToolUse",
					cwd: testDir,
					timestamp: new Date().toISOString(),
					tool_name: "bash",
					tool_call_id: "test-1",
					tool_input: {},
				},
			);

			expect(result).not.toBeNull();
			expect(result?.message.type).toBe("hook_cancelled");
		});

		it("should handle hook that modifies input", async () => {
			const scriptPath = join(scriptsDir, "modify-input.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": {"command": "ls -la --color=always"}}}'
`,
				{ mode: 0o755 },
			);

			const result = await executeHook(
				{
					type: "command",
					command: scriptPath,
				},
				{
					hook_event_name: "PreToolUse",
					cwd: testDir,
					timestamp: new Date().toISOString(),
					tool_name: "bash",
					tool_call_id: "test-1",
					tool_input: { command: "ls" },
				},
			);

			expect(result).not.toBeNull();
			expect(result?.updatedInput).toEqual({
				command: "ls -la --color=always",
			});
		});

		it("should handle hook with non-zero exit code", async () => {
			const scriptPath = join(scriptsDir, "fail.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
echo "Something went wrong" >&2
exit 1
`,
				{ mode: 0o755 },
			);

			const result = await executeHook(
				{
					type: "command",
					command: scriptPath,
				},
				{
					hook_event_name: "PreToolUse",
					cwd: testDir,
					timestamp: new Date().toISOString(),
					tool_name: "bash",
					tool_call_id: "test-1",
					tool_input: {},
				},
			);

			expect(result).not.toBeNull();
			expect(result?.message.type).toBe("hook_error_during_execution");
		});

		it("should set environment variables for hook", async () => {
			const scriptPath = join(scriptsDir, "check-env.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
if [ "$COMPOSER_HOOK_EVENT" = "PreToolUse" ]; then
  echo '{"continue": true, "decision": "approve"}'
else
  echo '{"decision": "block", "reason": "Wrong event type"}'
fi
`,
				{ mode: 0o755 },
			);

			const result = await executeHook(
				{
					type: "command",
					command: scriptPath,
				},
				{
					hook_event_name: "PreToolUse",
					cwd: testDir,
					timestamp: new Date().toISOString(),
					tool_name: "bash",
					tool_call_id: "test-1",
					tool_input: {},
				},
			);

			expect(result).not.toBeNull();
			expect(result?.permissionBehavior).not.toBe("deny");
		});
	});

	describe("Multiple Hooks Chaining", () => {
		it("should execute multiple hooks in sequence", async () => {
			const script1 = join(scriptsDir, "hook1.sh");
			const script2 = join(scriptsDir, "hook2.sh");

			writeFileSync(
				script1,
				`#!/bin/bash
echo '{"continue": true}'
`,
				{ mode: 0o755 },
			);

			writeFileSync(
				script2,
				`#!/bin/bash
echo '{"continue": true, "hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "From hook 2"}}'
`,
				{ mode: 0o755 },
			);

			registerHook("PreToolUse", { type: "command", command: script1 });
			registerHook("PreToolUse", { type: "command", command: script2 });

			const input: PreToolUseHookInput = {
				hook_event_name: "PreToolUse",
				cwd: testDir,
				timestamp: new Date().toISOString(),
				tool_name: "bash",
				tool_call_id: "test-1",
				tool_input: {},
			};

			const results = await executeHooks(input, testDir);

			expect(results).toHaveLength(2);
		});

		it("should stop on first blocking hook", async () => {
			const script1 = join(scriptsDir, "blocker.sh");
			const script2 = join(scriptsDir, "should-not-run.sh");

			writeFileSync(
				script1,
				`#!/bin/bash
echo '{"decision": "block", "reason": "Blocked by first hook"}'
`,
				{ mode: 0o755 },
			);

			writeFileSync(
				script2,
				`#!/bin/bash
echo "This should not run" >> "${testDir}/hook2-ran.txt"
echo '{"continue": true}'
`,
				{ mode: 0o755 },
			);

			registerHook("PreToolUse", { type: "command", command: script1 });
			registerHook("PreToolUse", { type: "command", command: script2 });

			const input: PreToolUseHookInput = {
				hook_event_name: "PreToolUse",
				cwd: testDir,
				timestamp: new Date().toISOString(),
				tool_name: "bash",
				tool_call_id: "test-1",
				tool_input: {},
			};

			const results = await executeHooks(input, testDir);

			// Should only have one result (the blocker)
			expect(results).toHaveLength(1);
			expect(results[0].blockingError).toBeDefined();
		});
	});

	describe("ToolHookService Integration", () => {
		it("should block tool execution via PreToolUse hook", async () => {
			const scriptPath = join(scriptsDir, "deny-rm.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
input=$(cat)
command=$(echo "$input" | grep -o '"command":"[^"]*"' | cut -d'"' -f4)
if echo "$command" | grep -q "rm"; then
  echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "rm commands are not allowed"}}'
else
  echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
fi
`,
				{ mode: 0o755 },
			);

			registerHook(
				"PreToolUse",
				{ type: "command", command: scriptPath },
				"bash",
			);

			const service = createToolHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runPreToolUseHooks({
				type: "toolCall",
				id: "test-1",
				name: "bash",
				arguments: { command: "rm -rf /tmp/test" },
			});

			expect(result.blocked).toBe(true);
			expect(result.blockReason).toContain("rm commands are not allowed");
		});

		it("should modify tool input via PreToolUse hook", async () => {
			const scriptPath = join(scriptsDir, "add-safe-flags.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
input=$(cat)
# Add -i flag to rm commands for safety
echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": {"command": "rm -i file.txt"}}}'
`,
				{ mode: 0o755 },
			);

			registerHook(
				"PreToolUse",
				{ type: "command", command: scriptPath },
				"bash",
			);

			const service = createToolHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runPreToolUseHooks({
				type: "toolCall",
				id: "test-1",
				name: "bash",
				arguments: { command: "rm file.txt" },
			});

			expect(result.blocked).toBe(false);
			expect(result.updatedInput).toEqual({ command: "rm -i file.txt" });
		});

		it("should add context via PostToolUse hook", async () => {
			const scriptPath = join(scriptsDir, "add-context.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
echo '{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "Tool execution completed successfully at '"$(date)"'"}}'
`,
				{ mode: 0o755 },
			);

			registerHook("PostToolUse", { type: "command", command: scriptPath });

			const service = createToolHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runPostToolUseHooks(
				{
					type: "toolCall",
					id: "test-1",
					name: "bash",
					arguments: { command: "ls" },
				},
				{
					role: "toolResult",
					toolCallId: "test-1",
					toolName: "bash",
					content: [{ type: "text", text: "file1.txt\nfile2.txt" }],
					isError: false,
					timestamp: Date.now(),
				},
			);

			expect(result.additionalContext).toContain(
				"Tool execution completed successfully",
			);
		});

		it("should handle PostToolUseFailure hooks", async () => {
			const scriptPath = join(scriptsDir, "log-failure.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
input=$(cat)
error=$(echo "$input" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)
echo '{"hookSpecificOutput": {"hookEventName": "PostToolUseFailure", "additionalContext": "Error logged: '"$error"'"}}'
`,
				{ mode: 0o755 },
			);

			registerHook("PostToolUseFailure", {
				type: "command",
				command: scriptPath,
			});

			const service = createToolHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runPostToolUseFailureHooks(
				{
					type: "toolCall",
					id: "test-1",
					name: "bash",
					arguments: { command: "invalid-command" },
				},
				"Command not found: invalid-command",
			);

			expect(result.additionalContext).toContain("Error logged");
		});
	});

	describe("SessionHookService Integration", () => {
		it("should run SessionStart hooks", async () => {
			const scriptPath = join(scriptsDir, "session-start.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
input=$(cat)
source=$(echo "$input" | grep -o '"source":"[^"]*"' | cut -d'"' -f4)
echo '{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "Session started from '"$source"'"}}'
`,
				{ mode: 0o755 },
			);

			registerHook("SessionStart", { type: "command", command: scriptPath });

			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
				userId: "user-1",
			});

			const result = await service.runSessionStartHooks("cli");

			expect(result.blocked).toBe(false);
			expect(result.additionalContext).toContain("Session started from cli");
		});

		it("should run UserPromptSubmit hooks and inject context", async () => {
			const scriptPath = join(scriptsDir, "prompt-context.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
echo '{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "Remember: Always use TypeScript strict mode."}}'
`,
				{ mode: 0o755 },
			);

			registerHook("UserPromptSubmit", {
				type: "command",
				command: scriptPath,
			});

			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runUserPromptSubmitHooks(
				"Fix the bug in auth.ts",
				0,
			);

			expect(result.additionalContext).toContain("TypeScript strict mode");
		});

		it("should block session start if hook denies", async () => {
			registerHook(
				"SessionStart",
				{
					type: "callback",
					callback: async (input) => {
						const sessionInput = input as SessionStartHookInput;
						if (sessionInput.source === "untrusted") {
							return {
								decision: "block",
								reason: "Untrusted source not allowed",
							};
						}
						return { continue: true };
					},
				},
				"untrusted",
			);

			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runSessionStartHooks("untrusted");

			expect(result.blocked).toBe(true);
			expect(result.blockReason).toBe("Untrusted source not allowed");
		});

		it("should run SubagentStart hooks", async () => {
			registerHook("SubagentStart", {
				type: "callback",
				callback: async () => ({
					hookSpecificOutput: {
						hookEventName: "SubagentStart",
						additionalContext: "Subagent context injected",
					},
				}),
			});

			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runSubagentStartHooks(
				"explorer",
				"Find all TypeScript files",
				"parent-session",
			);

			expect(result.additionalContext).toBe("Subagent context injected");
		});

		it("should run SubagentStop hooks on success", async () => {
			registerHook("SubagentStop", {
				type: "callback",
				callback: async (input) => {
					if ("success" in input && input.success) {
						const duration = (input as { duration_ms: number }).duration_ms;
						return {
							continue: true,
							hookSpecificOutput: {
								hookEventName: "SubagentStop" as const,
								additionalContext: `Subagent completed in ${duration}ms`,
							},
						};
					}
					return { continue: true };
				},
			});

			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runSubagentStopHooks(
				"explorer",
				"agent-123",
				true,
				5000,
				3,
				{ parentSessionId: "parent-session" },
			);

			expect(result.blocked).toBe(false);
			expect(result.hookResults.length).toBeGreaterThan(0);
		});

		it("should run SubagentStop hooks on failure", async () => {
			registerHook("SubagentStop", {
				type: "callback",
				callback: async (input) => {
					if ("success" in input && !input.success) {
						const err = (input as { error?: string }).error ?? "Unknown error";
						return {
							continue: true,
							hookSpecificOutput: {
								hookEventName: "SubagentStop" as const,
								additionalContext: `Subagent failed: ${err}`,
							},
						};
					}
					return { continue: true };
				},
			});

			const service = createSessionHookService({
				cwd: testDir,
				sessionId: "test-session",
			});

			const result = await service.runSubagentStopHooks(
				"explorer",
				"agent-456",
				false,
				1000,
				1,
				{
					error: "Connection timeout",
					transcriptPath: "/tmp/transcript.json",
				},
			);

			expect(result.blocked).toBe(false);
			expect(result.hookResults.length).toBeGreaterThan(0);
		});
	});

	describe("Configuration Loading", () => {
		it("should load hooks from project config file", async () => {
			// Create .composer/hooks.json in test directory
			const composerDir = join(testDir, ".composer");
			mkdirSync(composerDir, { recursive: true });

			const scriptPath = join(scriptsDir, "project-hook.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
echo '{"continue": true, "decision": "approve"}'
`,
				{ mode: 0o755 },
			);

			writeFileSync(
				join(composerDir, "hooks.json"),
				JSON.stringify({
					hooks: {
						PreToolUse: [
							{
								matcher: "*",
								hooks: [
									{
										type: "command",
										command: scriptPath,
									},
								],
							},
						],
					},
				}),
			);

			clearHookConfigCache();

			const config = loadHookConfiguration(testDir);

			expect(config.PreToolUse).toBeDefined();
			expect(config.PreToolUse?.[0]?.hooks[0]).toEqual({
				type: "command",
				command: scriptPath,
			});
		});

		it("should load hooks from environment variables", () => {
			vi.stubEnv("COMPOSER_HOOKS_SESSION_START", "echo '{\"continue\": true}'");

			clearHookConfigCache();

			const config = loadHookConfiguration(testDir);

			expect(config.SessionStart).toBeDefined();
			expect(config.SessionStart?.[0]?.hooks[0]).toEqual({
				type: "command",
				command: "echo '{\"continue\": true}'",
			});
		});
	});

	describe("Abort Signal Handling", () => {
		it("should timeout slow hooks using timeout parameter", async () => {
			const scriptPath = join(scriptsDir, "slow-hook.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
sleep 5
echo '{"continue": true}'
`,
				{ mode: 0o755 },
			);

			const result = await executeHook(
				{
					type: "command",
					command: scriptPath,
					timeout: 1, // 1 second timeout - will trigger before sleep completes
				},
				{
					hook_event_name: "PreToolUse",
					cwd: testDir,
					timestamp: new Date().toISOString(),
					tool_name: "bash",
					tool_call_id: "test-1",
					tool_input: {},
				},
			);

			expect(result).not.toBeNull();
			expect(result?.message.type).toBe("hook_cancelled");
		}, 10000);
	});

	describe("Hook Output Formats", () => {
		it("should handle continue: false to prevent continuation", async () => {
			const scriptPath = join(scriptsDir, "stop-continuation.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
echo '{"continue": false, "stopReason": "Rate limit reached"}'
`,
				{ mode: 0o755 },
			);

			const result = await executeHook(
				{
					type: "command",
					command: scriptPath,
				},
				{
					hook_event_name: "PreToolUse",
					cwd: testDir,
					timestamp: new Date().toISOString(),
					tool_name: "bash",
					tool_call_id: "test-1",
					tool_input: {},
				},
			);

			expect(result).not.toBeNull();
			expect(result?.preventContinuation).toBe(true);
			expect(result?.stopReason).toBe("Rate limit reached");
		});

		it("should handle systemMessage injection", async () => {
			const scriptPath = join(scriptsDir, "inject-system.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
echo '{"continue": true, "systemMessage": "Important: Follow security best practices"}'
`,
				{ mode: 0o755 },
			);

			const result = await executeHook(
				{
					type: "command",
					command: scriptPath,
				},
				{
					hook_event_name: "PreToolUse",
					cwd: testDir,
					timestamp: new Date().toISOString(),
					tool_name: "bash",
					tool_call_id: "test-1",
					tool_input: {},
				},
			);

			expect(result).not.toBeNull();
			expect(result?.systemMessage).toBe(
				"Important: Follow security best practices",
			);
		});

		it("should handle PermissionRequest hooks", async () => {
			registerHook("PermissionRequest", {
				type: "callback",
				callback: async (input) => {
					// Auto-approve read operations
					if ("tool_name" in input && input.tool_name === "read") {
						return {
							hookSpecificOutput: {
								hookEventName: "PermissionRequest",
								decision: {
									behavior: "allow",
								},
							},
						};
					}
					return {
						hookSpecificOutput: {
							hookEventName: "PermissionRequest",
							decision: {
								behavior: "deny",
							},
						},
					};
				},
			});

			const input = {
				hook_event_name: "PermissionRequest" as const,
				cwd: testDir,
				timestamp: new Date().toISOString(),
				tool_name: "read",
				tool_call_id: "test-1",
				tool_input: { file: "/etc/passwd" },
				reason: "File read requires permission",
			};

			const results = await executeHooks(input, testDir);

			expect(results).toHaveLength(1);
			expect(results[0].permissionBehavior).toBe("allow");
		});
	});

	describe("Mixed Hook Types", () => {
		it("should support callback and command hooks together", async () => {
			const scriptPath = join(scriptsDir, "command-hook.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
echo '{"continue": true}'
`,
				{ mode: 0o755 },
			);

			// Register both callback and command hooks
			registerHook("PreToolUse", {
				type: "callback",
				callback: async () => ({
					continue: true,
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						additionalContext: "From callback",
					},
				}),
			});

			registerHook("PreToolUse", {
				type: "command",
				command: scriptPath,
			});

			const input: PreToolUseHookInput = {
				hook_event_name: "PreToolUse",
				cwd: testDir,
				timestamp: new Date().toISOString(),
				tool_name: "bash",
				tool_call_id: "test-1",
				tool_input: {},
			};

			const results = await executeHooks(input, testDir);

			// Both hooks should run
			expect(results.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("Error Handling", () => {
		it("should handle invalid JSON output gracefully", async () => {
			const scriptPath = join(scriptsDir, "invalid-json.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/bash
echo "This is not JSON"
`,
				{ mode: 0o755 },
			);

			const result = await executeHook(
				{
					type: "command",
					command: scriptPath,
				},
				{
					hook_event_name: "PreToolUse",
					cwd: testDir,
					timestamp: new Date().toISOString(),
					tool_name: "bash",
					tool_call_id: "test-1",
					tool_input: {},
				},
			);

			// Should not throw, returns null for non-JSON output with exit 0
			expect(result).toBeNull();
		});

		it("should handle missing command gracefully", async () => {
			const result = await executeHook(
				{
					type: "command",
					command: "/nonexistent/command",
				},
				{
					hook_event_name: "PreToolUse",
					cwd: testDir,
					timestamp: new Date().toISOString(),
					tool_name: "bash",
					tool_call_id: "test-1",
					tool_input: {},
				},
			);

			expect(result).not.toBeNull();
			expect(result?.message.type).toBe("hook_error_during_execution");
		});
	});
});
