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
	"EvalGate",
	"SessionStart",
	"SessionEnd",
	"SessionBeforeTree",
	"SessionTree",
	"SubagentStart",
	"SubagentStop",
	"UserPromptSubmit",
	"PreMessage",
	"Notification",
	"PreCompact",
	"PostCompact",
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
		const extracted = extractLastJsonObject(trimmed);
		if (extracted !== null) {
			return extracted;
		}
		logger.debug("Failed to parse JSON from hook output", {
			output: trimmed.slice(0, 200),
		});
		return null;
	}
}

function extractLastJsonObject(output: string): unknown | null {
	let inString = false;
	let escaped = false;
	let depth = 0;
	let startIndex: number | null = null;
	let lastParsed: unknown | null = null;

	for (let i = 0; i < output.length; i += 1) {
		const char = output[i];

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}

		if (char === "{") {
			if (depth === 0) {
				startIndex = i;
			}
			depth += 1;
			continue;
		}

		if (char === "}") {
			if (depth > 0) {
				depth -= 1;
				if (depth === 0 && startIndex !== null) {
					const candidate = output.slice(startIndex, i + 1);
					try {
						lastParsed = JSON.parse(candidate);
					} catch {
						// Ignore invalid JSON segments; continue scanning.
					}
					startIndex = null;
				}
			}
		}
	}

	return lastParsed;
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
		case "EvalGate":
			return validateEvalGateOutput(obj);
		case "PostToolUseFailure":
		case "SubagentStart":
			return validateContextOutput(obj);
		case "SessionStart":
			return validateSessionStartOutput(obj);
		case "SessionBeforeTree":
			return validateSessionBeforeTreeOutput(obj);
		case "UserPromptSubmit":
			return validateUserPromptSubmitOutput(obj);
		case "PreMessage":
			return validateContextOutput(obj);
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

	if ("assertions" in obj) {
		const assertionResult = validateAssertions(obj.assertions);
		if (!assertionResult.valid) {
			return assertionResult;
		}
	}

	return { valid: true };
}

/**
 * Validate EvalGate hook-specific output.
 */
function validateEvalGateOutput(
	obj: Record<string, unknown>,
): { valid: true } | { valid: false; error: string } {
	if ("score" in obj && typeof obj.score !== "number") {
		return { valid: false, error: "hookSpecificOutput.score must be a number" };
	}

	if ("threshold" in obj && typeof obj.threshold !== "number") {
		return {
			valid: false,
			error: "hookSpecificOutput.threshold must be a number",
		};
	}

	if ("passed" in obj && typeof obj.passed !== "boolean") {
		return {
			valid: false,
			error: "hookSpecificOutput.passed must be a boolean",
		};
	}

	if ("rationale" in obj && typeof obj.rationale !== "string") {
		return {
			valid: false,
			error: "hookSpecificOutput.rationale must be a string",
		};
	}

	if ("assertions" in obj) {
		const assertionResult = validateAssertions(obj.assertions);
		if (!assertionResult.valid) {
			return assertionResult;
		}
	}

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

function validateSessionStartOutput(
	obj: Record<string, unknown>,
): { valid: true } | { valid: false; error: string } {
	const base = validateContextOutput(obj);
	if (!base.valid) {
		return base;
	}

	if (
		"initialUserMessage" in obj &&
		typeof obj.initialUserMessage !== "string"
	) {
		return {
			valid: false,
			error: "hookSpecificOutput.initialUserMessage must be a string",
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

function validateAssertions(
	assertions: unknown,
): { valid: true } | { valid: false; error: string } {
	if (!Array.isArray(assertions)) {
		return {
			valid: false,
			error: "hookSpecificOutput.assertions must be an array",
		};
	}

	for (const assertion of assertions) {
		if (typeof assertion !== "object" || assertion === null) {
			return {
				valid: false,
				error: "hookSpecificOutput.assertions entries must be objects",
			};
		}

		const entry = assertion as Record<string, unknown>;

		if (!("name" in entry) || typeof entry.name !== "string") {
			return {
				valid: false,
				error:
					"hookSpecificOutput.assertions entries must include a string name field",
			};
		}

		if ("description" in entry && typeof entry.description !== "string") {
			return {
				valid: false,
				error:
					"hookSpecificOutput.assertions entries must have string description when provided",
			};
		}

		if ("id" in entry && typeof entry.id !== "string") {
			return {
				valid: false,
				error:
					"hookSpecificOutput.assertions entries must have string id when provided",
			};
		}

		if ("passed" in entry && typeof entry.passed !== "boolean") {
			return {
				valid: false,
				error:
					"hookSpecificOutput.assertions entries must have boolean passed when provided",
			};
		}

		if ("score" in entry && typeof entry.score !== "number") {
			return {
				valid: false,
				error:
					"hookSpecificOutput.assertions entries must have numeric score when provided",
			};
		}

		if ("threshold" in entry && typeof entry.threshold !== "number") {
			return {
				valid: false,
				error:
					"hookSpecificOutput.assertions entries must have numeric threshold when provided",
			};
		}

		if ("severity" in entry) {
			if (
				typeof entry.severity !== "string" ||
				!["info", "warn", "error"].includes(entry.severity)
			) {
				return {
					valid: false,
					error:
						"hookSpecificOutput.assertions entries severity must be info, warn, or error",
				};
			}
		}

		if ("evidence" in entry && typeof entry.evidence !== "string") {
			return {
				valid: false,
				error:
					"hookSpecificOutput.assertions entries must have string evidence when provided",
			};
		}

		if ("metadata" in entry) {
			if (typeof entry.metadata !== "object" || entry.metadata === null) {
				return {
					valid: false,
					error:
						"hookSpecificOutput.assertions entries metadata must be an object when provided",
				};
			}
		}
	}

	return { valid: true };
}

function validateSessionBeforeTreeOutput(
	obj: Record<string, unknown>,
): { valid: true } | { valid: false; error: string } {
	if ("cancel" in obj && typeof obj.cancel !== "boolean") {
		return {
			valid: false,
			error: "hookSpecificOutput.cancel must be a boolean",
		};
	}

	if ("summary" in obj) {
		if (typeof obj.summary !== "object" || obj.summary === null) {
			return {
				valid: false,
				error: "hookSpecificOutput.summary must be an object",
			};
		}
		const summary = obj.summary as Record<string, unknown>;
		if (typeof summary.summary !== "string") {
			return {
				valid: false,
				error: "hookSpecificOutput.summary.summary must be a string",
			};
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
				"for PreMessage": {
					hookEventName: '"PreMessage"',
					additionalContext: "string (optional)",
				},
				"for PostToolUse": {
					hookEventName: '"PostToolUse"',
					additionalContext: "string (optional)",
					assertions:
						"array (optional) - assertions matching eval schema with name, score, passed",
				},
				"for EvalGate": {
					hookEventName: '"EvalGate"',
					score: "number (optional)",
					threshold: "number (optional)",
					passed: "boolean (optional)",
					rationale: "string (optional)",
					assertions:
						"array (optional) - assertions matching eval schema with name, score, passed",
				},
				"for PermissionRequest": {
					hookEventName: '"PermissionRequest"',
					decision: {
						behavior: '"allow" | "deny"',
						updatedInput: "object (optional)",
					},
				},
				"for SessionBeforeTree": {
					hookEventName: '"SessionBeforeTree"',
					cancel: "boolean (optional)",
					summary: {
						summary: "string (required)",
						details: "any (optional)",
					},
				},
			},
		},
		null,
		2,
	);
}
