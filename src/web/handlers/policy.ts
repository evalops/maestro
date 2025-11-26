import type { IncomingMessage, ServerResponse } from "node:http";
import { Type } from "@sinclair/typebox";
import { compileTypeboxSchema } from "../../utils/typebox-ajv.js";
import { ApiError, respondWithApiError, sendJson } from "../server-utils.js";

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
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(chunk as Buffer);
		}
		const body = Buffer.concat(chunks).toString("utf-8");

		// First check if it's valid JSON
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
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

		// Then validate against schema
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
