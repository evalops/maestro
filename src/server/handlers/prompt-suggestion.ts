import type { IncomingMessage, ServerResponse } from "node:http";
import type { ComposerPromptSuggestionRequest } from "@evalops/contracts";
import type { WebServerContext } from "../app-context.js";
import { generatePromptSuggestion } from "../prompt-suggestion.js";
import { respondWithApiError, sendJson } from "../server-utils.js";
import {
	type PromptSuggestionRequestInput,
	PromptSuggestionRequestSchema,
	parseAndValidateJson,
} from "../validation.js";

export async function handlePromptSuggestion(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
) {
	if (req.method !== "POST") {
		sendJson(
			res,
			405,
			{ error: "Method not allowed" },
			context.corsHeaders,
			req,
		);
		return;
	}

	try {
		const request = await parseAndValidateJson<PromptSuggestionRequestInput>(
			req,
			PromptSuggestionRequestSchema,
		);
		const result = await generatePromptSuggestion(
			request as ComposerPromptSuggestionRequest,
			{
				getRegisteredModel: context.getRegisteredModel,
				getCurrentSelection: context.getCurrentSelection,
				createBackgroundAgent: context.createBackgroundAgent,
			},
		);
		sendJson(res, 200, result, context.corsHeaders, req);
	} catch (error) {
		respondWithApiError(res, error, 500, context.corsHeaders, req);
	}
}
