import type { IncomingMessage, ServerResponse } from "node:http";
import { Type } from "@sinclair/typebox";
import { compileTypeboxSchema } from "../../utils/typebox-ajv.js";
import {
	ApiError,
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

// Mirror the schema from src/safety/policy.ts for validation
const PolicySchema = Type.Object({
	orgId: Type.Optional(Type.String()),
	tools: Type.Optional(
		Type.Object({
			allowed: Type.Optional(Type.Array(Type.String())),
			blocked: Type.Optional(Type.Array(Type.String())),
		}),
	),
	dependencies: Type.Optional(
		Type.Object({
			allowed: Type.Optional(Type.Array(Type.String())),
			blocked: Type.Optional(Type.Array(Type.String())),
		}),
	),
	paths: Type.Optional(
		Type.Object({
			allowed: Type.Optional(Type.Array(Type.String())),
			blocked: Type.Optional(Type.Array(Type.String())),
		}),
	),
	network: Type.Optional(
		Type.Object({
			allowedHosts: Type.Optional(Type.Array(Type.String())),
			blockedHosts: Type.Optional(Type.Array(Type.String())),
			blockLocalhost: Type.Optional(Type.Boolean()),
			blockPrivateIPs: Type.Optional(Type.Boolean()),
		}),
	),
	models: Type.Optional(
		Type.Object({
			allowed: Type.Optional(Type.Array(Type.String())),
			blocked: Type.Optional(Type.Array(Type.String())),
		}),
	),
	limits: Type.Optional(
		Type.Object({
			maxTokensPerSession: Type.Optional(Type.Number()),
			maxSessionDurationMinutes: Type.Optional(Type.Number()),
			maxConcurrentSessions: Type.Optional(Type.Number()),
		}),
	),
});

const validatePolicySchema = compileTypeboxSchema(PolicySchema);

export async function handlePolicyValidate(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
): Promise<void> {
	if (req.method !== "POST") {
		respondWithApiError(
			res,
			new ApiError(405, "Method not allowed"),
			405,
			corsHeaders,
		);
		return;
	}

	try {
		// Use readJsonBody with default 1MB limit to prevent DoS
		let parsed: unknown;
		try {
			parsed = await readJsonBody<unknown>(req);
		} catch (error) {
			if (error instanceof ApiError && error.statusCode === 413) {
				sendJson(
					res,
					413,
					{
						valid: false,
						errors: [{ message: "Payload too large (max 1MB)" }],
					},
					corsHeaders,
					req,
				);
				return;
			}
			sendJson(
				res,
				400,
				{
					valid: false,
					errors: [{ message: "Invalid JSON syntax" }],
				},
				corsHeaders,
				req,
			);
			return;
		}

		// Validate against schema
		if (!validatePolicySchema(parsed)) {
			const errors =
				validatePolicySchema.errors?.map((e) => ({
					path: e.instancePath || "/",
					message: e.message || "Validation error",
					keyword: e.keyword,
				})) || [];

			sendJson(
				res,
				200,
				{
					valid: false,
					errors,
				},
				corsHeaders,
				req,
			);
			return;
		}

		sendJson(
			res,
			200,
			{
				valid: true,
				errors: [],
			},
			corsHeaders,
			req,
		);
	} catch (error) {
		respondWithApiError(
			res,
			new ApiError(
				500,
				error instanceof Error ? error.message : "Internal error",
			),
			500,
			corsHeaders,
		);
	}
}
