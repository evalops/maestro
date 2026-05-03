/**
 * Shared types and utilities for OpenAI providers
 *
 * This module contains types and functions shared between openai.ts and
 * openai-responses-sdk.ts to avoid circular dependencies.
 */

import type { ReasoningEffort, StreamOptions } from "../types.js";
import { isRecord } from "./tool-arguments.js";

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
	/** Controls the level of reasoning summary for Responses API. */
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
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

const EMPTY_TOOL_PARAMETERS_SCHEMA = {
	type: "object",
	properties: {},
	additionalProperties: true,
} as const;

const TOP_LEVEL_UNION_KEYS = ["anyOf", "oneOf", "allOf"] as const;

function canonicalizeSchema(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => canonicalizeSchema(entry));
	}
	if (!isRecord(value)) {
		return value;
	}

	return Object.fromEntries(
		Object.entries(value)
			.filter(([, entryValue]) => entryValue !== undefined)
			.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
			.map(([entryKey, entryValue]) => [
				entryKey,
				canonicalizeSchema(entryValue),
			]),
	);
}

function schemasAreEqual(left: unknown, right: unknown): boolean {
	return (
		JSON.stringify(canonicalizeSchema(left)) ===
		JSON.stringify(canonicalizeSchema(right))
	);
}

function enumLikeValues(
	schema: Record<string, unknown>,
): unknown[] | undefined {
	if (schema.const !== undefined) {
		return [schema.const];
	}
	if (Array.isArray(schema.enum)) {
		return schema.enum;
	}
	return undefined;
}

function mergeCompatibleObjectSchemas(
	left: Record<string, unknown>,
	right: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const annotationKeys = new Set([
		"$comment",
		"default",
		"deprecated",
		"description",
		"examples",
		"readOnly",
		"title",
		"writeOnly",
	]);
	const lowerBoundKeys = new Set([
		"minimum",
		"exclusiveMinimum",
		"minLength",
		"minItems",
		"minProperties",
	]);
	const upperBoundKeys = new Set([
		"maximum",
		"exclusiveMaximum",
		"maxLength",
		"maxItems",
		"maxProperties",
	]);
	const merged: Record<string, unknown> = { ...left };
	for (const [key, value] of Object.entries(right)) {
		const existing = merged[key];
		if (existing === undefined || schemasAreEqual(existing, value)) {
			merged[key] = value;
			continue;
		}
		if (annotationKeys.has(key)) {
			continue;
		}
		if (typeof existing === "number" && typeof value === "number") {
			if (lowerBoundKeys.has(key)) {
				merged[key] = Math.max(existing, value);
				continue;
			}
			if (upperBoundKeys.has(key)) {
				merged[key] = Math.min(existing, value);
				continue;
			}
		}
		return undefined;
	}
	return merged;
}

function mergeSharedObjectSchemaConstraints(
	left: Record<string, unknown>,
	right: Record<string, unknown>,
	enumValues: unknown[],
): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(left)) {
		if (right[key] !== undefined && schemasAreEqual(value, right[key])) {
			merged[key] = value;
		}
	}
	const primitiveTypes = new Set(
		enumValues
			.map((value) => (value === null ? "null" : typeof value))
			.filter((value) => ["boolean", "number", "string"].includes(value)),
	);
	if (primitiveTypes.size === 1) {
		const [primitiveType] = [...primitiveTypes];
		if (left.type === primitiveType || right.type === primitiveType) {
			merged.type = primitiveType;
		}
	}
	return merged;
}

function mergeObjectVariants(
	variants: unknown[],
	requiredMode: "intersection" | "union",
): Record<string, unknown> | undefined {
	if (variants.length === 0 || !variants.every(isRecord)) return undefined;
	if (!variants.every((variant) => variant.type === "object")) return undefined;

	const mergedProperties: Record<string, unknown> = {};
	const requiredCounts = new Map<string, number>();

	for (const variant of variants) {
		const properties = isRecord(variant.properties) ? variant.properties : {};
		for (const [propertyName, propertySchema] of Object.entries(properties)) {
			const current = mergedProperties[propertyName];
			if (current === undefined) {
				mergedProperties[propertyName] = propertySchema;
				continue;
			}

			if (schemasAreEqual(current, propertySchema)) {
				continue;
			}

			if (isRecord(current) && isRecord(propertySchema)) {
				const currentValues = enumLikeValues(current);
				const incomingValues = enumLikeValues(propertySchema);
				if (currentValues && incomingValues) {
					const {
						const: _const,
						enum: _enum,
						...currentWithoutDiscriminator
					} = current;
					const {
						const: _incomingConst,
						enum: _incomingEnum,
						...incomingWithoutDiscriminator
					} = propertySchema;
					const enumValues =
						requiredMode === "union"
							? currentValues.filter((value) => incomingValues.includes(value))
							: [...new Set([...currentValues, ...incomingValues])];
					if (requiredMode === "union" && enumValues.length === 0) {
						return undefined;
					}
					const mergedSchema =
						requiredMode === "union"
							? (mergeCompatibleObjectSchemas(
									currentWithoutDiscriminator,
									incomingWithoutDiscriminator,
								) ?? currentWithoutDiscriminator)
							: mergeSharedObjectSchemaConstraints(
									currentWithoutDiscriminator,
									incomingWithoutDiscriminator,
									enumValues,
								);
					mergedProperties[propertyName] = {
						...mergedSchema,
						...(enumValues.length > 0 ? { enum: enumValues } : {}),
					};
					continue;
				}
			}

			if (
				requiredMode === "union" &&
				isRecord(current) &&
				isRecord(propertySchema)
			) {
				mergedProperties[propertyName] =
					mergeCompatibleObjectSchemas(current, propertySchema) ?? {};
				continue;
			}

			mergedProperties[propertyName] = {};
		}

		const required = Array.isArray(variant.required) ? variant.required : [];
		for (const propertyName of required) {
			if (typeof propertyName === "string") {
				requiredCounts.set(
					propertyName,
					(requiredCounts.get(propertyName) ?? 0) + 1,
				);
			}
		}
	}

	const required = [...requiredCounts.entries()].reduce(
		(acc, [propertyName, count]) => {
			if (count > 0) acc.union.push(propertyName);
			if (count === variants.length) acc.intersection.push(propertyName);
			return acc;
		},
		{ intersection: [] as string[], union: [] as string[] },
	);
	const requiredFields =
		requiredMode === "union" || required.intersection.length === 0
			? required.union
			: required.intersection;

	return {
		type: "object",
		properties: mergedProperties,
		...(requiredFields.length > 0 ? { required: requiredFields } : {}),
		additionalProperties: false,
	};
}

function mergeRootObjectConstraints(
	schema: Record<string, unknown>,
	merged: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (schema.type !== "object") return merged;

	const rootProperties = isRecord(schema.properties) ? schema.properties : {};
	const mergedProperties = isRecord(merged.properties) ? merged.properties : {};
	const properties: Record<string, unknown> = { ...rootProperties };
	for (const [propertyName, propertySchema] of Object.entries(
		mergedProperties,
	)) {
		const rootPropertySchema = properties[propertyName];
		if (rootPropertySchema === undefined) {
			properties[propertyName] = propertySchema;
			continue;
		}
		if (schemasAreEqual(rootPropertySchema, propertySchema)) {
			continue;
		}
		if (isRecord(rootPropertySchema) && isRecord(propertySchema)) {
			const compatible = mergeCompatibleObjectSchemas(
				rootPropertySchema,
				propertySchema,
			);
			if (!compatible) return undefined;
			properties[propertyName] = compatible;
			continue;
		}
		return undefined;
	}

	const required = [
		...new Set(
			[
				...(Array.isArray(schema.required) ? schema.required : []),
				...(Array.isArray(merged.required) ? merged.required : []),
			].filter(
				(propertyName): propertyName is string =>
					typeof propertyName === "string",
			),
		),
	];

	return {
		...merged,
		properties,
		...(schema.additionalProperties !== undefined
			? { additionalProperties: schema.additionalProperties }
			: {}),
		...(required.length > 0 ? { required } : {}),
	};
}

function hasBranchOnlyRequiredFields(variants: unknown[]): boolean {
	if (variants.length === 0 || !variants.every(isRecord)) return false;

	const requiredCounts = new Map<string, number>();
	for (const variant of variants) {
		const required = Array.isArray(variant.required) ? variant.required : [];
		for (const propertyName of required) {
			if (typeof propertyName === "string") {
				requiredCounts.set(
					propertyName,
					(requiredCounts.get(propertyName) ?? 0) + 1,
				);
			}
		}
	}

	return [...requiredCounts.values()].some((count) => count < variants.length);
}

/**
 * Ensures tool parameter schemas satisfy OpenAI-compatible function calling.
 *
 * Some local TypeBox schemas, especially top-level unions, serialize without a
 * top-level `type`. OpenAI-compatible gateways reject those as `type: None`.
 * Keep the original schema constraints, but make the top-level object contract
 * explicit before sending it over the wire.
 */
export function normalizeOpenAIToolParameters(
	parameters: unknown,
): Record<string, unknown> {
	if (
		!parameters ||
		typeof parameters !== "object" ||
		Array.isArray(parameters)
	) {
		return { ...EMPTY_TOOL_PARAMETERS_SCHEMA };
	}

	const schema = parameters as Record<string, unknown>;
	const topLevelUnionKey = TOP_LEVEL_UNION_KEYS.find((key) =>
		Array.isArray(schema[key]),
	);
	if (topLevelUnionKey) {
		const merged = mergeObjectVariants(
			schema[topLevelUnionKey] as unknown[],
			topLevelUnionKey === "allOf" ? "union" : "intersection",
		);
		if (!merged) return { ...EMPTY_TOOL_PARAMETERS_SCHEMA };
		return (
			mergeRootObjectConstraints(schema, merged) ?? {
				...EMPTY_TOOL_PARAMETERS_SCHEMA,
			}
		);
	}

	if (schema.type === "object") {
		return schema;
	}

	if (
		schema.type === undefined &&
		!schema.enum &&
		!schema.not &&
		!schema.oneOf &&
		!schema.anyOf &&
		!schema.allOf
	) {
		return { ...schema, type: "object" };
	}

	return { ...EMPTY_TOOL_PARAMETERS_SCHEMA };
}

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
export function filterResponsesApiTools<
	T extends { name: string; description: string; parameters: unknown },
>(
	tools: T[],
): Array<Omit<T, "parameters"> & { parameters: Record<string, unknown> }> {
	const hasUnsupportedTopLevelUnion = (params: unknown): boolean => {
		if (!isRecord(params)) return false;
		const topLevelUnionKey = TOP_LEVEL_UNION_KEYS.find((key) =>
			Array.isArray(params[key]),
		);
		if (!topLevelUnionKey) return false;
		if (
			(topLevelUnionKey === "anyOf" || topLevelUnionKey === "oneOf") &&
			hasBranchOnlyRequiredFields(params[topLevelUnionKey] as unknown[])
		) {
			return true;
		}
		return (
			mergeObjectVariants(
				params[topLevelUnionKey] as unknown[],
				topLevelUnionKey === "allOf" ? "union" : "intersection",
			) === undefined
		);
	};

	const hasIncompatibleSchema = (params: unknown): boolean => {
		if (!params || typeof params !== "object") return false;
		const p = params as Record<string, unknown>;
		return !!(p.oneOf || p.anyOf || p.allOf || p.enum || p.not);
	};

	const hasUnsupportedTopLevelKeyword = (params: unknown): boolean => {
		if (!isRecord(params)) return false;
		return params.enum !== undefined || params.not !== undefined;
	};

	return tools
		.filter(
			(tool) =>
				tool.name &&
				tool.name.trim() !== "" &&
				!hasUnsupportedTopLevelKeyword(tool.parameters) &&
				!hasUnsupportedTopLevelUnion(tool.parameters),
		)
		.map((tool) => ({
			...tool,
			parameters: normalizeOpenAIToolParameters(tool.parameters),
		}))
		.filter((tool) => !hasIncompatibleSchema(tool.parameters));
}
