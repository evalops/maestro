import type { IncomingMessage, ServerResponse } from "node:http";
import { getRegisteredModels } from "../../models/registry.js";
import type { RegisteredModel } from "../../models/registry.js";
import type { WebServerContext } from "../app-context.js";
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

export async function handleModels(
	_req: IncomingMessage,
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

	sendJson(res, 200, { models: modelList }, cors, _req);
}

function respondWithModel(
	res: ServerResponse,
	model: RegisteredModel,
	cors: Record<string, string>,
	req?: IncomingMessage,
) {
	sendJson(
		res,
		200,
		{
			id: model.id,
			provider: model.provider,
			name: model.name || model.id,
			api: model.api,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			cost: model.cost,
			capabilities: {
				streaming: true,
				tools: true,
				vision: model.input?.includes("image") || false,
				reasoning: model.reasoning || false,
			},
			reasoning: model.reasoning,
		},
		cors,
		req,
	);
}

export async function handleModel(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
) {
	const {
		corsHeaders: cors,
		getCurrentSelection,
		ensureCredential,
		setModelSelection: onSelect,
	} = context;
	const defaults = getCurrentSelection();

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
		respondWithModel(res, active, cors, req);
		return;
	}

	if (req.method === "POST") {
		// Remove try/catch, let router handle it
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
		respondWithModel(res, registeredModel, cors, req);
		return;
	}

	res.writeHead(405, {
		"Content-Type": "application/json",
		...cors,
	});
	res.end(JSON.stringify({ error: "Method not allowed" }));
}
