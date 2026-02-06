import type { Api, Model } from "../agent/types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("models:registry");

export function trimTrailingSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function isLocalBaseUrl(url?: string): boolean {
	if (!url) {
		return false;
	}
	try {
		const parsed = new URL(url);
		return (
			parsed.hostname === "localhost" ||
			parsed.hostname === "127.0.0.1" ||
			parsed.hostname === "::1" ||
			parsed.hostname === "0.0.0.0"
		);
	} catch {
		return false;
	}
}

function validateBaseUrl(baseUrl: string, providerId: string, api?: Api): void {
	// Validate common provider URL patterns
	if (providerId === "anthropic" || api === "anthropic-messages") {
		if (baseUrl.includes("api.anthropic.com")) {
			if (
				!baseUrl.includes("/v1/messages") &&
				!baseUrl.includes("/v1/complete")
			) {
				logger.warn(
					"Anthropic base URL should end with /v1/messages, auto-normalizing",
					{ baseUrl },
				);
			}
		}
	}

	if (providerId.includes("bedrock") || providerId.includes("aws")) {
		if (baseUrl.includes("bedrock.") && !baseUrl.includes("bedrock-runtime.")) {
			logger.warn(
				"AWS Bedrock URL should use 'bedrock-runtime', auto-normalizing",
				{ baseUrl },
			);
		}
	}

	if (providerId.includes("vertex") || providerId.includes("google")) {
		if (
			baseUrl.includes("aiplatform.googleapis.com") &&
			!baseUrl.includes("/v1/")
		) {
			logger.warn("Google Vertex AI URLs should include full path with /v1/", {
				baseUrl,
			});
		}
	}
}

export function normalizeBaseUrl(
	baseUrl: string,
	providerId: string,
	api?: Api,
): string {
	let normalized = baseUrl;

	// Validate first (logs warnings)
	validateBaseUrl(baseUrl, providerId, api);

	// AWS Bedrock
	if (providerId.includes("bedrock") || providerId.includes("aws")) {
		if (
			normalized.includes("bedrock") &&
			normalized.includes("amazonaws.com") &&
			!normalized.includes("bedrock-runtime")
		) {
			normalized = normalized.replace("bedrock.", "bedrock-runtime.");
		}
	}

	// Google Vertex AI
	if (providerId.includes("vertex") || providerId.includes("google")) {
		if (
			normalized.includes("aiplatform.googleapis.com") &&
			!normalized.includes("/v1/")
		) {
			normalized = normalized.replace(/\/$/, "");
		}
	}

	// Apply shared Anthropic/OpenAI normalization
	normalized = normalizeLLMBaseUrl(normalized, providerId, api);

	return normalized;
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

	const isPrivateIpv4 = (host: string): boolean => {
		const ipv4Match = host.match(/^\d+\.\d+\.\d+\.\d+$/);
		if (!ipv4Match) return false;
		const octets = host.split(".").map(Number);
		if (
			octets.length !== 4 ||
			octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)
		) {
			return false;
		}
		const a = octets[0];
		const b = octets[1];
		if (a === undefined || b === undefined) return false;
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

	const isPrivateIpv6 = (host: string): boolean => {
		// Remove brackets from IPv6 literals (e.g., [::1] -> ::1)
		const addr = host.replace(/^\[|\]$/g, "").toLowerCase();

		// Check for obvious IPv6 patterns
		if (!addr.includes(":")) return false;

		// Loopback ::1
		if (addr === "::1" || addr === "0:0:0:0:0:0:0:1") return true;

		// Unspecified address ::
		if (addr === "::" || addr === "0:0:0:0:0:0:0:0") return true;

		// Link-local fe80::/10
		if (
			addr.startsWith("fe8") ||
			addr.startsWith("fe9") ||
			addr.startsWith("fea") ||
			addr.startsWith("feb")
		)
			return true;

		// Unique local fc00::/7 (fc00::/8 and fd00::/8)
		if (addr.startsWith("fc") || addr.startsWith("fd")) return true;

		// IPv4-mapped IPv6 addresses ::ffff:x.x.x.x (dotted-decimal format)
		const ipv4MappedMatch = addr.match(
			/^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/i,
		);
		if (ipv4MappedMatch?.[1]) {
			return isPrivateIpv4(ipv4MappedMatch[1]);
		}

		// IPv4-mapped IPv6 addresses in hex format (URL.hostname normalizes to this)
		// e.g., ::ffff:c0a8:101 for 192.168.1.1
		const ipv4MappedHexMatch = addr.match(
			/^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i,
		);
		if (ipv4MappedHexMatch?.[1] && ipv4MappedHexMatch?.[2]) {
			const high = Number.parseInt(ipv4MappedHexMatch[1], 16);
			const low = Number.parseInt(ipv4MappedHexMatch[2], 16);
			if (!Number.isNaN(high) && !Number.isNaN(low)) {
				// Convert hex to dotted-decimal for private IP check
				const octet1 = (high >> 8) & 0xff;
				const octet2 = high & 0xff;
				const octet3 = (low >> 8) & 0xff;
				const octet4 = low & 0xff;
				const ipv4Addr = `${octet1}.${octet2}.${octet3}.${octet4}`;
				return isPrivateIpv4(ipv4Addr);
			}
		}

		// IPv4-compatible IPv6 (deprecated but still block) ::x.x.x.x
		const ipv4CompatMatch = addr.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
		if (ipv4CompatMatch?.[1]) {
			return isPrivateIpv4(ipv4CompatMatch[1]);
		}

		return false;
	};

	const isPrivateIp = (host: string): boolean => {
		return isPrivateIpv4(host) || isPrivateIpv6(host);
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
			const pathPortion = urlStr.split(/[?#]/, 1)[0] ?? urlStr;
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
