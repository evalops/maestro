import type { IncomingMessage, ServerResponse } from "node:http";
import {
	loadGuardianState,
	resolveGuardianConfig,
	runGuardian,
	setGuardianEnabled,
} from "../../guardian/index.js";
import { sendJson } from "../server-utils.js";
import {
	type GuardianConfigRequestInput,
	GuardianConfigRequestSchema,
	parseAndValidateJson,
} from "../validation.js";

export async function handleGuardianStatus(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	try {
		const config = resolveGuardianConfig({ root: process.cwd() });
		const state = loadGuardianState();

		sendJson(
			res,
			200,
			{
				enabled: config.enabled,
				state,
			},
			corsHeaders,
		);
	} catch (error) {
		sendJson(
			res,
			500,
			{
				error: "Failed to get guardian status",
				details: error instanceof Error ? error.message : String(error),
			},
			corsHeaders,
		);
	}
}

export async function handleGuardianRun(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	try {
		// Default to checking staged files only, similar to CLI default
		const result = await runGuardian({
			root: process.cwd(),
			target: "staged",
		});

		sendJson(res, 200, result, corsHeaders);
	} catch (error) {
		sendJson(
			res,
			500,
			{
				error: "Failed to run guardian",
				details: error instanceof Error ? error.message : String(error),
			},
			corsHeaders,
		);
	}
}

export async function handleGuardianConfig(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	try {
		const data = await parseAndValidateJson<GuardianConfigRequestInput>(
			req,
			GuardianConfigRequestSchema,
		);

		setGuardianEnabled(data.enabled);

		sendJson(
			res,
			200,
			{
				success: true,
				enabled: data.enabled,
			},
			corsHeaders,
		);
	} catch (error) {
		if (error instanceof Error && "statusCode" in error) {
			// ApiError from parseAndValidateJson
			sendJson(
				res,
				(error as { statusCode: number }).statusCode,
				{
					error: error.message,
				},
				corsHeaders,
			);
		} else {
			sendJson(
				res,
				500,
				{
					error: "Failed to update guardian config",
					details: error instanceof Error ? error.message : String(error),
				},
				corsHeaders,
			);
		}
	}
}
