import type { Api, Model } from "../agent/types.js";

export function trimTrailingSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Normalize Anthropic and OpenAI-compatible endpoints:
 * - Anthropic -> ensure /v1/messages
 * - openai-responses -> ensure /responses
 * - openai-completions -> ensure /chat/completions
 *
 * Works with full URLs (including query/fragments) using URL parsing; falls back
 * to string logic if the URL constructor throws.
 */
export function normalizeLLMBaseUrl(
	baseUrl: string,
	providerId: string,
	api?: Api,
): string {
	const isAnthropic =
		providerId === "anthropic" || api === "anthropic-messages";
	const isOpenAIResponses = api === "openai-responses";
	const isOpenAICompletions = api === "openai-completions";

	if (!isAnthropic && !isOpenAIResponses && !isOpenAICompletions) {
		return baseUrl;
	}

	const desiredPath = isAnthropic
		? "/v1/messages"
		: isOpenAIResponses
			? "/responses"
			: "/chat/completions";

	try {
		const parsed = new URL(baseUrl);
		const pathname = parsed.pathname;

		const hasPath =
			pathname.endsWith(desiredPath) ||
			pathname.includes(`${desiredPath}/`) ||
			pathname.includes(`${desiredPath}?`);

		if (!hasPath) {
			parsed.pathname = `${trimTrailingSlash(pathname)}${desiredPath}`;
			return parsed.toString();
		}
		return parsed.toString();
	} catch {
		// Fallback for malformed URLs
		const hasPath =
			baseUrl.endsWith(desiredPath) ||
			baseUrl.includes(`${desiredPath}/`) ||
			baseUrl.includes(`${desiredPath}?`);
		return hasPath ? baseUrl : `${trimTrailingSlash(baseUrl)}${desiredPath}`;
	}
}

export function normalizeModelBaseUrl(model: Model<Api>): string {
	return normalizeLLMBaseUrl(model.baseUrl, model.provider, model.api);
}
