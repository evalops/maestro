import type { IncomingMessage } from "node:http";
import { type Static, Type } from "@sinclair/typebox";
import { Ajv, type AnySchema, type ErrorObject } from "ajv";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";
import { ApiError, readRequestBody } from "./server-utils.js";

// ESM/CJS interop: ajv-formats default may be nested under .default in some loaders
const addFormats: FormatsPlugin =
	(addFormatsModule as unknown as { default?: FormatsPlugin }).default ??
	(addFormatsModule as unknown as FormatsPlugin);

const ajvInstance = new Ajv({
	allErrors: true,
	strict: false,
});
addFormats(ajvInstance);

export const ChatRequestSchema = Type.Object({
	messages: Type.Array(
		Type.Object({
			role: Type.String(),
			content: Type.Optional(Type.String()),
		}),
	),
	model: Type.Optional(Type.String()),
	sessionId: Type.Optional(Type.String()),
	thinkingLevel: Type.Optional(Type.String()),
});

export type ChatRequestInput = Static<typeof ChatRequestSchema>;

export const ModelSetSchema = Type.Object({
	model: Type.String({ minLength: 1 }),
});
export type ModelSetInput = Static<typeof ModelSetSchema>;

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
	const validate = ajvInstance.compile<T>(schema);
	if (!validate(parsed)) {
		const message =
			validate.errors
				?.map(
					(err: ErrorObject) => `${err.instancePath || "body"} ${err.message}`,
				)
				.join("; ") || "Invalid request body";
		throw new ApiError(400, message);
	}
	return parsed as T;
}
