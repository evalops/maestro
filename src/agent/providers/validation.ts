import AjvModule, { type ErrorObject } from "ajv";
import addFormatsModule from "ajv-formats";
import { createLogger } from "../../utils/logger.js";
import type { AgentTool, ToolCall } from "../types.js";

const logger = createLogger("agent:providers:validation");

// Handle both default and named exports (AJV uses different export styles)
// ESM/CJS interop requires any for modules that may have .default property
// biome-ignore lint/suspicious/noExplicitAny: ESM/CJS interop requires any
const Ajv = (AjvModule as any).default ?? AjvModule;
// biome-ignore lint/suspicious/noExplicitAny: ESM/CJS interop requires any
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

// Detect if we're in a browser extension environment with strict CSP
// Chrome extensions with Manifest V3 don't allow eval/Function constructor
interface ChromeRuntime {
	chrome?: { runtime?: { id?: string } };
}
const isBrowserExtension =
	typeof globalThis !== "undefined" &&
	(globalThis as typeof globalThis & ChromeRuntime).chrome?.runtime?.id !==
		undefined;

// Create a singleton AJV instance with formats (only if not in browser extension)
// AJV requires 'unsafe-eval' CSP which is not allowed in Manifest V3
let ajv: ReturnType<typeof Ajv> | null = null;
const validatorCache = new WeakMap<
	object,
	Ajv.ValidateFunction & {
		errors?: ErrorObject[] | null;
	}
>();
if (!isBrowserExtension) {
	try {
		ajv = new Ajv({
			// Limit error output to avoid unbounded allocations on malformed input
			allErrors: false,
			strict: false,
		});
		addFormats(ajv);
	} catch (e) {
		// AJV initialization failed (likely CSP restriction)
		logger.warn("AJV validation disabled due to CSP restrictions", {
			error: e instanceof Error ? e.message : String(e),
			isBrowserExtension,
		});
	}
}

/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(
	tool: AgentTool,
	toolCall: ToolCall,
): Record<string, unknown> {
	// Skip validation in browser extension environment (CSP restrictions prevent AJV from working)
	if (!ajv || isBrowserExtension) {
		// Trust the LLM's output without validation
		// Browser extensions can't use AJV due to Manifest V3 CSP restrictions
		return isRecord(toolCall.arguments) ? toolCall.arguments : {};
	}

	// Compile (or reuse) the schema
	let validate = validatorCache.get(tool.parameters);
	if (!validate) {
		validate = ajv.compile(tool.parameters) as Ajv.ValidateFunction & {
			errors?: ErrorObject[] | null;
		};
		validatorCache.set(tool.parameters, validate);
	}

	// Validate the arguments
	if (validate(toolCall.arguments)) {
		return isRecord(toolCall.arguments) ? toolCall.arguments : {};
	}

	// Format validation errors nicely
	const errors =
		(validate.errors ?? [])
			.map((err) => {
				const path =
					err.instancePath && err.instancePath.length > 1
						? err.instancePath.substring(1)
						: (err.params as { missingProperty?: string }).missingProperty ||
							"root";
				return `  - ${path}: ${err.message ?? "invalid value"}`;
			})
			.join("\n") || "Unknown validation error";

	const argsJson = JSON.stringify(toolCall.arguments, null, 2) ?? "{}";
	const trimmedArgsJson =
		argsJson.length > 2000
			? `${argsJson.slice(0, 2000)}\n... (truncated ${argsJson.length - 2000} chars)`
			: argsJson;

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${trimmedArgsJson}`;

	throw new Error(errorMessage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
