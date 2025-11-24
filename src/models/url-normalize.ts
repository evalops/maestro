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

	const hasPath = (pathname: string): boolean =>
		pathname.endsWith(desiredPath) ||
		pathname.includes(`${desiredPath}/`) ||
		pathname.includes(`${desiredPath}?`);

	const appendPath = (urlStr: string): string => {
		try {
			const url = new URL(urlStr);
			if (!hasPath(url.pathname)) {
				url.pathname = `${trimTrailingSlash(url.pathname)}${desiredPath}`;
			}
			return url.toString();
		} catch {
			return hasPath(urlStr)
				? urlStr
				: `${trimTrailingSlash(urlStr)}${desiredPath}`;
		}
	};

	try {
		const parsed = new URL(baseUrl);

		// Proxy form: https://proxy/?url=<encoded-upstream>
		if (parsed.searchParams.has("url")) {
			const upstream = parsed.searchParams.get("url") ?? "";
			const normalizedUpstream = appendPath(upstream);
			if (normalizedUpstream === upstream) {
				return baseUrl;
			}
			parsed.searchParams.set("url", normalizedUpstream);
			return parsed.toString();
		}

		if (!hasPath(parsed.pathname)) {
			parsed.pathname = `${trimTrailingSlash(parsed.pathname)}${desiredPath}`;
		}
		return parsed.toString();
	} catch {
		// Fallback for malformed URLs
		return appendPath(baseUrl);
	}
}

export function normalizeModelBaseUrl(model: Model<Api>): string {
	return normalizeLLMBaseUrl(model.baseUrl, model.provider, model.api);
}
