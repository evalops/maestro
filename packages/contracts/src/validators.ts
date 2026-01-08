import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
	ComposerAgentEventSchema,
	ComposerChatRequestSchema,
	ComposerErrorResponseSchema,
	ComposerMessageSchema,
	ComposerSessionListResponseSchema,
	ComposerSessionSchema,
	ComposerSessionSummarySchema,
	ComposerStatusResponseSchema,
	ComposerUsageResponseSchema,
} from "./schemas.js";

export type ValidationResult<T> =
	| { ok: true; value: T }
	| { ok: false; errors: string[] };

function formatErrors(
	errors: Iterable<{ path: string; message: string }>,
): string[] {
	const results: string[] = [];
	for (const err of errors) {
		const path = err.path && err.path.length > 0 ? err.path : "$";
		results.push(`${path} ${err.message}`.trim());
	}
	return results;
}

export function validateSchema<T extends TSchema>(
	schema: T,
	value: unknown,
): ValidationResult<Static<T>> {
	if (Value.Check(schema, value)) {
		return { ok: true, value: value as Static<T> };
	}
	return {
		ok: false,
		errors: formatErrors(Value.Errors(schema, value)),
	};
}

export function assertSchema<T extends TSchema>(
	schema: T,
	value: unknown,
	label: string,
): asserts value is Static<T> {
	const result = validateSchema(schema, value);
	if (!result.ok) {
		const details = result.errors.join("; ");
		throw new Error(`Invalid ${label}: ${details}`);
	}
}

export const isComposerMessage = (
	value: unknown,
): value is Static<typeof ComposerMessageSchema> =>
	Value.Check(ComposerMessageSchema, value);

export const isComposerChatRequest = (
	value: unknown,
): value is Static<typeof ComposerChatRequestSchema> =>
	Value.Check(ComposerChatRequestSchema, value);

export const isComposerAgentEvent = (
	value: unknown,
): value is Static<typeof ComposerAgentEventSchema> =>
	Value.Check(ComposerAgentEventSchema, value);

export const isComposerSessionSummary = (
	value: unknown,
): value is Static<typeof ComposerSessionSummarySchema> =>
	Value.Check(ComposerSessionSummarySchema, value);

export const isComposerSession = (
	value: unknown,
): value is Static<typeof ComposerSessionSchema> =>
	Value.Check(ComposerSessionSchema, value);

export const isComposerSessionListResponse = (
	value: unknown,
): value is Static<typeof ComposerSessionListResponseSchema> =>
	Value.Check(ComposerSessionListResponseSchema, value);

export const isComposerErrorResponse = (
	value: unknown,
): value is Static<typeof ComposerErrorResponseSchema> =>
	Value.Check(ComposerErrorResponseSchema, value);

export const isComposerStatusResponse = (
	value: unknown,
): value is Static<typeof ComposerStatusResponseSchema> =>
	Value.Check(ComposerStatusResponseSchema, value);

export const isComposerUsageResponse = (
	value: unknown,
): value is Static<typeof ComposerUsageResponseSchema> =>
	Value.Check(ComposerUsageResponseSchema, value);

export const assertComposerChatRequest = (
	value: unknown,
): asserts value is Static<typeof ComposerChatRequestSchema> =>
	assertSchema(ComposerChatRequestSchema, value, "ComposerChatRequest");

export const assertComposerAgentEvent = (
	value: unknown,
): asserts value is Static<typeof ComposerAgentEventSchema> =>
	assertSchema(ComposerAgentEventSchema, value, "ComposerAgentEvent");

export const assertComposerErrorResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerErrorResponseSchema> =>
	assertSchema(ComposerErrorResponseSchema, value, "ComposerErrorResponse");

export const assertComposerStatusResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerStatusResponseSchema> =>
	assertSchema(ComposerStatusResponseSchema, value, "ComposerStatusResponse");

export const assertComposerUsageResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerUsageResponseSchema> =>
	assertSchema(ComposerUsageResponseSchema, value, "ComposerUsageResponse");
