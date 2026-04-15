import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
	HeadlessFromAgentMessageSchema,
	HeadlessRuntimeHeartbeatSnapshotSchema,
	HeadlessRuntimeSnapshotSchema,
	HeadlessRuntimeStreamEnvelopeSchema,
	HeadlessRuntimeSubscriptionSnapshotSchema,
	type HeadlessToAgentMessageSchema,
	headlessToAgentMessageSchemasByType,
} from "./headless-protocol-schemas.generated.js";
import {
	ComposerAgentEventSchema,
	ComposerApprovalsStatusResponseSchema,
	ComposerApprovalsUpdateRequestSchema,
	ComposerApprovalsUpdateResponseSchema,
	ComposerBackgroundHistoryResponseSchema,
	ComposerBackgroundPathResponseSchema,
	ComposerBackgroundStatusResponseSchema,
	ComposerBackgroundUpdateRequestSchema,
	ComposerBackgroundUpdateResponseSchema,
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
	ComposerFrameworkListResponseSchema,
	ComposerFrameworkStatusResponseSchema,
	ComposerFrameworkUpdateRequestSchema,
	ComposerFrameworkUpdateResponseSchema,
	ComposerGuardianConfigRequestSchema,
	ComposerGuardianConfigResponseSchema,
	ComposerGuardianRunResponseSchema,
	ComposerGuardianStatusResponseSchema,
	ComposerMessageSchema,
	ComposerModelListResponseSchema,
	ComposerModelSchema,
	ComposerPlanActionResponseSchema,
	ComposerPlanRequestSchema,
	ComposerPlanStatusResponseSchema,
	ComposerSessionListResponseSchema,
	ComposerSessionSchema,
	ComposerSessionSummarySchema,
	ComposerStatusResponseSchema,
	ComposerUndoHistoryResponseSchema,
	ComposerUndoOperationResponseSchema,
	ComposerUndoRequestSchema,
	ComposerUndoStatusResponseSchema,
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

function getHeadlessMessageType(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || !("type" in value)) {
		return undefined;
	}
	const type = (value as { type?: unknown }).type;
	return typeof type === "string" ? type : undefined;
}

export function validateHeadlessToAgentMessage(
	value: unknown,
): ValidationResult<Static<typeof HeadlessToAgentMessageSchema>> {
	const type = getHeadlessMessageType(value);
	if (!type) {
		return {
			ok: false,
			errors: ["$.type Expected known headless command type"],
		};
	}
	const schema =
		headlessToAgentMessageSchemasByType[
			type as keyof typeof headlessToAgentMessageSchemasByType
		];
	if (!schema) {
		return {
			ok: false,
			errors: [`$.type Unknown headless command type: ${type}`],
		};
	}
	return validateSchema(schema, value);
}

export function assertHeadlessToAgentMessage(
	value: unknown,
	label = "headless command",
): asserts value is Static<typeof HeadlessToAgentMessageSchema> {
	const result = validateHeadlessToAgentMessage(value);
	if (result.ok) {
		return;
	}
	if (
		result.errors.length === 1 &&
		result.errors[0]?.includes("Unknown headless command type")
	) {
		throw new Error("Unknown headless command type");
	}
	throw new Error(`Invalid ${label}: ${result.errors.join("; ")}`);
}

export const isHeadlessFromAgentMessage = (
	value: unknown,
): value is Static<typeof HeadlessFromAgentMessageSchema> =>
	Value.Check(HeadlessFromAgentMessageSchema, value);

export function assertHeadlessFromAgentMessage(
	value: unknown,
	label = "headless message",
): asserts value is Static<typeof HeadlessFromAgentMessageSchema> {
	assertSchema(HeadlessFromAgentMessageSchema, value, label);
}

export function assertHeadlessRuntimeSnapshot(
	value: unknown,
	label = "headless runtime snapshot",
): asserts value is Static<typeof HeadlessRuntimeSnapshotSchema> {
	assertSchema(HeadlessRuntimeSnapshotSchema, value, label);
}

export function assertHeadlessRuntimeStreamEnvelope(
	value: unknown,
	label = "headless runtime envelope",
): asserts value is Static<typeof HeadlessRuntimeStreamEnvelopeSchema> {
	assertSchema(HeadlessRuntimeStreamEnvelopeSchema, value, label);
}

export function assertHeadlessRuntimeSubscriptionSnapshot(
	value: unknown,
	label = "headless subscription snapshot",
): asserts value is Static<typeof HeadlessRuntimeSubscriptionSnapshotSchema> {
	assertSchema(HeadlessRuntimeSubscriptionSnapshotSchema, value, label);
}

export function assertHeadlessRuntimeHeartbeatSnapshot(
	value: unknown,
	label = "headless heartbeat snapshot",
): asserts value is Static<typeof HeadlessRuntimeHeartbeatSnapshotSchema> {
	assertSchema(HeadlessRuntimeHeartbeatSnapshotSchema, value, label);
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

export const isComposerGuardianStatusResponse = (
	value: unknown,
): value is Static<typeof ComposerGuardianStatusResponseSchema> =>
	Value.Check(ComposerGuardianStatusResponseSchema, value);

export const isComposerGuardianRunResponse = (
	value: unknown,
): value is Static<typeof ComposerGuardianRunResponseSchema> =>
	Value.Check(ComposerGuardianRunResponseSchema, value);

export const isComposerGuardianConfigRequest = (
	value: unknown,
): value is Static<typeof ComposerGuardianConfigRequestSchema> =>
	Value.Check(ComposerGuardianConfigRequestSchema, value);

export const isComposerGuardianConfigResponse = (
	value: unknown,
): value is Static<typeof ComposerGuardianConfigResponseSchema> =>
	Value.Check(ComposerGuardianConfigResponseSchema, value);

export const isComposerPlanStatusResponse = (
	value: unknown,
): value is Static<typeof ComposerPlanStatusResponseSchema> =>
	Value.Check(ComposerPlanStatusResponseSchema, value);

export const isComposerPlanRequest = (
	value: unknown,
): value is Static<typeof ComposerPlanRequestSchema> =>
	Value.Check(ComposerPlanRequestSchema, value);

export const isComposerPlanActionResponse = (
	value: unknown,
): value is Static<typeof ComposerPlanActionResponseSchema> =>
	Value.Check(ComposerPlanActionResponseSchema, value);

export const isComposerBackgroundStatusResponse = (
	value: unknown,
): value is Static<typeof ComposerBackgroundStatusResponseSchema> =>
	Value.Check(ComposerBackgroundStatusResponseSchema, value);

export const isComposerBackgroundHistoryResponse = (
	value: unknown,
): value is Static<typeof ComposerBackgroundHistoryResponseSchema> =>
	Value.Check(ComposerBackgroundHistoryResponseSchema, value);

export const isComposerBackgroundPathResponse = (
	value: unknown,
): value is Static<typeof ComposerBackgroundPathResponseSchema> =>
	Value.Check(ComposerBackgroundPathResponseSchema, value);

export const isComposerBackgroundUpdateRequest = (
	value: unknown,
): value is Static<typeof ComposerBackgroundUpdateRequestSchema> =>
	Value.Check(ComposerBackgroundUpdateRequestSchema, value);

export const isComposerBackgroundUpdateResponse = (
	value: unknown,
): value is Static<typeof ComposerBackgroundUpdateResponseSchema> =>
	Value.Check(ComposerBackgroundUpdateResponseSchema, value);

export const isComposerApprovalsStatusResponse = (
	value: unknown,
): value is Static<typeof ComposerApprovalsStatusResponseSchema> =>
	Value.Check(ComposerApprovalsStatusResponseSchema, value);

export const isComposerApprovalsUpdateRequest = (
	value: unknown,
): value is Static<typeof ComposerApprovalsUpdateRequestSchema> =>
	Value.Check(ComposerApprovalsUpdateRequestSchema, value);

export const isComposerApprovalsUpdateResponse = (
	value: unknown,
): value is Static<typeof ComposerApprovalsUpdateResponseSchema> =>
	Value.Check(ComposerApprovalsUpdateResponseSchema, value);

export const isComposerFrameworkStatusResponse = (
	value: unknown,
): value is Static<typeof ComposerFrameworkStatusResponseSchema> =>
	Value.Check(ComposerFrameworkStatusResponseSchema, value);

export const isComposerFrameworkListResponse = (
	value: unknown,
): value is Static<typeof ComposerFrameworkListResponseSchema> =>
	Value.Check(ComposerFrameworkListResponseSchema, value);

export const isComposerFrameworkUpdateRequest = (
	value: unknown,
): value is Static<typeof ComposerFrameworkUpdateRequestSchema> =>
	Value.Check(ComposerFrameworkUpdateRequestSchema, value);

export const isComposerFrameworkUpdateResponse = (
	value: unknown,
): value is Static<typeof ComposerFrameworkUpdateResponseSchema> =>
	Value.Check(ComposerFrameworkUpdateResponseSchema, value);

export const isComposerUndoStatusResponse = (
	value: unknown,
): value is Static<typeof ComposerUndoStatusResponseSchema> =>
	Value.Check(ComposerUndoStatusResponseSchema, value);

export const isComposerUndoHistoryResponse = (
	value: unknown,
): value is Static<typeof ComposerUndoHistoryResponseSchema> =>
	Value.Check(ComposerUndoHistoryResponseSchema, value);

export const isComposerUndoRequest = (
	value: unknown,
): value is Static<typeof ComposerUndoRequestSchema> =>
	Value.Check(ComposerUndoRequestSchema, value);

export const isComposerUndoOperationResponse = (
	value: unknown,
): value is Static<typeof ComposerUndoOperationResponseSchema> =>
	Value.Check(ComposerUndoOperationResponseSchema, value);

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

export function assertComposerChatRequest(
	value: unknown,
): asserts value is Static<typeof ComposerChatRequestSchema> {
	assertSchema(ComposerChatRequestSchema, value, "ComposerChatRequest");
}

export function assertComposerAgentEvent(
	value: unknown,
): asserts value is Static<typeof ComposerAgentEventSchema> {
	assertSchema(ComposerAgentEventSchema, value, "ComposerAgentEvent");
}

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

export const assertComposerGuardianStatusResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerGuardianStatusResponseSchema> =>
	assertSchema(
		ComposerGuardianStatusResponseSchema,
		value,
		"ComposerGuardianStatusResponse",
	);

export const assertComposerGuardianRunResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerGuardianRunResponseSchema> =>
	assertSchema(
		ComposerGuardianRunResponseSchema,
		value,
		"ComposerGuardianRunResponse",
	);

export const assertComposerGuardianConfigRequest = (
	value: unknown,
): asserts value is Static<typeof ComposerGuardianConfigRequestSchema> =>
	assertSchema(
		ComposerGuardianConfigRequestSchema,
		value,
		"ComposerGuardianConfigRequest",
	);

export const assertComposerGuardianConfigResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerGuardianConfigResponseSchema> =>
	assertSchema(
		ComposerGuardianConfigResponseSchema,
		value,
		"ComposerGuardianConfigResponse",
	);

export const assertComposerPlanStatusResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerPlanStatusResponseSchema> =>
	assertSchema(
		ComposerPlanStatusResponseSchema,
		value,
		"ComposerPlanStatusResponse",
	);

export const assertComposerPlanRequest = (
	value: unknown,
): asserts value is Static<typeof ComposerPlanRequestSchema> =>
	assertSchema(ComposerPlanRequestSchema, value, "ComposerPlanRequest");

export const assertComposerPlanActionResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerPlanActionResponseSchema> =>
	assertSchema(
		ComposerPlanActionResponseSchema,
		value,
		"ComposerPlanActionResponse",
	);

export const assertComposerBackgroundStatusResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerBackgroundStatusResponseSchema> =>
	assertSchema(
		ComposerBackgroundStatusResponseSchema,
		value,
		"ComposerBackgroundStatusResponse",
	);

export const assertComposerBackgroundHistoryResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerBackgroundHistoryResponseSchema> =>
	assertSchema(
		ComposerBackgroundHistoryResponseSchema,
		value,
		"ComposerBackgroundHistoryResponse",
	);

export const assertComposerBackgroundPathResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerBackgroundPathResponseSchema> =>
	assertSchema(
		ComposerBackgroundPathResponseSchema,
		value,
		"ComposerBackgroundPathResponse",
	);

export const assertComposerBackgroundUpdateRequest = (
	value: unknown,
): asserts value is Static<typeof ComposerBackgroundUpdateRequestSchema> =>
	assertSchema(
		ComposerBackgroundUpdateRequestSchema,
		value,
		"ComposerBackgroundUpdateRequest",
	);

export const assertComposerBackgroundUpdateResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerBackgroundUpdateResponseSchema> =>
	assertSchema(
		ComposerBackgroundUpdateResponseSchema,
		value,
		"ComposerBackgroundUpdateResponse",
	);

export const assertComposerApprovalsStatusResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerApprovalsStatusResponseSchema> =>
	assertSchema(
		ComposerApprovalsStatusResponseSchema,
		value,
		"ComposerApprovalsStatusResponse",
	);

export const assertComposerApprovalsUpdateRequest = (
	value: unknown,
): asserts value is Static<typeof ComposerApprovalsUpdateRequestSchema> =>
	assertSchema(
		ComposerApprovalsUpdateRequestSchema,
		value,
		"ComposerApprovalsUpdateRequest",
	);

export const assertComposerApprovalsUpdateResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerApprovalsUpdateResponseSchema> =>
	assertSchema(
		ComposerApprovalsUpdateResponseSchema,
		value,
		"ComposerApprovalsUpdateResponse",
	);

export const assertComposerFrameworkStatusResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerFrameworkStatusResponseSchema> =>
	assertSchema(
		ComposerFrameworkStatusResponseSchema,
		value,
		"ComposerFrameworkStatusResponse",
	);

export const assertComposerFrameworkListResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerFrameworkListResponseSchema> =>
	assertSchema(
		ComposerFrameworkListResponseSchema,
		value,
		"ComposerFrameworkListResponse",
	);

export const assertComposerFrameworkUpdateRequest = (
	value: unknown,
): asserts value is Static<typeof ComposerFrameworkUpdateRequestSchema> =>
	assertSchema(
		ComposerFrameworkUpdateRequestSchema,
		value,
		"ComposerFrameworkUpdateRequest",
	);

export const assertComposerFrameworkUpdateResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerFrameworkUpdateResponseSchema> =>
	assertSchema(
		ComposerFrameworkUpdateResponseSchema,
		value,
		"ComposerFrameworkUpdateResponse",
	);

export const assertComposerUndoStatusResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerUndoStatusResponseSchema> =>
	assertSchema(
		ComposerUndoStatusResponseSchema,
		value,
		"ComposerUndoStatusResponse",
	);

export const assertComposerUndoHistoryResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerUndoHistoryResponseSchema> =>
	assertSchema(
		ComposerUndoHistoryResponseSchema,
		value,
		"ComposerUndoHistoryResponse",
	);

export const assertComposerUndoRequest = (
	value: unknown,
): asserts value is Static<typeof ComposerUndoRequestSchema> =>
	assertSchema(ComposerUndoRequestSchema, value, "ComposerUndoRequest");

export const assertComposerUndoOperationResponse = (
	value: unknown,
): asserts value is Static<typeof ComposerUndoOperationResponseSchema> =>
	assertSchema(
		ComposerUndoOperationResponseSchema,
		value,
		"ComposerUndoOperationResponse",
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
