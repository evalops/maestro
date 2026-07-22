/**
 * Pure config presentation helpers (not a CLI entrypoint).
 *
 * The `maestro config` CLI entrypoint is native (`packages/tui-rs/src/config_cli.rs`).
 * This module keeps `getProviderPresets` and `buildConfigShowSections` for unit
 * tests and shared preset inspection.
 */

import chalk from "chalk";
import {
	badge,
	muted,
	sectionHeading,
	separator as themedSeparator,
} from "../style/theme.js";
import { getHomeDir } from "../utils/path-expansion.js";

import type { Api } from "../agent/types.js";
import type { ConfigInspection } from "../models/registry.js";
import {
	DEFAULT_EVALOPS_MANAGED_GATEWAY_BASE_URL,
	getEvalOpsManagedProviderDefinitions,
} from "../providers/evalops-managed.js";

type ProviderPreset = {
	id: string;
	name: string;
	api: Api;
	defaultModel: string;
	baseUrl?: string;
	requiresApiKey: boolean;
	apiKeyEnv?: string;
	note?: string;
	contextWindow?: number;
	maxTokens?: number;
};

function getManagedGatewayBaseUrl(): string {
	return (
		process.env.MAESTRO_LLM_GATEWAY_URL?.trim() ||
		DEFAULT_EVALOPS_MANAGED_GATEWAY_BASE_URL
	);
}

function getManagedGatewayProviderPresets(): ProviderPreset[] {
	return getEvalOpsManagedProviderDefinitions().map((definition) => ({
		id: definition.id,
		name: definition.name,
		api: definition.api,
		defaultModel: definition.defaultModel,
		baseUrl: getManagedGatewayBaseUrl(),
		requiresApiKey: false,
		note: definition.note,
	}));
}

export function getProviderPresets(): ProviderPreset[] {
	return [
		{
			id: "anthropic",
			name: "Anthropic (Claude)",
			api: "anthropic-messages",
			defaultModel: "claude-opus-4-6",
			baseUrl: "https://api.anthropic.com",
			requiresApiKey: true,
			apiKeyEnv: "ANTHROPIC_API_KEY",
			contextWindow: 1000000,
			maxTokens: 128000,
		},
		{
			id: "openai",
			name: "OpenAI (Responses)",
			api: "openai-responses",
			defaultModel: "gpt-4o-mini",
			baseUrl: "https://api.openai.com/v1",
			requiresApiKey: true,
			apiKeyEnv: "OPENAI_API_KEY",
		},
		{
			id: "groq",
			name: "Groq",
			api: "openai-completions",
			defaultModel: "llama-3.3-70b-versatile",
			baseUrl: "https://api.groq.com/openai/v1",
			requiresApiKey: true,
			apiKeyEnv: "GROQ_API_KEY",
		},
		{
			id: "openrouter",
			name: "OpenRouter",
			api: "openai-completions",
			defaultModel: "openai/o4-mini",
			baseUrl: "https://openrouter.ai/api/v1",
			requiresApiKey: true,
			apiKeyEnv: "OPENROUTER_API_KEY",
			note: "Supports many upstreams; accepts OpenAI-compatible keys",
		},
		...getManagedGatewayProviderPresets(),
		{
			id: "google-gemini",
			name: "Google Gemini API",
			api: "google-generative-ai",
			defaultModel: "gemini-2.0-flash",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			requiresApiKey: true,
			apiKeyEnv: "GEMINI_API_KEY",
		},
		{
			id: "google-gemini-cli",
			name: "Google Gemini CLI (Cloud Code Assist)",
			api: "google-gemini-cli",
			defaultModel: "gemini-2.5-flash",
			baseUrl: "https://cloudcode-pa.googleapis.com",
			requiresApiKey: false,
			note: "Requires OAuth via /login (token includes projectId)",
		},
		{
			id: "google-antigravity",
			name: "Google Antigravity (Sandbox)",
			api: "google-gemini-cli",
			defaultModel: "gemini-3-pro-high",
			baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
			requiresApiKey: false,
			note: "Requires OAuth via /login (token includes projectId)",
		},
		{
			id: "vertex-ai",
			name: "Google Vertex AI (Claude/Gemini)",
			api: "anthropic-messages",
			defaultModel: "claude-3-7-sonnet@20250219",
			baseUrl: "https://us-central1-aiplatform.googleapis.com/v1beta1",
			requiresApiKey: false,
			note: "Uses ADC; set GOOGLE_APPLICATION_CREDENTIALS or gcloud login",
		},
		{
			id: "bedrock",
			name: "AWS Bedrock",
			api: "openai-completions",
			defaultModel: "anthropic.claude-3-7-sonnet-20250219-v1:0",
			requiresApiKey: false,
			note: "Uses AWS credentials + region envs",
		},
		{
			id: "mistral",
			name: "Mistral",
			api: "openai-completions",
			defaultModel: "mistral-large-latest",
			baseUrl: "https://api.mistral.ai/v1",
			requiresApiKey: true,
			apiKeyEnv: "MISTRAL_API_KEY",
		},
		{
			id: "deepseek",
			name: "DeepSeek",
			api: "openai-completions",
			defaultModel: "deepseek-chat",
			baseUrl: "https://api.deepseek.com/v1",
			requiresApiKey: true,
			apiKeyEnv: "DEEPSEEK_API_KEY",
			contextWindow: 131072,
			maxTokens: 8192,
		},
		{
			id: "moonshot",
			name: "Moonshot AI (Kimi)",
			api: "openai-completions",
			defaultModel: "kimi-k2.6",
			baseUrl: "https://api.moonshot.ai/v1",
			requiresApiKey: true,
			apiKeyEnv: "MOONSHOT_API_KEY",
			contextWindow: 262144,
			maxTokens: 16384,
			note: "International endpoint; use https://api.moonshot.cn/v1 in mainland China. KIMI_API_KEY is also accepted.",
		},
		{
			id: "dashscope",
			name: "Alibaba Qwen (DashScope)",
			api: "openai-completions",
			defaultModel: "qwen3-max",
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
			requiresApiKey: true,
			apiKeyEnv: "DASHSCOPE_API_KEY",
			contextWindow: 262144,
			maxTokens: 32768,
			note: "International endpoint; use https://dashscope.aliyuncs.com/compatible-mode/v1 in mainland China. QWEN_API_KEY is also accepted.",
		},
		{
			id: "minimax",
			name: "MiniMax",
			api: "openai-completions",
			defaultModel: "MiniMax-M2",
			baseUrl: "https://api.minimax.io/v1",
			requiresApiKey: true,
			apiKeyEnv: "MINIMAX_API_KEY",
			contextWindow: 204800,
			maxTokens: 16384,
			note: "International endpoint; use https://api.minimaxi.com/v1 in mainland China.",
		},
		{
			id: "zai",
			name: "Z.ai (Zhipu GLM)",
			api: "openai-completions",
			defaultModel: "glm-4.6",
			baseUrl: "https://api.z.ai/api/coding/paas/v4",
			requiresApiKey: true,
			apiKeyEnv: "ZAI_API_KEY",
			contextWindow: 131072,
			maxTokens: 98304,
			note: "International endpoint; use https://open.bigmodel.cn/api/paas/v4 in mainland China.",
		},
		{
			id: "lmstudio",
			name: "LM Studio (local)",
			api: "openai-responses",
			defaultModel: "lmstudio/gemma-3n",
			baseUrl: "http://127.0.0.1:1234/v1",
			requiresApiKey: false,
		},
		{
			id: "ollama",
			name: "Ollama (local)",
			api: "openai-responses",
			defaultModel: "ollama/llama3.2",
			baseUrl: "http://localhost:11434/v1",
			requiresApiKey: false,
		},
	];
}

export interface ConfigShowRenderOptions {
	hierarchy: string[];
	homeDir?: string;
	disableColors?: boolean;
}

// Adapted from ansi-regex (MIT) to cover CSI and OSC escape sequences.
const ANSI_STRING_TERMINATORS = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
const ANSI_OSC_SEQUENCE = `(?:\\u001B\\][\\s\\S]*?${ANSI_STRING_TERMINATORS})`;
const ANSI_CSI_SEQUENCE =
	"[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
const ANSI_ESCAPE_SEQUENCE = new RegExp(
	`${ANSI_OSC_SEQUENCE}|${ANSI_CSI_SEQUENCE}`,
	"g",
);

function stripAnsi(value: string): string {
	return value.replace(ANSI_ESCAPE_SEQUENCE, "");
}

const normalizeForCompare = (value: string): string =>
	process.platform === "win32" ? value.toLowerCase() : value;

function replaceHomePrefix(path: string, homeDir: string): string {
	const normalizedPath = path.replace(/\\/g, "/");
	const normalizedHome = homeDir.replace(/\\/g, "/");
	const pathCheck = normalizeForCompare(normalizedPath);
	const homeCheck = normalizeForCompare(normalizedHome);
	if (pathCheck === homeCheck) {
		return "~";
	}
	if (pathCheck.startsWith(`${homeCheck}/`)) {
		return `~${normalizedPath.slice(normalizedHome.length)}`;
	}
	return path;
}

export function buildConfigShowSections(
	inspection: ConfigInspection,
	options: ConfigShowRenderOptions,
): string[] {
	const homeDir = options.homeDir ?? getHomeDir();
	const rel = (path: string) => replaceHomePrefix(path, homeDir);
	const output: string[] = [];

	output.push(sectionHeading("Configuration Inspection"));
	output.push("");
	output.push(badge("Config Sources", undefined, "info"));
	for (const source of inspection.sources) {
		const status = source.exists
			? badge("present", undefined, "success")
			: badge("missing", undefined, "warn");
		const mark = options.hierarchy.includes(source.path) ? "•" : " ";
		output.push(`  ${mark} ${status} ${muted(rel(source.path))}`);
	}
	output.push("");

	if (inspection.providers.length > 0) {
		output.push(
			badge(`Providers (${inspection.providers.length})`, undefined, "info"),
		);
		for (const provider of inspection.providers) {
			const isOverrideOnly = provider.modelCount === 0;
			const heading = `${chalk.cyan(provider.id)} ${muted(
				`(${provider.modelCount} models)`,
			)}`;
			const enabledBadge = provider.enabled
				? badge("enabled", undefined, "success")
				: badge("disabled", undefined, "warn");
			const metaBadges: string[] = [];
			if (isOverrideOnly) {
				metaBadges.push(badge("override-only", undefined, "info"));
				if (provider.apiKeySource) {
					metaBadges.push(badge("API key", provider.apiKeySource, "success"));
				}
			} else {
				const keyBadge = provider.apiKeySource
					? badge("API key", provider.apiKeySource, "success")
					: badge("API key missing", undefined, "warn");
				metaBadges.push(keyBadge);
			}
			metaBadges.push(enabledBadge);
			const metaLine = metaBadges.join(` ${themedSeparator()} `);
			output.push(`  ${heading} ${themedSeparator()} ${metaLine}`);
			output.push(`     ${muted(provider.name)}`);
			output.push(`     ${muted(`Base URL: ${provider.baseUrl}`)}`);
			if (provider.options && Object.keys(provider.options).length > 0) {
				output.push(muted(`     Options: ${JSON.stringify(provider.options)}`));
			}
			if (provider.models.length <= 3) {
				for (const model of provider.models) {
					output.push(muted(`       • ${formatModelLabel(model)}`));
				}
			} else {
				const firstModel = provider.models[0];
				const secondModel = provider.models[1];
				if (firstModel) {
					output.push(muted(`       • ${formatModelLabel(firstModel)}`));
				}
				if (secondModel) {
					output.push(muted(`       • ${formatModelLabel(secondModel)}`));
				}
				output.push(muted(`       ... and ${provider.models.length - 2} more`));
			}
			output.push("");
		}
	} else {
		output.push(`${badge("No providers configured", undefined, "warn")}`);
		output.push("");
	}

	if (inspection.fileReferences.length > 0) {
		output.push(
			badge(
				`File References (${inspection.fileReferences.length})`,
				undefined,
				"info",
			),
		);
		for (const ref of inspection.fileReferences) {
			const status = ref.exists
				? badge("present", undefined, "success")
				: badge("missing", undefined, "danger");
			const size = ref.size ? ` (${formatBytes(ref.size)})` : "";
			output.push(`  ${status} ${muted(rel(ref.path))}${muted(size)}`);
		}
		output.push("");
	}

	if (inspection.envVars.length > 0) {
		output.push(
			badge(
				`Environment Variables (${inspection.envVars.length})`,
				undefined,
				"info",
			),
		);
		for (const envVar of inspection.envVars) {
			const status = envVar.set
				? badge("set", undefined, "success")
				: badge("missing", undefined, "warn");
			const value = envVar.maskedValue ? envVar.maskedValue : "(not set)";
			output.push(`  ${status} ${chalk.cyan(envVar.name)}: ${muted(value)}`);
		}
		output.push("");
	}

	if (options.disableColors) {
		return output.map((line) => stripAnsi(line));
	}
	return output;
}

function formatBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let index = 0;
	let value = bytes;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}
	return `${value.toFixed(1)} ${units[index]}`;
}

function formatModelLabel(model: {
	id: string;
	reasoning?: boolean;
	input?: string[];
}): string {
	const caps: string[] = [];
	if (model.reasoning) {
		caps.push("thinking");
	}
	if (model.input?.includes("image")) {
		caps.push("vision");
	}
	const suffix = caps.length ? ` ${chalk.dim(`[${caps.join(", ")}]`)}` : "";
	return `${model.id}${suffix}`;
}
