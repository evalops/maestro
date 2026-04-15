import type { IncomingMessage } from "node:http";
import {
	ComposerApprovalsUpdateRequestSchema,
	ComposerBackgroundUpdateRequestSchema,
	ComposerChatRequestSchema,
	ComposerCommandPrefsUpdateSchema,
	ComposerFrameworkUpdateRequestSchema,
	ComposerGuardianConfigRequestSchema,
	ComposerModelSetSchema,
	ComposerPlanRequestSchema,
	ComposerPromptSuggestionRequestSchema,
	ComposerUndoRequestSchema,
} from "@evalops/contracts";
import type { Static } from "@sinclair/typebox";
import {
	Ajv,
	type AnySchema,
	type ErrorObject,
	type ValidateFunction,
} from "ajv";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";
import { resolveDefaultExport } from "../utils/module-interop.js";
import { ApiError, readRequestBody } from "./server-utils.js";

// ESM/CJS interop: ajv-formats default may be nested under .default in some loaders
const addFormats = resolveDefaultExport<FormatsPlugin>(addFormatsModule);

const ajvInstance = new Ajv({
	allErrors: true,
	strict: false,
});
addFormats(ajvInstance);

const validatorCache = new WeakMap<object, ValidateFunction>();

export const ChatRequestSchema = ComposerChatRequestSchema;
export type ChatRequestInput = Static<typeof ChatRequestSchema>;

export const ModelSetSchema = ComposerModelSetSchema;
export type ModelSetInput = Static<typeof ModelSetSchema>;

export const CommandPrefsUpdateSchema = ComposerCommandPrefsUpdateSchema;
export type CommandPrefsUpdateInput = Static<typeof CommandPrefsUpdateSchema>;

export const GuardianConfigRequestSchema = ComposerGuardianConfigRequestSchema;
export type GuardianConfigRequestInput = Static<
	typeof GuardianConfigRequestSchema
>;

export const PlanRequestSchema = ComposerPlanRequestSchema;
export type PlanRequestInput = Static<typeof PlanRequestSchema>;

export const PromptSuggestionRequestSchema =
	ComposerPromptSuggestionRequestSchema;
export type PromptSuggestionRequestInput = Static<
	typeof PromptSuggestionRequestSchema
>;

export const BackgroundUpdateRequestSchema =
	ComposerBackgroundUpdateRequestSchema;
export type BackgroundUpdateRequestInput = Static<
	typeof BackgroundUpdateRequestSchema
>;

export const ApprovalsUpdateRequestSchema =
	ComposerApprovalsUpdateRequestSchema;
export type ApprovalsUpdateRequestInput = Static<
	typeof ApprovalsUpdateRequestSchema
>;

export const FrameworkUpdateRequestSchema =
	ComposerFrameworkUpdateRequestSchema;
export type FrameworkUpdateRequestInput = Static<
	typeof FrameworkUpdateRequestSchema
>;

export const UndoRequestSchema = ComposerUndoRequestSchema;
export type UndoRequestInput = Static<typeof UndoRequestSchema>;

export async function parseAndValidateJson<T>(
	req: IncomingMessage,
	schema: AnySchema,
): Promise<T> {
	const raw = await readRequestBody(req);
	if (!raw.length) {
		throw new ApiError(400, "Request body required");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.toString());
	} catch {
		throw new ApiError(400, "Invalid JSON payload");
	}
	return validatePayload<T>(parsed, schema, "body");
}

export function validatePayload<T>(
	payload: unknown,
	schema: AnySchema,
	label = "body",
): T {
	const validate =
		typeof schema === "object" && schema !== null
			? (validatorCache.get(schema) ??
				(() => {
					const compiled = ajvInstance.compile<T>(schema);
					validatorCache.set(schema, compiled);
					return compiled;
				})())
			: ajvInstance.compile<T>(schema);
	if (!validate(payload)) {
		const message =
			validate.errors
				?.map(
					(err: ErrorObject) => `${err.instancePath || label} ${err.message}`,
				)
				.join("; ") || "Invalid request body";
		throw new ApiError(400, message);
	}
	return payload as T;
}
