/**
 * Hook output parsing and validation.
 *
 * Parses JSON output from hook commands and validates against expected schema.
 */

import { createLogger } from "../utils/logger.js";
import type { HookJsonOutput, HookSpecificOutput } from "./types.js";

const logger = createLogger("hooks:output");

/**
 * Valid hook event names for hookSpecificOutput.
 */
const VALID_HOOK_EVENT_NAMES = new Set([
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"SessionStart",
	"SessionEnd",
	"SubagentStart",
	"SubagentStop",
	"UserPromptSubmit",
	"Notification",
	"PreCompact",
	"PermissionRequest",
]);

/**
 * Valid permission decisions.
 */
const VALID_PERMISSION_DECISIONS = new Set(["allow", "deny", "ask"]);

/**
 * Valid decision values.
 */
const VALID_DECISIONS = new Set(["approve", "block"]);

/**
 * Attempt to parse hook output as JSON.
 */
export function parseHookOutput(stdout: string): unknown | null {
	const trimmed = stdout.trim();

	if (!trimmed) {
		return null;
	}

	try {
		return JSON.parse(trimmed);
	} catch {
		// Try to extract JSON from output that might have other content
		const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			try {
				return JSON.parse(jsonMatch[0]);
			} catch {
				logger.debug("Failed to parse JSON from hook output", {
					output: trimmed.slice(0, 200),
				});
				return null;
			}
		}
		return null;
	}
}

/**
 * Validate that a parsed object conforms to HookJsonOutput schema.
 */
export function validateHookOutput(
	parsed: unknown,
): { valid: true; output: HookJsonOutput } | { valid: false; error: string } {
	if (typeof parsed !== "object" || parsed === null) {
		return { valid: false, error: "Hook output must be a JSON object" };
	}

	const obj = parsed as Record<string, unknown>;

	// Validate continue field
	if ("continue" in obj && typeof obj.continue !== "boolean") {
		return { valid: false, error: "continue must be a boolean" };
	}

	// Validate stopReason field
	if ("stopReason" in obj && typeof obj.stopReason !== "string") {
		return { valid: false, error: "stopReason must be a string" };
	}

	// Validate suppressOutput field
	if ("suppressOutput" in obj && typeof obj.suppressOutput !== "boolean") {
		return { valid: false, error: "suppressOutput must be a boolean" };
	}

	// Validate decision field
	if ("decision" in obj) {
		if (typeof obj.decision !== "string") {
			return { valid: false, error: "decision must be a string" };
		}
		if (!VALID_DECISIONS.has(obj.decision)) {
			return {
				valid: false,
				error: `decision must be one of: ${[...VALID_DECISIONS].join(", ")}`,
			};
		}
	}

	// Validate reason field
	if ("reason" in obj && typeof obj.reason !== "string") {
		return { valid: false, error: "reason must be a string" };
	}

	// Validate systemMessage field
	if ("systemMessage" in obj && typeof obj.systemMessage !== "string") {
		return { valid: false, error: "systemMessage must be a string" };
	}

	// Validate permissionDecision field
	if ("permissionDecision" in obj) {
		if (typeof obj.permissionDecision !== "string") {
			return { valid: false, error: "permissionDecision must be a string" };
		}
		if (!VALID_PERMISSION_DECISIONS.has(obj.permissionDecision)) {
			return {
				valid: false,
				error: `permissionDecision must be one of: ${[...VALID_PERMISSION_DECISIONS].join(", ")}`,
			};
		}
	}

	// Validate hookSpecificOutput field
	if ("hookSpecificOutput" in obj) {
		const specificResult = validateHookSpecificOutput(obj.hookSpecificOutput);
		if (!specificResult.valid) {
			return specificResult;
		}
	}

	return { valid: true, output: obj as HookJsonOutput };
}

/**
 * Validate hookSpecificOutput field.
 */
function validateHookSpecificOutput(
	specific: unknown,
): { valid: true } | { valid: false; error: string } {
	if (typeof specific !== "object" || specific === null) {
		return { valid: false, error: "hookSpecificOutput must be an object" };
	}

	const obj = specific as Record<string, unknown>;

	// hookEventName is required
	if (!("hookEventName" in obj)) {
		return {
			valid: false,
			error: "hookSpecificOutput.hookEventName is required",
		};
	}

	if (
		typeof obj.hookEventName !== "string" ||
		!VALID_HOOK_EVENT_NAMES.has(obj.hookEventName)
	) {
		return {
			valid: false,
			error: `hookSpecificOutput.hookEventName must be one of: ${[...VALID_HOOK_EVENT_NAMES].join(", ")}`,
		};
	}

	// Validate based on event type
	switch (obj.hookEventName) {
		case "PreToolUse":
			return validatePreToolUseOutput(obj);
		case "PostToolUse":
			return validatePostToolUseOutput(obj);
		case "PostToolUseFailure":
		case "SessionStart":
		case "SubagentStart":
			return validateContextOutput(obj);
		case "UserPromptSubmit":
			return validateUserPromptSubmitOutput(obj);
		case "PermissionRequest":
			return validatePermissionRequestOutput(obj);
		default:
			return { valid: true };
	}
}

/**
 * Validate PreToolUse hook-specific output.
 */
function validatePreToolUseOutput(
	obj: Record<string, unknown>,
): { valid: true } | { valid: false; error: string } {
	if ("permissionDecision" in obj) {
		if (
			typeof obj.permissionDecision !== "string" ||
			!VALID_PERMISSION_DECISIONS.has(obj.permissionDecision)
		) {
			return {
				valid: false,
				error: `hookSpecificOutput.permissionDecision must be one of: ${[...VALID_PERMISSION_DECISIONS].join(", ")}`,
			};
		}
	}

	if (
		"permissionDecisionReason" in obj &&
		typeof obj.permissionDecisionReason !== "string"
	) {
		return {
			valid: false,
			error: "hookSpecificOutput.permissionDecisionReason must be a string",
		};
	}

	if ("updatedInput" in obj) {
		if (typeof obj.updatedInput !== "object" || obj.updatedInput === null) {
			return {
				valid: false,
				error: "hookSpecificOutput.updatedInput must be an object",
			};
		}
	}

	return { valid: true };
}

/**
 * Validate PostToolUse hook-specific output.
 */
function validatePostToolUseOutput(
	obj: Record<string, unknown>,
): { valid: true } | { valid: false; error: string } {
	if ("additionalContext" in obj && typeof obj.additionalContext !== "string") {
		return {
			valid: false,
			error: "hookSpecificOutput.additionalContext must be a string",
		};
	}

	// updatedMCPToolOutput can be any type, no validation needed

	return { valid: true };
}

/**
 * Validate output with additionalContext field.
 */
function validateContextOutput(
	obj: Record<string, unknown>,
): { valid: true } | { valid: false; error: string } {
	if ("additionalContext" in obj && typeof obj.additionalContext !== "string") {
		return {
			valid: false,
			error: "hookSpecificOutput.additionalContext must be a string",
		};
	}

	return { valid: true };
}

/**
 * Validate UserPromptSubmit hook-specific output.
 */
function validateUserPromptSubmitOutput(
	obj: Record<string, unknown>,
): { valid: true } | { valid: false; error: string } {
	// additionalContext is required for UserPromptSubmit
	if (!("additionalContext" in obj)) {
		return {
			valid: false,
			error:
				"hookSpecificOutput.additionalContext is required for UserPromptSubmit",
		};
	}

	if (typeof obj.additionalContext !== "string") {
		return {
			valid: false,
			error: "hookSpecificOutput.additionalContext must be a string",
		};
	}

	return { valid: true };
}

/**
 * Validate PermissionRequest hook-specific output.
 */
function validatePermissionRequestOutput(
	obj: Record<string, unknown>,
): { valid: true } | { valid: false; error: string } {
	if ("decision" in obj) {
		if (typeof obj.decision !== "object" || obj.decision === null) {
			return {
				valid: false,
				error: "hookSpecificOutput.decision must be an object",
			};
		}

		const decision = obj.decision as Record<string, unknown>;

		if (!("behavior" in decision)) {
			return {
				valid: false,
				error: "hookSpecificOutput.decision.behavior is required",
			};
		}

		if (decision.behavior !== "allow" && decision.behavior !== "deny") {
			return {
				valid: false,
				error: 'hookSpecificOutput.decision.behavior must be "allow" or "deny"',
			};
		}

		if ("updatedInput" in decision) {
			if (
				typeof decision.updatedInput !== "object" ||
				decision.updatedInput === null
			) {
				return {
					valid: false,
					error: "hookSpecificOutput.decision.updatedInput must be an object",
				};
			}
		}
	}

	return { valid: true };
}

/**
 * Safely parse and validate hook output.
 */
export function safeParseHookOutput(stdout: string): HookJsonOutput | null {
	const parsed = parseHookOutput(stdout);
	if (!parsed) {
		return null;
	}

	const result = validateHookOutput(parsed);
	if (!result.valid) {
		logger.warn("Invalid hook output", { error: result.error });
		return null;
	}

	return result.output;
}

/**
 * Format hook output schema for documentation.
 */
export function getHookOutputSchema(): string {
	return JSON.stringify(
		{
			continue: "boolean (optional) - if false, prevents continuation",
			suppressOutput: "boolean (optional) - suppress normal output display",
			stopReason: "string (optional) - reason for stopping",
			decision: '"approve" | "block" (optional) - legacy permission decision',
			reason: "string (optional) - reason for decision",
			systemMessage: "string (optional) - message to inject",
			permissionDecision:
				'"allow" | "deny" | "ask" (optional) - permission override',
			hookSpecificOutput: {
				"for PreToolUse": {
					hookEventName: '"PreToolUse"',
					permissionDecision: '"allow" | "deny" | "ask" (optional)',
					permissionDecisionReason: "string (optional)",
					updatedInput: "object (optional) - Modified tool input to use",
				},
				"for UserPromptSubmit": {
					hookEventName: '"UserPromptSubmit"',
					additionalContext: "string (required)",
				},
				"for PostToolUse": {
					hookEventName: '"PostToolUse"',
					additionalContext: "string (optional)",
				},
				"for PermissionRequest": {
					hookEventName: '"PermissionRequest"',
					decision: {
						behavior: '"allow" | "deny"',
						updatedInput: "object (optional)",
					},
				},
			},
		},
		null,
		2,
	);
}
