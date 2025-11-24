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
		pathname.endsWith(desiredPath) || pathname.includes(`${desiredPath}/`);

	const isPrivateIp = (host: string): boolean => {
		// Only check IPv4 literals; hostnames are allowed (DNS resolution not performed here).
		const ipv4Match = host.match(/^\d+\.\d+\.\d+\.\d+$/);
		if (!ipv4Match) return false;
		const octets = host.split(".").map(Number);
		if (
			octets.length !== 4 ||
			octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)
		) {
			return false;
		}
		const [a, b] = octets;
		return (
			// 10.0.0.0/8
			a === 10 ||
			// 172.16.0.0/12
			(a === 172 && b >= 16 && b <= 31) ||
			// 192.168.0.0/16
			(a === 192 && b === 168) ||
			// loopback 127.0.0.0/8
			a === 127 ||
			// link-local 169.254.0.0/16
			(a === 169 && b === 254)
		);
	};

	const isSafeHttpUrl = (value: string): boolean => {
		try {
			const parsed = new URL(value);
			return parsed.protocol === "http:" || parsed.protocol === "https:";
		} catch {
			return false;
		}
	};

	const appendPath = (urlStr: string): string => {
		try {
			const url = new URL(urlStr);
			if (!hasPath(url.pathname)) {
				url.pathname = `${trimTrailingSlash(url.pathname)}${desiredPath}`;
			}
			return url.toString();
		} catch {
			// Fallback string check: ensure desiredPath appears after a slash, not in hostname
			const [pathPortion] = urlStr.split(/[?#]/, 1);
			const pathIndex = pathPortion.indexOf(desiredPath);
			const looksLikePath = pathIndex > 0 && pathPortion[pathIndex - 1] === "/";
			const hasDesiredPath = hasPath(pathPortion) && looksLikePath;
			const includesQueryPath =
				urlStr.includes(`${desiredPath}?`) ||
				urlStr.includes(`${desiredPath}#`);
			return hasDesiredPath || includesQueryPath
				? urlStr
				: `${trimTrailingSlash(urlStr)}${desiredPath}`;
		}
	};

	try {
		const parsed = new URL(baseUrl);

		// Proxy form: https://proxy/?url=<encoded-upstream>
		if (parsed.searchParams.has("url")) {
			const upstreamRaw = parsed.searchParams.get("url");
			if (!upstreamRaw || upstreamRaw.trim() === "") {
				return baseUrl; // invalid proxy config
			}

			let upstream: URL;
			try {
				upstream = new URL(upstreamRaw);
			} catch {
				return baseUrl; // malformed upstream
			}

			if (!isSafeHttpUrl(upstreamRaw) || isPrivateIp(upstream.hostname)) {
				return baseUrl; // block unsafe protocols/private IPs
			}

			const normalizedUpstream = appendPath(upstreamRaw);
			if (normalizedUpstream === upstreamRaw) {
				return baseUrl; // already normalized
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
