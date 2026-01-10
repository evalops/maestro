/**
 * Shared types and utilities for OpenAI providers
 *
 * This module contains types and functions shared between openai.ts and
 * openai-responses-sdk.ts to avoid circular dependencies.
 */

import type { ReasoningEffort, StreamOptions } from "../types.js";

// =============================================================================
// OpenAI API Types
// =============================================================================

/**
 * Tool choice configuration for OpenAI APIs.
 * Controls how the model selects which tools to use.
 */
export type OpenAIToolChoice =
	| "auto"
	| "none"
	| "required"
	| { type: "function"; function: { name: string } };

/**
 * Response format options for structured outputs.
 * - `json_object`: Guarantees valid JSON output (legacy JSON mode)
 * - `json_schema`: Guarantees output matching a specific schema (Structured Outputs)
 *
 * Note: The format differs between APIs:
 * - Chat Completions API: `response_format: { type: "json_schema", json_schema: {...} }`
 * - Responses API: `text: { format: { type: "json_schema", name, schema, ... } }`
 *
 * This type represents the unified format; the provider handles the translation.
 *
 * @see https://platform.openai.com/docs/guides/structured-outputs
 */
export type OpenAIResponseFormat =
	| { type: "json_object" }
	| { type: "text" }
	| {
			type: "json_schema";
			json_schema: {
				name: string;
				schema: object;
				strict?: boolean;
				description?: string;
			};
	  };

/**
 * Options for OpenAI-compatible API calls.
 */
export interface OpenAIOptions extends StreamOptions {
	reasoningEffort?: ReasoningEffort;
	/**
	 * Controls how the model uses tools.
	 * - "auto": Model decides (default)
	 * - "none": Disable tool use
	 * - "required": Must use at least one tool
	 * - { type: "function", function: { name: "..." } }: Force specific tool
	 */
	toolChoice?: OpenAIToolChoice;
	/**
	 * Response format for structured outputs.
	 * - `{ type: "json_object" }`: Guarantees valid JSON output
	 * - `{ type: "json_schema", json_schema: { name, schema, strict? } }`: Guarantees output matching schema
	 *
	 * @see https://platform.openai.com/docs/guides/structured-outputs
	 */
	responseFormat?: OpenAIResponseFormat;
}

// =============================================================================
// Responses API Types
// =============================================================================

/**
 * Content part for Responses API input messages.
 * User messages use input_text, assistant messages use output_text.
 */
export type ResponsesInputTextPart = { type: "input_text"; text: string };
export type ResponsesOutputTextPart = { type: "output_text"; text: string };
export type ResponsesContentPart =
	| ResponsesInputTextPart
	| ResponsesOutputTextPart;

/**
 * Message format for Responses API input array.
 */
export interface ResponsesInputMessage {
	role: "user" | "assistant" | "system" | "developer";
	content: ResponsesContentPart[];
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Filters tools for Responses API compatibility.
 *
 * The Responses API has stricter requirements than Chat Completions:
 * - Tool names must be non-empty
 * - Parameters schema cannot have oneOf/anyOf/allOf/enum/not at top level
 *
 * @param tools - Array of agent tools
 * @returns Filtered array of compatible tools
 */
export function filterResponsesApiTools(
	tools: Array<{ name: string; description: string; parameters: unknown }>,
): Array<{ name: string; description: string; parameters: unknown }> {
	const hasIncompatibleSchema = (params: unknown): boolean => {
		if (!params || typeof params !== "object") return false;
		const p = params as Record<string, unknown>;
		return !!(p.oneOf || p.anyOf || p.allOf || p.enum || p.not);
	};

	return tools.filter(
		(tool) =>
			tool.name &&
			tool.name.trim() !== "" &&
			!hasIncompatibleSchema(tool.parameters),
	);
}
