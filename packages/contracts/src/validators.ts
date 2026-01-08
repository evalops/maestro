import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
	ComposerAgentEventSchema,
	ComposerChatRequestSchema,
	ComposerCommandListResponseSchema,
	ComposerCommandPrefsSchema,
	ComposerCommandPrefsUpdateSchema,
	ComposerCommandPrefsWriteResponseSchema,
	ComposerConfigResponseSchema,
	ComposerConfigWriteRequestSchema,
	ComposerConfigWriteResponseSchema,
	ComposerErrorResponseSchema,
	ComposerFilesResponseSchema,
	ComposerMessageSchema,
	ComposerModelListResponseSchema,
	ComposerModelSchema,
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

export const isComposerCommandListResponse = (
	value: unknown,
): value is Static<typeof ComposerCommandListResponseSchema> =>
	Value.Check(ComposerCommandListResponseSchema, value);

export const isComposerCommandPrefs = (
	value: unknown,
): value is Static<typeof ComposerCommandPrefsSchema> =>
	Value.Check(ComposerCommandPrefsSchema, value);

export const isComposerCommandPrefsUpdate = (
	value: unknown,
): value is Static<typeof ComposerCommandPrefsUpdateSchema> =>
	Value.Check(ComposerCommandPrefsUpdateSchema, value);

export const isComposerCommandPrefsWriteResponse = (
	value: unknown,
): value is Static<typeof ComposerCommandPrefsWriteResponseSchema> =>
	Value.Check(ComposerCommandPrefsWriteResponseSchema, value);

export const isComposerConfigWriteRequest = (
	value: unknown,
): value is Static<typeof ComposerConfigWriteRequestSchema> =>
	Value.Check(ComposerConfigWriteRequestSchema, value);

export const isComposerConfigResponse = (
	value: unknown,
): value is Static<typeof ComposerConfigResponseSchema> =>
	Value.Check(ComposerConfigResponseSchema, value);

export const isComposerConfigWriteResponse = (
	value: unknown,
): value is Static<typeof ComposerConfigWriteResponseSchema> =>
	Value.Check(ComposerConfigWriteResponseSchema, value);

export const isComposerFilesResponse = (
	value: unknown,
): value is Static<typeof ComposerFilesResponseSchema> =>
	Value.Check(ComposerFilesResponseSchema, value);

export const isComposerModel = (
	value: unknown,
): value is Static<typeof ComposerModelSchema> =>
	Value.Check(ComposerModelSchema, value);

export const isComposerModelListResponse = (
	value: unknown,
): value is Static<typeof ComposerModelListResponseSchema> =>
	Value.Check(ComposerModelListResponseSchema, value);

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

export const assertComposerCommandListResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerCommandListResponseSchema> =>
	assertSchema(
		ComposerCommandListResponseSchema,
		value,
		"ComposerCommandListResponse",
	);

export const assertComposerCommandPrefs = (
	value: unknown,
): asserts value is Static<typeof ComposerCommandPrefsSchema> =>
	assertSchema(ComposerCommandPrefsSchema, value, "ComposerCommandPrefs");

export const assertComposerCommandPrefsUpdate = (
	value: unknown,
): asserts value is Static<typeof ComposerCommandPrefsUpdateSchema> =>
	assertSchema(
		ComposerCommandPrefsUpdateSchema,
		value,
		"ComposerCommandPrefsUpdate",
	);

export const assertComposerCommandPrefsWriteResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerCommandPrefsWriteResponseSchema> =>
	assertSchema(
		ComposerCommandPrefsWriteResponseSchema,
		value,
		"ComposerCommandPrefsWriteResponse",
	);

export const assertComposerConfigWriteRequest = (
	value: unknown,
): asserts value is Static<typeof ComposerConfigWriteRequestSchema> =>
	assertSchema(
		ComposerConfigWriteRequestSchema,
		value,
		"ComposerConfigWriteRequest",
	);

export const assertComposerConfigResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerConfigResponseSchema> =>
	assertSchema(ComposerConfigResponseSchema, value, "ComposerConfigResponse");

export const assertComposerConfigWriteResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerConfigWriteResponseSchema> =>
	assertSchema(
		ComposerConfigWriteResponseSchema,
		value,
		"ComposerConfigWriteResponse",
	);

export const assertComposerFilesResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerFilesResponseSchema> =>
	assertSchema(ComposerFilesResponseSchema, value, "ComposerFilesResponse");

export const assertComposerModel = (
	value: unknown,
): asserts value is Static<typeof ComposerModelSchema> =>
	assertSchema(ComposerModelSchema, value, "ComposerModel");

export const assertComposerModelListResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerModelListResponseSchema> =>
	assertSchema(
		ComposerModelListResponseSchema,
		value,
		"ComposerModelListResponse",
	);

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
