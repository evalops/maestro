/**
 * Example TypeScript Hook for Composer
 *
 * This demonstrates how to write a TypeScript hook that:
 * 1. Intercepts tool execution events
 * 2. Logs activity to a file
 * 3. Optionally blocks certain operations
 * 4. Injects messages via pi.send()
 *
 * To use this hook:
 * 1. Copy to ~/.composer/hooks/example-hook.ts
 * 2. Restart Composer
 *
 * The hook will be automatically discovered and loaded.
 */

import type { HookAPI } from "../../src/hooks/types.js";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

// Log file for tracking agent activity
const LOG_FILE = join(process.env.HOME || "~", ".composer", "hook-activity.log");

function log(message: string) {
	const timestamp = new Date().toISOString();
	appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
}

export default function (pi: HookAPI) {
	// Log when sessions start
	pi.on("SessionStart", async (event, ctx) => {
		log(`Session started in ${ctx.cwd}`);
		return undefined;
	});

	// Intercept tool calls before execution
	pi.on("PreToolUse", async (event, ctx) => {
		if (event.hook_event_name !== "PreToolUse") return undefined;

		const toolName = event.tool_name;
		const input = JSON.stringify(event.tool_input).slice(0, 100);

		log(`Tool: ${toolName} - Input: ${input}...`);

		// Example: Block rm -rf commands in Bash
		if (toolName === "Bash") {
			const command = (event.tool_input as { command?: string }).command;
			if (command?.includes("rm -rf /")) {
				log(`BLOCKED: Dangerous rm -rf command`);
				return {
					continue: false,
					decision: "block",
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						blockReason: "Dangerous rm -rf / command blocked by hook",
					},
				};
			}
		}

		// Example: Add context to Read operations
		if (toolName === "Read") {
			return {
				continue: true,
				decision: "approve",
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					additionalContext:
						"[Hook note: File read logged for audit purposes]",
				},
			};
		}

		return undefined;
	});

	// Log tool results
	pi.on("PostToolUse", async (event, ctx) => {
		if (event.hook_event_name !== "PostToolUse") return undefined;

		const toolName = event.tool_name;
		const isError = event.is_error;

		log(`Tool ${toolName} completed ${isError ? "(ERROR)" : "(OK)"}`);

		// Example: Send a reminder after certain tools
		if (toolName === "Write" && !isError) {
			// Use pi.send() to inject a reminder message
			// This will be processed after the current turn
			// pi.send("Remember to run tests after modifying files!");
		}

		return undefined;
	});

	// Log session end
	pi.on("SessionEnd", async (event, ctx) => {
		log(`Session ended`);
		return undefined;
	});
}
