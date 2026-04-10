import type { Api } from "../agent/types.js";

export type EvalOpsManagedProviderDefinition = {
	allowedModelApis?: readonly Api[];
	api: Api;
	defaultModel: string;
	id: string;
	name: string;
	note: string;
	providerRefProvider: string;
	sourceProvider: string;
	targetApi?: Api;
	usesAnthropicOAuth?: boolean;
};

export const EVALOPS_MANAGED_PROVIDER_DEFINITIONS: readonly EvalOpsManagedProviderDefinition[] =
	[
		{
			api: "openai-responses",
			defaultModel: "gpt-4o-mini",
			id: "evalops",
			name: "EvalOps Managed Gateway (OpenAI Responses)",
			note: "Requires /login evalops and routes managed OpenAI responses through the gateway",
			providerRefProvider: "openai",
			sourceProvider: "openai",
		},
		{
			allowedModelApis: ["openai-completions"],
			api: "openai-completions",
			defaultModel: "gpt-4o",
			id: "evalops-azure-openai",
			name: "EvalOps Managed Gateway (Azure OpenAI)",
			note: "Requires /login evalops and routes managed Azure OpenAI chat completions through the gateway",
			providerRefProvider: "azure-openai",
			sourceProvider: "openai",
		},
		{
			api: "anthropic-messages",
			defaultModel: "claude-sonnet-4-5",
			id: "evalops-anthropic",
			name: "EvalOps Managed Gateway (Anthropic Messages)",
			note: "Requires /login evalops and routes managed Anthropic messages through the gateway",
			providerRefProvider: "anthropic",
			sourceProvider: "anthropic",
			usesAnthropicOAuth: true,
		},
		{
			allowedModelApis: ["openai-completions"],
			api: "openai-completions",
			defaultModel: "command-a-03-2025",
			id: "evalops-cohere",
			name: "EvalOps Managed Gateway (Cohere)",
			note: "Requires /login evalops and routes managed Cohere chat completions through the gateway",
			providerRefProvider: "cohere",
			sourceProvider: "cohere",
		},
		{
			allowedModelApis: ["openai-completions"],
			api: "openai-completions",
			defaultModel: "accounts/fireworks/models/llama-v3p1-70b-instruct",
			id: "evalops-fireworks",
			name: "EvalOps Managed Gateway (Fireworks)",
			note: "Requires /login evalops and routes managed Fireworks chat completions through the gateway",
			providerRefProvider: "fireworks",
			sourceProvider: "fireworks",
		},
		{
			allowedModelApis: ["google-generative-ai"],
			api: "openai-completions",
			defaultModel: "gemini-2.5-pro",
			id: "evalops-google",
			name: "EvalOps Managed Gateway (Google Gemini)",
			note: "Requires /login evalops and routes managed Google Gemini chat completions through the gateway",
			providerRefProvider: "google",
			sourceProvider: "google",
			targetApi: "openai-completions",
		},
		{
			allowedModelApis: ["openai-completions"],
			api: "openai-completions",
			defaultModel: "llama-3.3-70b-versatile",
			id: "evalops-groq",
			name: "EvalOps Managed Gateway (Groq)",
			note: "Requires /login evalops and routes managed Groq chat completions through the gateway",
			providerRefProvider: "groq",
			sourceProvider: "groq",
		},
		{
			allowedModelApis: ["openai-completions"],
			api: "openai-completions",
			defaultModel: "databricks-meta-llama-3-3-70b-instruct",
			id: "evalops-databricks",
			name: "EvalOps Managed Gateway (Databricks)",
			note: "Requires /login evalops and routes managed Databricks chat completions through the gateway",
			providerRefProvider: "databricks",
			sourceProvider: "databricks",
		},
		{
			allowedModelApis: ["openai-completions"],
			api: "openai-completions",
			defaultModel: "deepseek-v3.2",
			id: "evalops-deepseek",
			name: "EvalOps Managed Gateway (DeepSeek)",
			note: "Requires /login evalops and routes managed DeepSeek chat completions through the gateway",
			providerRefProvider: "deepseek",
			sourceProvider: "deepseek",
		},
		{
			allowedModelApis: ["openai-completions"],
			api: "openai-completions",
			defaultModel: "sonar",
			id: "evalops-perplexity",
			name: "EvalOps Managed Gateway (Perplexity)",
			note: "Requires /login evalops and routes managed Perplexity chat completions through the gateway",
			providerRefProvider: "perplexity",
			sourceProvider: "perplexity",
		},
		{
			allowedModelApis: ["openai-completions"],
			api: "openai-completions",
			defaultModel: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
			id: "evalops-together",
			name: "EvalOps Managed Gateway (Together)",
			note: "Requires /login evalops and routes managed Together chat completions through the gateway",
			providerRefProvider: "together",
			sourceProvider: "together",
		},
		{
			allowedModelApis: ["openai-completions"],
			api: "openai-completions",
			defaultModel: "mistral-large-latest",
			id: "evalops-mistral",
			name: "EvalOps Managed Gateway (Mistral)",
			note: "Requires /login evalops and routes managed Mistral chat completions through the gateway",
			providerRefProvider: "mistral",
			sourceProvider: "mistral",
		},
		{
			allowedModelApis: ["openai-completions"],
			api: "openai-completions",
			defaultModel: "grok-4-fast",
			id: "evalops-xai",
			name: "EvalOps Managed Gateway (xAI)",
			note: "Requires /login evalops and routes managed xAI chat completions through the gateway",
			providerRefProvider: "xai",
			sourceProvider: "xai",
		},
		{
			api: "openai-completions",
			defaultModel: "openai/o4-mini",
			id: "evalops-openrouter",
			name: "EvalOps Managed Gateway (OpenRouter)",
			note: "Requires /login evalops and routes managed OpenRouter chat completions through the gateway",
			providerRefProvider: "openrouter",
			sourceProvider: "openrouter",
		},
	] as const;

const managedProvidersByID = new Map<string, EvalOpsManagedProviderDefinition>(
	EVALOPS_MANAGED_PROVIDER_DEFINITIONS.map((definition) => [
		definition.id,
		definition,
	]),
);

export function getEvalOpsManagedProviderDefinition(
	provider: string,
): EvalOpsManagedProviderDefinition | undefined {
	return managedProvidersByID.get(provider.toLowerCase().trim());
}

export function isEvalOpsManagedProvider(provider: string): boolean {
	return getEvalOpsManagedProviderDefinition(provider) !== undefined;
}
