import { lookup as dnsLookup } from "node:dns/promises";
import { isIP as netIsIP } from "node:net";
import type { Api } from "../agent/types.js";
import {
	isLocalhostAlias,
	isLoopbackIP,
	isPrivateIP,
	isUnspecifiedIP,
	parseIPv4,
	parseIPv4MappedHex,
} from "../utils/ip-address-parser.js";

export const CUSTOM_MODEL_URL_POLICY_BLOCKED_METRIC =
	"custom_model_request.blocked_by_url_policy" as const;

export interface CustomModelUrlPolicyConfig {
	allowedBaseUrls?: string[];
	internalBaseUrlAllowList?: string[];
}

export interface CustomModelUrlContext {
	providerId: string;
	api?: Api;
	field: string;
	source?: string;
}

export interface ModelRequestUrlPolicyCheck {
	allowed: boolean;
	reason?: string;
	hostname?: string;
	resolvedAddresses: string[];
}

type LookupAllAddresses = (
	hostname: string,
	options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

export interface ModelRequestUrlPolicyOptions {
	allowInternalBaseUrl?: boolean;
	internalBaseUrl?: string | URL;
	lookup?: LookupAllAddresses;
	policy?: CustomModelUrlPolicyConfig;
}

export class CustomModelUrlPolicyError extends Error {
	constructor(
		message: string,
		public readonly reason: string,
		public readonly context?: CustomModelUrlContext,
	) {
		super(message);
		this.name = "CustomModelUrlPolicyError";
	}
}

// Header names that must never be settable from a user-controlled provider
// `headers` map: they carry credentials or identity that an attacker-aimed
// base URL could otherwise scrape on the very first request.
const RESERVED_HEADER_NAMES = new Set([
	"authorization",
	"proxy-authorization",
	"host",
	"cookie",
	"set-cookie",
	// Provider-specific credential headers.
	"x-api-key",
	"api-key",
	"anthropic-api-key",
	"openai-api-key",
	"openai-organization",
	"openai-project",
	"chatgpt-account-id",
	"x-goog-api-key",
	"x-goog-user-project",
	"google-cloud-quota-project",
]);

// Header-name suffixes that strongly indicate credential material — block any
// header whose normalized name ends with these, so a future provider's
// `Foo-Api-Key` style header is covered without a catalog update.
const RESERVED_HEADER_NAME_SUFFIXES = ["-api-key", "-auth-token", "-token"];

function contextPrefix(context: CustomModelUrlContext): string {
	const source = context.source ? `${context.source}: ` : "";
	return `${source}${context.providerId}.${context.field}`;
}

function normalizeHostname(hostname: string): string {
	return hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.+$/u, "");
}

function normalizedPort(url: URL): string {
	if (url.port) {
		return url.port;
	}
	if (url.protocol === "https:") {
		return "443";
	}
	if (url.protocol === "http:") {
		return "80";
	}
	return "";
}

function sameOrigin(left: URL, right: URL): boolean {
	return (
		left.protocol === right.protocol &&
		normalizeHostname(left.hostname) === normalizeHostname(right.hostname) &&
		normalizedPort(left) === normalizedPort(right)
	);
}

function normalizePrefixPath(pathname: string): string {
	if (!pathname || pathname === "/") {
		return "/";
	}
	return pathname.replace(/\/+$/u, "");
}

function pathMatchesPrefix(pathname: string, prefixPathname: string): boolean {
	const path = normalizePrefixPath(pathname);
	const prefix = normalizePrefixPath(prefixPathname);
	if (prefix === "/") {
		return true;
	}
	return path === prefix || path.startsWith(`${prefix}/`);
}

export function urlMatchesStrictPrefix(candidate: URL, allowed: URL): boolean {
	return (
		sameOrigin(candidate, allowed) &&
		pathMatchesPrefix(candidate.pathname, allowed.pathname)
	);
}

function parseUrl(value: string, label: string): URL {
	try {
		return new URL(value);
	} catch {
		throw new CustomModelUrlPolicyError(
			`${label} must be a valid URL.`,
			"invalid_url",
		);
	}
}

function hasEmbeddedCredentials(url: URL): boolean {
	return url.username.length > 0 || url.password.length > 0;
}

function parsePolicyUrl(
	value: string,
	label: string,
	allowInternal: boolean,
): URL {
	const url = parseUrl(value, label);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new CustomModelUrlPolicyError(
			`${label} must use http:// or https://.`,
			"invalid_protocol",
		);
	}
	if (!allowInternal && url.protocol !== "https:") {
		throw new CustomModelUrlPolicyError(
			`${label} must use https://.`,
			"insecure_protocol",
		);
	}
	if (hasEmbeddedCredentials(url)) {
		throw new CustomModelUrlPolicyError(
			`${label} must not include embedded credentials.`,
			"embedded_credentials",
		);
	}
	if (url.search || url.hash) {
		throw new CustomModelUrlPolicyError(
			`${label} must not include query strings or fragments.`,
			"url_suffix_not_allowed",
		);
	}
	if (!allowInternal && isInternalModelBaseUrl(url.toString())) {
		throw new CustomModelUrlPolicyError(
			`${label} must not point at localhost, private IP, or link-local hosts.`,
			"internal_host",
		);
	}
	return url;
}

function getAllowedPublicBaseUrls(policy: CustomModelUrlPolicyConfig): URL[] {
	return (policy.allowedBaseUrls ?? []).map((value, index) =>
		parsePolicyUrl(value, `allowedBaseUrls[${index}]`, false),
	);
}

function getAllowedInternalBaseUrls(policy: CustomModelUrlPolicyConfig): URL[] {
	return (policy.internalBaseUrlAllowList ?? []).map((value, index) =>
		parsePolicyUrl(value, `internalBaseUrlAllowList[${index}]`, true),
	);
}

function isReservedHeaderName(headerName: string): boolean {
	const normalized = headerName.trim().toLowerCase();
	if (
		RESERVED_HEADER_NAMES.has(normalized) ||
		normalized.startsWith("x-forwarded-") ||
		normalized === "x-real-ip" ||
		normalized === "x-real-host"
	) {
		return true;
	}
	return RESERVED_HEADER_NAME_SUFFIXES.some((suffix) =>
		normalized.endsWith(suffix),
	);
}

function isIpAddress(hostname: string): boolean {
	const host = normalizeHostname(hostname);
	return (
		parseIPv4(host) !== null ||
		parseIPv4MappedHex(host) !== null ||
		netIsIP(host) !== 0
	);
}

function isInternalHostname(hostname: string): boolean {
	const host = normalizeHostname(hostname);
	if (isLocalhostAlias(host) || host.endsWith(".localhost")) {
		return true;
	}
	return isLoopbackIP(host) || isPrivateIP(host) || isUnspecifiedIP(host);
}

export function isInternalModelBaseUrl(
	value: string | URL | undefined,
): boolean {
	if (!value) {
		return false;
	}
	try {
		const url = typeof value === "string" ? new URL(value) : value;
		return isInternalHostname(url.hostname);
	} catch {
		return false;
	}
}

export function validateCustomHeaders(
	headers: Record<string, string> | undefined,
	context: CustomModelUrlContext,
): void {
	if (!headers) {
		return;
	}
	for (const headerName of Object.keys(headers)) {
		if (isReservedHeaderName(headerName)) {
			throw new CustomModelUrlPolicyError(
				`${contextPrefix(context)} contains reserved header "${headerName}". Configure credentials through the provider auth path instead.`,
				"reserved_header",
				context,
			);
		}
	}
}

export function validateCustomModelBaseUrl(
	baseUrl: string | undefined,
	policy: CustomModelUrlPolicyConfig,
	context: CustomModelUrlContext,
): void {
	if (!baseUrl) {
		return;
	}
	const url = parseUrl(baseUrl, contextPrefix(context));
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new CustomModelUrlPolicyError(
			`${contextPrefix(context)} must use http:// or https://.`,
			"invalid_protocol",
			context,
		);
	}
	if (hasEmbeddedCredentials(url)) {
		throw new CustomModelUrlPolicyError(
			`${contextPrefix(context)} must not include embedded credentials.`,
			"embedded_credentials",
			context,
		);
	}
	if (url.search || url.hash) {
		// Base URLs are prefix-matched against the allowlist later. Letting
		// a base URL carry a `?query` or `#fragment` invites confusion: the
		// suffix is silently dropped on most clients and ignored by the
		// allowlist matcher, so the same string passes the check but reaches
		// the network without that segment — exactly the inconsistency we
		// want to avoid in any future prefix matcher.
		throw new CustomModelUrlPolicyError(
			`${contextPrefix(context)} must not include a query string or fragment.`,
			"invalid_path",
			context,
		);
	}

	if (isInternalModelBaseUrl(url)) {
		const allowedInternal = getAllowedInternalBaseUrls(policy);
		if (
			allowedInternal.some((allowed) => urlMatchesStrictPrefix(url, allowed))
		) {
			return;
		}
		throw new CustomModelUrlPolicyError(
			`${contextPrefix(context)} points at an internal host. Add the exact URL prefix to internalBaseUrlAllowList to use local gateways intentionally.`,
			"internal_host",
			context,
		);
	}

	if (url.protocol !== "https:") {
		throw new CustomModelUrlPolicyError(
			`${contextPrefix(context)} must use https:// unless it is explicitly listed in internalBaseUrlAllowList.`,
			"insecure_protocol",
			context,
		);
	}

	const allowedPublic = getAllowedPublicBaseUrls(policy);
	if (
		Array.isArray(policy.allowedBaseUrls) &&
		!allowedPublic.some((allowed) => urlMatchesStrictPrefix(url, allowed))
	) {
		throw new CustomModelUrlPolicyError(
			`${contextPrefix(context)} is not listed in allowedBaseUrls.`,
			"not_in_allowed_base_urls",
			context,
		);
	}
}

export function validateCustomModelConfigUrls(
	config: CustomModelUrlPolicyConfig & {
		providers: Array<{
			id: string;
			api?: Api;
			baseUrl?: string;
			enabled?: boolean;
			headers?: Record<string, string>;
			models?: Array<{
				id: string;
				api?: Api;
				baseUrl?: string;
				headers?: Record<string, string>;
			}>;
		}>;
	},
	source?: string,
): void {
	getAllowedPublicBaseUrls(config);
	getAllowedInternalBaseUrls(config);

	for (const provider of config.providers) {
		if (provider.enabled === false) {
			continue;
		}
		validateCustomHeaders(provider.headers, {
			providerId: provider.id,
			api: provider.api,
			field: "headers",
			source,
		});
		validateCustomModelBaseUrl(provider.baseUrl, config, {
			providerId: provider.id,
			api: provider.api,
			field: "baseUrl",
			source,
		});
		for (const model of provider.models ?? []) {
			validateCustomHeaders(model.headers, {
				providerId: provider.id,
				api: model.api ?? provider.api,
				field: `models.${model.id}.headers`,
				source,
			});
			validateCustomModelBaseUrl(model.baseUrl, config, {
				providerId: provider.id,
				api: model.api ?? provider.api,
				field: `models.${model.id}.baseUrl`,
				source,
			});
		}
	}
}

function blocked(
	reason: string,
	hostname?: string,
	resolvedAddresses: string[] = [],
): ModelRequestUrlPolicyCheck {
	return { allowed: false, reason, hostname, resolvedAddresses };
}

function blockedFromPolicyConfigError(
	error: unknown,
	hostname?: string,
): ModelRequestUrlPolicyCheck {
	if (error instanceof CustomModelUrlPolicyError) {
		return blocked(error.reason, hostname);
	}
	return blocked("invalid_url", hostname);
}

function matchesAllowedInternalRequestBase(
	url: URL,
	options: ModelRequestUrlPolicyOptions,
): boolean {
	if (!options.allowInternalBaseUrl) {
		return false;
	}
	if (!options.internalBaseUrl) {
		return isInternalModelBaseUrl(url);
	}
	try {
		const internalBaseUrl =
			typeof options.internalBaseUrl === "string"
				? new URL(options.internalBaseUrl)
				: options.internalBaseUrl;
		return urlMatchesStrictPrefix(url, internalBaseUrl);
	} catch {
		return false;
	}
}

export async function checkModelRequestUrlPolicy(
	url: string,
	options: ModelRequestUrlPolicyOptions = {},
): Promise<ModelRequestUrlPolicyCheck> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return blocked("invalid_url");
	}

	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return blocked("invalid_protocol");
	}
	if (hasEmbeddedCredentials(parsed)) {
		return blocked("embedded_credentials", normalizeHostname(parsed.hostname));
	}

	const hostname = normalizeHostname(parsed.hostname);
	const hostIsInternal = isInternalHostname(hostname);
	const allowInternalForUrl = matchesAllowedInternalRequestBase(
		parsed,
		options,
	);
	if (hostIsInternal && !allowInternalForUrl) {
		return blocked("internal_host", hostname);
	}
	if (!hostIsInternal && parsed.protocol !== "https:") {
		return blocked("insecure_protocol", hostname);
	}
	if (hostIsInternal && options.policy) {
		let allowedInternal: URL[];
		try {
			allowedInternal = getAllowedInternalBaseUrls(options.policy);
		} catch (error) {
			return blockedFromPolicyConfigError(error, hostname);
		}
		if (
			!allowedInternal.some((allowed) =>
				urlMatchesStrictPrefix(parsed, allowed),
			)
		) {
			return blocked("internal_host", hostname);
		}
	} else if (options.policy && Array.isArray(options.policy.allowedBaseUrls)) {
		let allowedPublic: URL[];
		try {
			allowedPublic = getAllowedPublicBaseUrls(options.policy);
		} catch (error) {
			return blockedFromPolicyConfigError(error, hostname);
		}
		if (
			!allowedPublic.some((allowed) => urlMatchesStrictPrefix(parsed, allowed))
		) {
			return blocked("not_in_allowed_base_urls", hostname);
		}
	}

	let resolvedAddresses: string[] = [];
	if (isIpAddress(hostname)) {
		resolvedAddresses = [hostname];
	} else {
		const lookupImpl: LookupAllAddresses = options.lookup ?? dnsLookup;
		try {
			const addresses = await lookupImpl(hostname, { all: true });
			resolvedAddresses = addresses.map(({ address }) =>
				normalizeHostname(address),
			);
			if (resolvedAddresses.length === 0) {
				return blocked("dns_resolution_failed", hostname);
			}
		} catch {
			return blocked("dns_resolution_failed", hostname);
		}
	}

	const resolvedInternal = resolvedAddresses.some((address) =>
		isInternalHostname(address),
	);
	if (resolvedInternal && !allowInternalForUrl) {
		return blocked("dns_resolved_internal", hostname, resolvedAddresses);
	}

	return { allowed: true, hostname, resolvedAddresses };
}

export function recordCustomModelUrlPolicyBlock(input: {
	provider?: string;
	modelId?: string;
	reason?: string;
}): void {
	void import("../telemetry.js")
		.then(({ recordBusinessMetric }) => {
			recordBusinessMetric(CUSTOM_MODEL_URL_POLICY_BLOCKED_METRIC, 1, {
				provider: input.provider,
				model: input.modelId,
				reason: input.reason,
			});
		})
		.catch(() => {});
}
