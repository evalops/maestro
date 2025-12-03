import type { IncomingMessage } from "node:http";
import { type Static, Type } from "@sinclair/typebox";
import AjvPkg, { type ErrorObject, type Options as AjvOptions } from "ajv";
import addFormats from "ajv-formats";
import { ApiError, readRequestBody } from "./server-utils.js";

const AjvCtor: new (options?: AjvOptions) => import("ajv").default =
	// biome-ignore lint/suspicious/noExplicitAny: ESM/CJS interop requires any for module default
	(AjvPkg as any).default ?? AjvPkg;
const ajvInstance = new AjvCtor({
	allErrors: true,
	strict: false,
});
// biome-ignore lint/suspicious/noExplicitAny: ESM/CJS interop requires any for module default
const addFormatsFn = (addFormats as any).default ?? addFormats;
addFormatsFn(ajvInstance);

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
	// biome-ignore lint/suspicious/noExplicitAny: AJV schema type incompatible with unknown
	const validate = ajvInstance.compile<T>(schema as any);
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
