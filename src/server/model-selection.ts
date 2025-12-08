import {
	type RegisteredModel,
	getFactoryDefaultModelSelection,
	getRegisteredModels,
	resolveAlias,
} from "../models/registry.js";
import { ApiError } from "./server-utils.js";

export interface ModelSelection {
	provider: string;
	modelId: string;
}

interface ParsedModelInput {
	provider?: string;
	modelId?: string;
}

export function parseModelInput(modelInput?: string | null): ParsedModelInput {
	const normalized = modelInput?.trim();
	if (!normalized) {
		return {};
	}

	// Prefer explicit provider delimiter ":"
	if (normalized.includes(":")) {
		const parts = normalized.split(":");
		if (parts.length !== 2) {
			throw new ApiError(400, `Invalid model format: "${normalized}"`);
		}
		const [providerPart, modelPart] = parts;
		return {
			provider: providerPart?.trim() || undefined,
			modelId: modelPart?.trim() || undefined,
		};
	}

	// Only treat "/" as provider delimiter when the prefix matches a known provider.
	if (normalized.includes("/")) {
		const [possibleProvider, ...rest] = normalized.split("/");
		if (providerExists(possibleProvider)) {
			const modelId = rest.join("/").trim();
			return {
				provider: possibleProvider.trim() || undefined,
				modelId: modelId || undefined,
			};
		}
	}

	// Otherwise it's a bare model id (which may itself contain "/")
	return { modelId: normalized };
}

function resolveModelAlias(parts: ParsedModelInput): ParsedModelInput {
	if (!parts.modelId) {
		return parts;
	}
	const alias = resolveAlias(parts.modelId);
	if (!alias) {
		return parts;
	}
	if (parts.provider && parts.provider !== alias.provider) {
		throw new ApiError(
			400,
			`Alias "${parts.modelId}" maps to ${alias.provider}/${alias.modelId}, but provider "${parts.provider}" was requested`,
		);
	}
	return { provider: alias.provider, modelId: alias.modelId };
}

function providerExists(name: string | undefined): boolean {
	if (!name) return false;
	const trimmed = name.trim();
	if (!trimmed) return false;
	return getRegisteredModels().some((m) => m.provider === trimmed);
}

export function determineModelSelection(
	modelInput: string | null | undefined,
	defaultProvider: string,
	defaultModelId: string,
): ModelSelection {
	let parts = parseModelInput(modelInput);
	parts = resolveModelAlias(parts);

	if (parts.provider && !parts.modelId) {
		throw new ApiError(400, "Model id is required when specifying a provider");
	}

	if (!parts.provider && parts.modelId) {
		parts.provider = defaultProvider;
	}

	if (!parts.provider && !parts.modelId) {
		const factoryDefault = getFactoryDefaultModelSelection();
		if (factoryDefault) {
			return {
				provider: factoryDefault.provider,
				modelId: factoryDefault.modelId,
			};
		}
		return {
			provider: defaultProvider,
			modelId: defaultModelId,
		};
	}

	const finalProvider = parts.provider;
	const finalModelId = parts.modelId;
	if (!finalProvider || !finalModelId) {
		throw new ApiError(400, "Model selection is incomplete");
	}

	return {
		provider: finalProvider,
		modelId: finalModelId,
	};
}

export function getRegisteredModelOrThrow(
	selection: ModelSelection,
): RegisteredModel {
	const registeredModel = getRegisteredModels().find(
		(entry) =>
			entry.provider === selection.provider && entry.id === selection.modelId,
	);
	if (!registeredModel) {
		throw new ApiError(
			404,
			`Model ${selection.provider}/${selection.modelId} not found in registry`,
		);
	}
	return registeredModel;
}
