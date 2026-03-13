#!/usr/bin/env bun
/**
 * Generate src/models/models.generated.ts from models.dev API.
 * This replaces the previous stub and produces a complete MODELS map.
 */

import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { normalizeLLMBaseUrl } from "../src/models/url-normalize.js";
import type { Api } from "../src/agent/types.js";

type ModelsDev = {
	[providerId: string]: {
		id: string;
		name: string;
		api?: string;
		env?: string[];
		models: {
			[modelId: string]: {
				id: string;
				name: string;
				release_date?: string;
				attachment?: boolean;
				reasoning?: boolean;
				temperature?: boolean;
				tool_call?: boolean;
				cost: {
					input: number;
					output: number;
					cache_read?: number;
					cache_write?: number;
				};
				limit: {
					context: number;
					output: number;
				};
				modalities?: {
					input?: string[];
					output?: string[];
				};
				experimental?: boolean;
				status?: "alpha" | "beta" | "deprecated";
			};
		};
	};
};

const BASE_URLS: Record<string, string> = {
	openai: "https://api.openai.com/v1",
	openrouter: "https://openrouter.ai/api/v1",
	groq: "https://api.groq.com/openai/v1",
	anthropic: "https://api.anthropic.com",
	google: "https://generativelanguage.googleapis.com/v1beta",
	cerebras: "https://api.cerebras.ai/v1",
	zai: "https://api.zaidomain.com/v1",
	mistral: "https://api.mistral.ai/v1",
	writer: "https://api.writer.com/v1",
};

const API_BY_PROVIDER: Record<string, string> = {
	openai: "openai-completions",
	openrouter: "openai-completions",
	groq: "openai-completions",
	cerebras: "openai-completions",
	zai: "openai-completions",
	mistral: "openai-completions",
	writer: "openai-completions",
	anthropic: "anthropic-messages",
	google: "google-generative-ai",
};

/**
 * models.dev includes many provider IDs that Composer can't safely assign an API
 * endpoint for. Only emit providers we can map to a known baseUrl; everything
 * else should be configured explicitly via models.json.
 */
const SUPPORTED_PROVIDER_IDS = new Set(Object.keys(BASE_URLS));

export function resolveProviderApi(
	providerId: string,
	registryApi?: string,
): string {
	const cleanApi =
		registryApi && registryApi.startsWith("http") ? undefined : registryApi;

	const mapped = API_BY_PROVIDER[providerId];
	if (mapped) {
		return mapped;
	}

	return cleanApi ?? "openai-completions";
}

function baseUrlFor(providerId: string): string {
	const baseUrl = BASE_URLS[providerId];
	if (!baseUrl) {
		throw new Error(
			`No baseUrl mapping for provider '${providerId}'. Add it to BASE_URLS or configure via models.json.`,
		);
	}
	return baseUrl;
}

export function enforceEndpoint(
	baseUrl: string,
	providerId: string,
	api: string,
): string {
	const rawHasResponses = baseUrl.includes("/responses");
	const rawHasCompletions = baseUrl.includes("/chat/completions");

	if (api === "openai-responses" && rawHasCompletions && !rawHasResponses) {
		throw new Error(
			`Normalized baseUrl missing /responses for provider ${providerId}: ${baseUrl}`,
		);
	}
	if (api === "openai-completions" && rawHasResponses && !rawHasCompletions) {
		throw new Error(
			`Normalized baseUrl missing /chat/completions for provider ${providerId}: ${baseUrl}`,
		);
	}

	const normalized = normalizeLLMBaseUrl(baseUrl, providerId, api as Api);

	const hasResponses = normalized.includes("/responses");
	const hasCompletions = normalized.includes("/chat/completions");

	if (api === "openai-responses" && (!hasResponses || hasCompletions)) {
		throw new Error(
			`Normalized baseUrl missing /responses for provider ${providerId}: ${normalized}`,
		);
	}
	if (api === "openai-completions" && (!hasCompletions || hasResponses)) {
		throw new Error(
			`Normalized baseUrl missing /chat/completions for provider ${providerId}: ${normalized}`,
		);
	}

	return normalized;
}

const CACHE_PATH = join(process.cwd(), ".cache", "models-dev.json");
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const MODELS_DEV_URL = "https://models.dev/api.json";
const ALLOWED_MODEL_HOSTS = new Set(["models.dev", "www.models.dev"]);

function readCache(): ModelsDev | null {
	if (!existsSync(CACHE_PATH)) return null;
	try {
		const raw = readFileSync(CACHE_PATH, "utf8");
		return JSON.parse(raw) as ModelsDev;
	} catch {
		return null;
	}
}

function writeCache(data: ModelsDev) {
	try {
		const dir = dirname(CACHE_PATH);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(CACHE_PATH, JSON.stringify(data), "utf8");
	} catch {
		// ignore cache failures
	}
}

async function fetchModelsDev(): Promise<ModelsDev> {
	const cached = readCache();
	if (cached) {
		const age =
			Date.now() - (existsSync(CACHE_PATH) ? statSync(CACHE_PATH).mtimeMs : 0);
		if (age < CACHE_MAX_AGE_MS) {
			console.log("[generate-models] using cached models.dev data");
			return cached;
		}
	}

	const parsedUrl = new URL(MODELS_DEV_URL);
	if (!ALLOWED_MODEL_HOSTS.has(parsedUrl.hostname)) {
		throw new Error(
			`Blocked registry host ${parsedUrl.hostname}; allowed: ${[
				...ALLOWED_MODEL_HOSTS,
			].join(", ")}`,
		);
	}

	const res = await fetch(parsedUrl.toString(), {
		signal: AbortSignal.timeout(15000),
		headers: { "User-Agent": "composer-generator" },
		integrity:
			process.env.MODELS_DEV_SRI && process.env.MODELS_DEV_SRI.length > 0
				? process.env.MODELS_DEV_SRI
				: undefined,
	});
	if (!res.ok) {
		if (cached) {
			console.warn(
				`[generate-models] fetch failed (${res.status}); falling back to cache`,
			);
			return cached;
		}
		throw new Error(`models.dev responded ${res.status}`);
	}
	const fresh = (await res.json()) as ModelsDev;
	writeCache(fresh);
	return fresh;
}

function toTs(modelObj: Record<string, any>): string {
	return JSON.stringify(modelObj, null, 2)
		.replace(/"(?<key>[a-zA-Z0-9_]+)":/g, (_m, key) => `${key}:`)
		.replace(/"openai-completions"/g, '"openai-completions" as const')
		.replace(/"openai-responses"/g, '"openai-responses" as const')
		.replace(/"anthropic-messages"/g, '"anthropic-messages" as const')
		.replace(/"google-generative-ai"/g, '"google-generative-ai" as const');
}

async function main() {
	const data = await fetchModelsDev();
	const MODELS: Record<string, Record<string, any>> = {};

	for (const [providerId, provider] of Object.entries(data)) {
		if (!SUPPORTED_PROVIDER_IDS.has(providerId)) continue;
		const providerBase = baseUrlFor(providerId);
		for (const [modelId, model] of Object.entries(provider.models)) {
			const api = resolveProviderApi(providerId, provider.api as string | undefined);
			if (!MODELS[providerId]) MODELS[providerId] = {};
			const cost = model.cost ?? {};
			const rawInput = model.modalities?.input ?? ["text"];
			const input = rawInput.filter((m) => m === "text" || m === "image");
			const normalizedInput = input.length > 0 ? input : ["text"];

			MODELS[providerId][modelId] = {
				id: model.id,
				name: model.name,
				api,
				provider: providerId,
				baseUrl: enforceEndpoint(providerBase, providerId, api),
				reasoning: Boolean(model.reasoning ?? false),
				toolUse: Boolean(model.tool_call ?? false),
				input: normalizedInput,
				cost: {
					input: cost.input ?? 0,
					output: cost.output ?? 0,
					cacheRead: cost.cache_read ?? 0,
					cacheWrite: cost.cache_write ?? 0,
				},
				contextWindow: model.limit.context ?? 128000,
				maxTokens: model.limit.output ?? 8192,
			};
		}
	}

	const fileContent = `// This file is auto-generated by scripts/generate-models.ts
// Do not edit manually - run 'npm run generate-models' to update

import type { Model } from "../agent/types.js";

export const MODELS = ${toTs(MODELS)} as Record<string, Record<string, Model<any>>>;
`;

	const defaultOutPath = join(process.cwd(), "src/models/models.generated.ts");
	const outPath = process.env.MODELS_OUT_PATH ?? defaultOutPath;
	writeFileSync(outPath, fileContent);
	console.log(
		`[generate-models] wrote ${outPath} with ${Object.values(MODELS).reduce(
			(sum, p) => sum + Object.keys(p).length,
			0,
		)} models`,
	);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error("[generate-models] failed:", err);
		process.exit(1);
	});
}
