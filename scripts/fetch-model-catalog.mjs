#!/usr/bin/env node

/**
 * Regenerate the bundled model catalog snapshot consumed by
 * `packages/tui-rs/src/model_catalog.rs` via `include_str!`.
 *
 * Source data is the MIT-licensed community catalog at models.dev
 * (https://models.dev/api.json). Only tool-capable, non-deprecated models for
 * providers Maestro routes natively are kept. The mapping rules here must stay
 * in sync with `map_models_dev_catalog` in `model_catalog.rs`, which applies
 * the same rules to runtime refreshes.
 *
 * Usage:
 *   node scripts/fetch-model-catalog.mjs [--out <path>] [--timeout-ms <ms>]
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const DEFAULT_TIMEOUT_MS = 20_000;
const DESCRIPTION_MAX_LEN = 120;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join(REPO_ROOT, "packages/tui-rs/src/model_catalog_data.json");

// Maestro provider id -> fixed catalog protocol. OpenAI is per-model below.
const PROVIDER_PROTOCOLS = {
	anthropic: "anthropic",
	google: "google",
	xai: "openai-chat",
	openai: null,
};

/**
 * Mirror of `uses_responses_api` in packages/tui-rs/src/ai/openai.rs:
 * Codex models and gpt-5.x/o3 models use the Responses API.
 */
function openAiProtocol(modelId) {
	return modelId.includes("codex") || modelId.startsWith("gpt-5") || modelId.startsWith("o3")
		? "openai-responses"
		: "openai-chat";
}

function truncate(text, maxLen) {
	if (text.length <= maxLen) {
		return text;
	}
	const cut = text.slice(0, maxLen - 1);
	const lastSpace = cut.lastIndexOf(" ");
	return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`;
}

function mapModel(providerId, modelId, model) {
	const protocol =
		providerId === "openai" ? openAiProtocol(modelId) : PROVIDER_PROTOCOLS[providerId];
	return {
		id: modelId,
		name: typeof model.name === "string" && model.name !== "" ? model.name : modelId,
		provider: providerId,
		description: truncate(
			typeof model.description === "string" && model.description !== ""
				? model.description
				: (model.name ?? modelId),
			DESCRIPTION_MAX_LEN,
		),
		capabilities: {
			protocol,
			tools: true,
			vision: Array.isArray(model.modalities?.input) && model.modalities.input.includes("image"),
			reasoning: model.reasoning === true,
			streaming: true,
			context_tokens: model.limit.context,
			// Per-response output ceiling (reasoning included) from
			// models.dev `limit.output`; omitted when the source lacks it.
			output_tokens:
				Number.isInteger(model.limit?.output) && model.limit.output > 0
					? model.limit.output
					: undefined,
		},
		verification: {
			state: "catalog",
			source: "models.dev",
		},
	};
}

function parseArgs(argv) {
	const args = { out: DEFAULT_OUT, timeoutMs: DEFAULT_TIMEOUT_MS };
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--out") {
			args.out = path.resolve(argv[i + 1]);
			i += 1;
		} else if (argv[i] === "--timeout-ms") {
			args.timeoutMs = Number.parseInt(argv[i + 1], 10);
			i += 1;
		} else {
			throw new Error(`unknown argument: ${argv[i]}`);
		}
	}
	if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
		throw new Error("--timeout-ms must be a positive integer");
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
	let response;
	try {
		response = await fetch(MODELS_DEV_API_URL, {
			signal: controller.signal,
			headers: { accept: "application/json", "user-agent": "maestro-model-catalog-fetcher" },
		});
	} finally {
		clearTimeout(timeout);
	}
	if (!response.ok) {
		throw new Error(`models.dev fetch failed: HTTP ${response.status}`);
	}
	const catalog = await response.json();

	const models = [];
	for (const providerId of Object.keys(PROVIDER_PROTOCOLS)) {
		const providerModels = catalog[providerId]?.models;
		if (!providerModels || typeof providerModels !== "object") {
			throw new Error(`models.dev payload is missing provider "${providerId}"`);
		}
		for (const [modelId, model] of Object.entries(providerModels)) {
			if (model?.tool_call !== true || model?.status === "deprecated") {
				continue;
			}
			const context = model?.limit?.context;
			if (!Number.isInteger(context) || context <= 0) {
				continue;
			}
			models.push(mapModel(providerId, modelId, model));
		}
	}

	if (models.length === 0) {
		throw new Error("models.dev payload produced an empty catalog; refusing to write");
	}

	models.sort(
		(left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
	);

	const snapshot = {
		generated_at: Math.floor(Date.now() / 1000),
		source: MODELS_DEV_API_URL,
		models,
	};

	await writeFile(args.out, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
	const counts = Object.fromEntries(
		Object.keys(PROVIDER_PROTOCOLS).map((providerId) => [
			providerId,
			models.filter((model) => model.provider === providerId).length,
		]),
	);
	console.log(`wrote ${models.length} models to ${path.relative(REPO_ROOT, args.out)}`, counts);
}

main().catch((error) => {
	console.error(`fetch-model-catalog: ${error.message}`);
	process.exitCode = 1;
});
