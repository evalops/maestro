/**
 * Tool DSL - Domain-Specific Language for Creating Agent Tools
 *
 * This module provides a fluent, type-safe API for defining tools that can be
 * executed by the Composer agent. It handles schema validation, response building,
 * retry logic, and sandbox integration.
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                     Tool Creation Flow                          │
 * ├─────────────────────────────────────────────────────────────────┤
 * │  createTool(options)                                            │
 * │       │                                                         │
 * │       ▼                                                         │
 * │  ┌─────────────┐    ┌──────────────┐    ┌─────────────────┐    │
 * │  │   Schema    │───▶│  Validator   │───▶│   execute()     │    │
 * │  │  (TypeBox)  │    │   (AJV)      │    │   function      │    │
 * │  └─────────────┘    └──────────────┘    └─────────────────┘    │
 * │                                               │                 │
 * │                                               ▼                 │
 * │                     ┌─────────────────────────────────────┐     │
 * │                     │  ToolResponseBuilder                │     │
 * │                     │  - text(), image(), error()         │     │
 * │                     │  - detail() for structured data     │     │
 * │                     └─────────────────────────────────────┘     │
 * └─────────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Tool Types
 *
 * | Factory       | Return Type      | Use Case                          |
 * |---------------|------------------|-----------------------------------|
 * | createTool    | AgentToolResult  | Full control over response        |
 * | createTextTool| string → text    | Simple text responses             |
 * | createJsonTool| object → JSON    | Structured data responses         |
 *
 * ## Example
 *
 * ```typescript
 * import { createTool, Type } from './tool-dsl';
 *
 * const greetTool = createTool({
 *   name: 'greet',
 *   description: 'Greet a user by name',
 *   schema: Type.Object({
 *     name: Type.String({ description: 'Name to greet' }),
 *   }),
 *   run: async ({ name }, { respond }) => {
 *     return respond.text(`Hello, ${name}!`);
 *   },
 * });
 * ```
 *
 * ## Features
 *
 * - **Type-safe schemas**: Uses TypeBox for compile-time type inference
 * - **AJV validation**: Runtime validation with format support
 * - **Retry logic**: Built-in exponential backoff for transient failures
 * - **Sandbox support**: Tools can run in isolated environments
 * - **Context interpolation**: Environment variables and paths
 *
 * @module tools/tool-dsl
 */

import type { Static, TSchema } from "@sinclair/typebox";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";
import type { AgentToolResult, ToolAnnotations } from "../agent/types.js";
import type { Sandbox } from "../sandbox/types.js";
import { resolveDefaultExport } from "../utils/module-interop.js";

// ESM/CJS interop: ajv-formats default may be nested under .default in some loaders
const addFormats = resolveDefaultExport<FormatsPlugin>(addFormatsModule);

// Create a singleton AJV instance for schema validation
let ajv: Ajv | null = null;
try {
	ajv = new Ajv({
		// Avoid unbounded error collection on large/invalid payloads
		allErrors: false,
		strict: false,
		useDefaults: true, // Apply schema defaults to input
	});
	addFormats(ajv);
} catch {
	// AJV initialization failed (likely CSP restriction)
	ajv = null;
}

// Cache compiled validators per schema to avoid recompiling on every execute()
const validatorCache = new WeakMap<TSchema, ValidateFunction>();

function getOrCompileValidator(schema: TSchema): ValidateFunction | null {
	if (!ajv) return null;

	let validate = validatorCache.get(schema);
	if (!validate) {
		validate = ajv.compile(schema);
		validatorCache.set(schema, validate);
	}
	return validate;
}

export class ToolResponseBuilder<Details> {
	private _content: (
		| { type: "text"; text: string }
		| { type: "image"; data: string; mimeType: string }
	)[] = [];
	private _details?: Details;
	private _isError = false;

	text(content: string): this {
		this._content.push({ type: "text", text: content });
		return this;
	}

	image(base64: string, mimeType: string): this {
		this._content.push({ type: "image", data: base64, mimeType });
		return this;
	}

	detail(details: Details): this {
		this._details = details;
		return this;
	}

	error(message: string): this {
		this.text(message);
		this._isError = true;
		return this;
	}

	build(): AgentToolResult<Details> {
		return {
			content: this._content,
			details: this._details,
			isError: this._isError,
		};
	}
}

export interface ToolRunContext<Details> {
	toolCallId: string;
	signal?: AbortSignal;
	respond: ToolResponseBuilder<Details>;
	sandbox?: Sandbox;
}

export interface CreateToolOptions<Schema extends TSchema, Details> {
	name: string;
	label?: string;
	description: string;
	schema: Schema;
	annotations?: ToolAnnotations;
	toolType?: string;
	inputExamples?: unknown[];
	allowedCallers?: string[];
	deferApiDefinition?: boolean;
	run: (
		params: import("@sinclair/typebox").Static<Schema>,
		context: ToolRunContext<Details>,
	) =>
		| undefined
		| ToolResponseBuilder<Details>
		| AgentToolResult<Details>
		| Promise<
				undefined | ToolResponseBuilder<Details> | AgentToolResult<Details>
		  >;
	maxRetries?: number;
	retryDelayMs?: number;
	shouldRetry?: (error: unknown) => boolean;
}

type StaticSchema<Schema extends TSchema> = Static<Schema>;

export class ToolError extends Error {
	constructor(
		message: string,
		public readonly code?: string,
		public readonly details?: unknown,
	) {
		super(message);
		this.name = "ToolError";
	}
}

export function createTool<Schema extends TSchema, Details = undefined>(
	options: CreateToolOptions<Schema, Details>,
) {
	return Object.freeze({
		name: options.name,
		label: options.label ?? options.name,
		description: options.description,
		parameters: options.schema,
		annotations: options.annotations,
		toolType: options.toolType,
		inputExamples: options.inputExamples,
		allowedCallers: options.allowedCallers,
		deferApiDefinition: options.deferApiDefinition,
		maxRetries: options.maxRetries,
		retryDelayMs: options.retryDelayMs,
		shouldRetry: options.shouldRetry,
		execute: async (
			toolCallId: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
			context?: { sandbox?: Sandbox },
		) => {
			// Validate params against schema using cached validator
			if (options.schema) {
				const validate = getOrCompileValidator(options.schema);
				if (validate && !validate(params)) {
					const errors =
						(validate.errors ?? [])
							.map((err) => {
								const path =
									err.instancePath && err.instancePath.length > 1
										? err.instancePath.substring(1)
										: (err.params as { missingProperty?: string })
												.missingProperty || "root";
								return `  - ${path}: ${err.message ?? "invalid value"}`;
							})
							.join("\n") || "Unknown validation error";
					throw new ToolError(
						`Validation failed for tool "${options.name}":\n${errors}`,
						"VALIDATION_ERROR",
						{ params },
					);
				}
			}

			const maxRetries = options.maxRetries ?? 0;
			const retryDelayMs = options.retryDelayMs ?? 1000;
			const shouldRetry = options.shouldRetry ?? (() => true);
			const typedParams = params as StaticSchema<Schema>;

			let lastError: unknown;
			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				if (attempt > 0) {
					// Exponential backoff: delay * 2^(attempt-1)
					const delay = retryDelayMs * 2 ** (attempt - 1);
					if (signal) {
						const activeSignal = signal;
						await new Promise<void>((resolve, reject) => {
							if (activeSignal.aborted) {
								reject(new Error("Operation aborted"));
								return;
							}
							const timeout = setTimeout(() => {
								activeSignal.removeEventListener("abort", onAbort);
								resolve();
							}, delay);
							function onAbort() {
								clearTimeout(timeout);
								activeSignal.removeEventListener("abort", onAbort);
								reject(new Error("Operation aborted"));
							}
							activeSignal.addEventListener("abort", onAbort, { once: true });
						});
					} else {
						await new Promise((resolve) => setTimeout(resolve, delay));
					}
				}

				try {
					const builder = new ToolResponseBuilder<Details>();
					const result = await options.run(typedParams, {
						toolCallId,
						signal,
						respond: builder,
						sandbox: context?.sandbox,
					});
					if (result instanceof ToolResponseBuilder) {
						return result.build();
					}
					if (result) {
						return result;
					}
					return builder.build();
				} catch (error) {
					lastError = error;
					if (attempt < maxRetries && shouldRetry(error)) {
						continue;
					}
					throw error;
				}
			}
			throw lastError;
		},
	});
}

import { getHomeDir } from "../utils/path-expansion.js";
import { expandUserPath as expandUserPathBase } from "../utils/path-validation.js";

// Re-export shared path expansion utility to keep tool-dsl API stable
export const expandUserPath = expandUserPathBase;

/**
 * Interpolate environment variables and context in a string.
 * Supports: ${env.VAR}, ${cwd}, ${home}
 */
export function interpolateContext(value: string): string {
	return value
		.replace(/\$\{env\.([^}]+)\}/g, (_, varName) => process.env[varName] ?? "")
		.replace(/\$\{cwd\}/g, process.cwd())
		.replace(/\$\{home\}/g, getHomeDir());
}

export interface CreateTextToolOptions<Schema extends TSchema, Details>
	extends Omit<CreateToolOptions<Schema, Details>, "run"> {
	run: (
		params: import("@sinclair/typebox").Static<Schema>,
		context: ToolRunContext<Details>,
	) =>
		| string
		| undefined
		| ToolResponseBuilder<Details>
		| AgentToolResult<Details>
		| Promise<
				| string
				| undefined
				| ToolResponseBuilder<Details>
				| AgentToolResult<Details>
		  >;
}

export function createTextTool<Schema extends TSchema, Details = undefined>(
	options: CreateTextToolOptions<Schema, Details>,
) {
	return createTool<Schema, Details>({
		...options,
		run: async (params, context) => {
			const result = await options.run(params, context);
			if (typeof result === "string") {
				return context.respond.text(result);
			}
			return result;
		},
	});
}

export interface CreateJsonToolOptions<Schema extends TSchema, Details>
	extends Omit<CreateToolOptions<Schema, Details>, "run"> {
	run: (
		params: import("@sinclair/typebox").Static<Schema>,
		context: ToolRunContext<Details>,
	) =>
		| unknown
		| undefined
		| ToolResponseBuilder<Details>
		| AgentToolResult<Details>
		| Promise<
				| unknown
				| undefined
				| ToolResponseBuilder<Details>
				| AgentToolResult<Details>
		  >;
}

export function createJsonTool<Schema extends TSchema, Details = undefined>(
	options: CreateJsonToolOptions<Schema, Details>,
) {
	return createTool<Schema, Details>({
		...options,
		run: async (params, context) => {
			const result = await options.run(params, context);
			if (result === undefined) {
				return result;
			}
			if (result instanceof ToolResponseBuilder) {
				return result;
			}
			if (isAgentToolResult<Details>(result)) {
				return result;
			}
			return context.respond.text(JSON.stringify(result, null, 2));
		},
	});
}

function isAgentToolResult<Details>(
	value: unknown,
): value is AgentToolResult<Details> {
	return (
		typeof value === "object" &&
		value !== null &&
		"content" in value &&
		Array.isArray((value as AgentToolResult<Details>).content)
	);
}
