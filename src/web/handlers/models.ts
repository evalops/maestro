import type { IncomingMessage, ServerResponse } from "node:http";
import { getRegisteredModels } from "../../models/registry.js";
import type { RegisteredModel } from "../../models/registry.js";
import type { AuthCredential } from "../../providers/auth.js";
import {
	determineModelSelection,
	getRegisteredModelOrThrow,
} from "../model-selection.js";
import { respondWithApiError, sendJson } from "../server-utils.js";
import {
	type ModelSetInput,
	ModelSetSchema,
	parseAndValidateJson,
} from "../validation.js";

export function handleModels(
	res: ServerResponse,
	cors: Record<string, string>,
) {
	const models = getRegisteredModels();
	const modelList = models.map((m) => ({
		id: m.id,
		provider: m.provider,
		name: m.name || m.id,
		api: m.api,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		cost: m.cost,
		capabilities: {
			streaming: true,
			tools: true,
			vision: m.input?.includes("image") || false,
			reasoning: m.reasoning || false,
		},
	}));

	sendJson(res, 200, { models: modelList }, cors);
}

function respondWithModel(
	res: ServerResponse,
	model: RegisteredModel,
	cors: Record<string, string>,
) {
	sendJson(
		res,
		200,
		{
			id: model.id,
			provider: model.provider,
			name: model.name,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
		},
		cors,
	);
}

export async function handleModel(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	defaults: { provider: string; modelId: string },
	ensureCredential: (provider: string) => Promise<AuthCredential>,
	onSelect?: (model: RegisteredModel) => void,
) {
	if (req.method === "GET") {
		const models = getRegisteredModels();
		const active =
			models.find(
				(entry) =>
					entry.provider === defaults.provider && entry.id === defaults.modelId,
			) ?? models[0];
		if (!active) {
			res.writeHead(404, {
				"Content-Type": "application/json",
				...cors,
			});
			res.end(JSON.stringify({ error: "No models registered" }));
			return;
		}
		respondWithModel(res, active, cors);
		return;
	}

	if (req.method === "POST") {
		try {
			const payload = await parseAndValidateJson<ModelSetInput>(
				req,
				ModelSetSchema,
			);
			const modelInput = payload.model.trim();

			const selection = determineModelSelection(
				modelInput,
				defaults.provider,
				defaults.modelId,
			);
			const registeredModel = getRegisteredModelOrThrow(selection);
			await ensureCredential(registeredModel.provider);
			if (onSelect) onSelect(registeredModel);
			respondWithModel(res, registeredModel, cors);
		} catch (error) {
			respondWithApiError(res, error, 400, cors);
		}
		return;
	}

	res.writeHead(405, {
		"Content-Type": "application/json",
		...cors,
	});
	res.end(JSON.stringify({ error: "Method not allowed" }));
}
