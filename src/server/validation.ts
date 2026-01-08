import type { IncomingMessage } from "node:http";
import {
	ComposerChatRequestSchema,
	ComposerModelSetSchema,
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
	const validate =
		typeof schema === "object" && schema !== null
			? (validatorCache.get(schema) ??
				(() => {
					const compiled = ajvInstance.compile<T>(schema);
					validatorCache.set(schema, compiled);
					return compiled;
				})())
			: ajvInstance.compile<T>(schema);
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
