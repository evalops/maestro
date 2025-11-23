import type { IncomingMessage } from "node:http";
import { type Static, Type } from "@sinclair/typebox";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { ApiError, readRequestBody } from "./server-utils.js";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

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
	schema: unknown,
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
	const validate = ajv.compile<T>(schema as any);
	if (!validate(parsed)) {
		const message =
			validate.errors
				?.map((err) => `${err.instancePath || "body"} ${err.message}`)
				.join("; ") || "Invalid request body";
		throw new ApiError(400, message);
	}
	return parsed;
}
