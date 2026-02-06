/**
 * Model Resolution - Provider and model resolution from CLI arguments.
 *
 * Extracts the provider/model resolution chain from main.ts Phase 8:
 * slash-format parsing, alias lookup, provider-agnostic search,
 * factory defaults, validation, and credential check.
 *
 * @module bootstrap/model-resolution-setup
 */

import chalk from "chalk";
import type { Api, Model } from "../agent/types.js";
import {
	findModelById,
	getFactoryDefaultModelSelection,
	getSupportedProviders,
	resolveAlias,
	resolveModel,
} from "../models/registry.js";
import type { AuthCredential } from "../providers/auth.js";
import { PolicyError } from "../safety/policy.js";

export interface ModelResolutionResult {
	provider: string;
	modelId: string;
	model: Model<Api>;
}

/**
 * Resolve provider and model from CLI args, aliases, cross-provider search,
 * and factory defaults. Validates credentials and policy.
 *
 * @throws Error with user-facing message on validation failures
 */
export async function resolveModelFromArgs(params: {
	parsedProvider?: string;
	parsedModel?: string;
	requireCredential: (
		providerName: string,
		fatal: boolean,
	) => Promise<AuthCredential>;
}): Promise<ModelResolutionResult> {
	const { parsedProvider, parsedModel, requireCredential } = params;
	let provider = parsedProvider;
	let modelId = parsedModel;

	// Check if model uses provider/modelId format (e.g., "bedrock/anthropic.claude-v3")
	if (modelId && !provider && modelId.includes("/")) {
		const slashIndex = modelId.indexOf("/");
		const maybeProvider = modelId.slice(0, slashIndex);
		const maybeModelId = modelId.slice(slashIndex + 1);
		if (maybeProvider && maybeModelId && !maybeProvider.includes(".")) {
			provider = maybeProvider;
			modelId = maybeModelId;
			console.log(
				chalk.dim(`Parsed model: ${parsedModel} → ${provider}/${modelId}`),
			);
		}
	}

	// Check if model is an alias
	if (modelId && !provider) {
		const resolved = resolveAlias(modelId);
		if (resolved) {
			provider = resolved.provider;
			modelId = resolved.modelId;
			console.log(
				chalk.dim(`Using alias: ${parsedModel} → ${provider}/${modelId}`),
			);
		}
	}

	// Search for model across all providers
	if (modelId && !provider) {
		const foundModel = findModelById(modelId);
		if (foundModel) {
			provider = foundModel.provider;
			console.log(chalk.dim(`Found model: ${modelId} (provider: ${provider})`));
		}
	}

	// Apply factory defaults
	if (!provider || !modelId) {
		const factoryDefault = getFactoryDefaultModelSelection();
		if (factoryDefault) {
			if (!provider) {
				provider = factoryDefault.provider;
			}
			if (!modelId) {
				modelId = factoryDefault.modelId;
			}
		}
	}

	provider ??= "anthropic";
	modelId ??= "claude-opus-4-5-20251101";

	// Validate provider
	const supportedProviders = new Set(getSupportedProviders());
	if (!supportedProviders.has(provider)) {
		throw new Error(
			`Unknown provider "${provider}". Supported providers: ${Array.from(
				supportedProviders,
			)
				.sort()
				.join(", ")}`,
		);
	}

	await requireCredential(provider, false);

	// Resolve model with policy check
	let model: ReturnType<typeof resolveModel> | undefined;
	try {
		model = resolveModel(provider, modelId);
	} catch (error) {
		if (error instanceof PolicyError) {
			throw new Error(error.message);
		}
		throw error;
	}

	if (!model) {
		throw new Error(
			`Unknown model "${provider}/${modelId}". Check your models config.`,
		);
	}

	return { provider, modelId, model };
}
