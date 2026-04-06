import { createLogger } from "../utils/logger.js";
import { inferRemoteMcpTransport } from "./config.js";
import type {
	McpOfficialRegistryEntry,
	McpOfficialRegistryInfo,
	McpOfficialRegistryUrlOption,
	McpRemoteTrust,
} from "./types.js";

const logger = createLogger("mcp:official-registry");

const OFFICIAL_MCP_REGISTRY_URL =
	"https://api.anthropic.com/mcp-registry/v0/servers?version=latest&visibility=commercial";
const OFFICIAL_MCP_REGISTRY_TIMEOUT_MS = 5000;

interface RegistryCacheEntry {
	info: McpOfficialRegistryInfo;
}

interface RegistryRegexEntry extends RegistryCacheEntry {
	pattern: RegExp;
}

interface RegistryCache {
	exact: Map<string, RegistryCacheEntry>;
	regex: RegistryRegexEntry[];
	entries: McpOfficialRegistryEntry[];
	status: "idle" | "loading" | "ready" | "failed";
}

interface RegistryServerRemote {
	url?: string;
	type?: string;
}

interface RegistryServer {
	remotes?: RegistryServerRemote[];
	title?: string;
	name?: string;
}

interface RegistryAuthor {
	name?: string;
}

interface RegistryUrlOption {
	url?: string;
	label?: string;
	description?: string;
}

interface AnthropicRegistryMeta {
	displayName?: string;
	directoryUrl?: string;
	documentation?: string;
	permissions?: string;
	url?: string;
	urlRegex?: string;
	urlOptions?: RegistryUrlOption[];
	author?: RegistryAuthor;
	slug?: string;
	oneLiner?: string;
	toolNames?: string[];
	promptNames?: string[];
}

interface RegistryResponseEntry {
	server?: RegistryServer;
	_meta?: {
		"com.anthropic.api/mcp-registry"?: AnthropicRegistryMeta;
	};
}

interface RegistryResponse {
	servers?: RegistryResponseEntry[];
}

let registryCache: RegistryCache = {
	exact: new Map(),
	regex: [],
	entries: [],
	status: "idle",
};
let inFlightFetch: Promise<void> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function collectConcreteUrls(entry: RegistryResponseEntry): Set<string> {
	const urls = new Set<string>();
	const remotes = entry.server?.remotes ?? [];
	for (const remote of remotes) {
		if (typeof remote?.url === "string" && !remote.url.includes("{")) {
			urls.add(remote.url);
		}
	}

	const meta = entry._meta?.["com.anthropic.api/mcp-registry"];
	if (!meta) {
		return urls;
	}

	if (typeof meta.url === "string" && !meta.url.includes("{")) {
		urls.add(meta.url);
	}

	for (const option of meta.urlOptions ?? []) {
		if (typeof option?.url === "string" && !option.url.includes("{")) {
			urls.add(option.url);
		}
	}

	return urls;
}

function collectUrlOptions(
	entry: RegistryResponseEntry,
): McpOfficialRegistryUrlOption[] {
	const meta = entry._meta?.["com.anthropic.api/mcp-registry"];
	if (!meta?.urlOptions?.length) {
		return [];
	}

	const options: McpOfficialRegistryUrlOption[] = [];
	for (const option of meta.urlOptions) {
		if (typeof option?.url !== "string" || option.url.includes("{")) {
			continue;
		}
		options.push({
			url: option.url,
			label: option.label?.trim() || undefined,
			description: option.description?.trim() || undefined,
		});
	}
	return options;
}

function buildRegistryInfo(
	entry: RegistryResponseEntry,
): McpOfficialRegistryInfo {
	const meta = entry._meta?.["com.anthropic.api/mcp-registry"];
	const urls = Array.from(collectConcreteUrls(entry));
	return {
		displayName:
			meta?.displayName?.trim() || entry.server?.title?.trim() || undefined,
		directoryUrl: meta?.directoryUrl?.trim() || undefined,
		documentationUrl: meta?.documentation?.trim() || undefined,
		permissions: meta?.permissions?.trim() || undefined,
		authorName: meta?.author?.name?.trim() || undefined,
		url: urls[0],
	};
}

function buildRegistryEntry(
	entry: RegistryResponseEntry,
): McpOfficialRegistryEntry | undefined {
	const meta = entry._meta?.["com.anthropic.api/mcp-registry"];
	const info = buildRegistryInfo(entry);
	const urlOptions = collectUrlOptions(entry);
	const displayName =
		info.displayName || entry.server?.name?.trim() || info.url?.trim();
	if (!displayName) {
		return undefined;
	}

	const remoteTransport = entry.server?.remotes?.find(
		(remote) => typeof remote.type === "string",
	)?.type;
	const transport =
		remoteTransport === "sse"
			? "sse"
			: info.url
				? inferRemoteMcpTransport(info.url)
				: undefined;

	return {
		...info,
		displayName,
		slug: meta?.slug?.trim() || undefined,
		serverName: entry.server?.name?.trim() || undefined,
		oneLiner: meta?.oneLiner?.trim() || undefined,
		transport,
		urlOptions: urlOptions.length > 0 ? urlOptions : undefined,
		urlRegex: meta?.urlRegex?.trim() || undefined,
		toolCount: Array.isArray(meta?.toolNames)
			? meta.toolNames.length
			: undefined,
		promptCount: Array.isArray(meta?.promptNames)
			? meta.promptNames.length
			: undefined,
	};
}

function buildCacheFromResponse(data: unknown): RegistryCache {
	const next: RegistryCache = {
		exact: new Map(),
		regex: [],
		entries: [],
		status: "ready",
	};

	if (!isRecord(data) || !Array.isArray(data.servers)) {
		return next;
	}

	for (const entry of data.servers) {
		if (!isRecord(entry)) continue;
		const typedEntry = entry as RegistryResponseEntry;
		const info = buildRegistryInfo(typedEntry);
		const registryEntry = buildRegistryEntry(typedEntry);
		if (registryEntry) {
			next.entries.push(registryEntry);
		}

		for (const url of collectConcreteUrls(typedEntry)) {
			const normalized = normalizeMcpRemoteUrl(url);
			if (!normalized) continue;
			next.exact.set(normalized, { info });
		}

		const meta = typedEntry._meta?.["com.anthropic.api/mcp-registry"];
		if (typeof meta?.urlRegex === "string" && meta.urlRegex.trim().length > 0) {
			try {
				next.regex.push({
					pattern: new RegExp(`^${meta.urlRegex}$`),
					info,
				});
			} catch (error) {
				logger.warn("Invalid MCP official registry urlRegex", {
					regex: meta.urlRegex,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	next.entries.sort((left, right) =>
		(left.displayName ?? "").localeCompare(right.displayName ?? "", undefined, {
			sensitivity: "base",
		}),
	);

	return next;
}

export function normalizeMcpRemoteUrl(rawUrl: string): string | undefined {
	try {
		const parsed = new URL(rawUrl);
		parsed.search = "";
		parsed.hash = "";
		const normalized = parsed.toString();
		return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	} catch {
		return undefined;
	}
}

export function getMcpRemoteHost(rawUrl: string): string | undefined {
	try {
		return new URL(rawUrl).host;
	} catch {
		return undefined;
	}
}

export async function prefetchOfficialMcpRegistry(): Promise<void> {
	if (registryCache.status === "ready") {
		return;
	}

	if (inFlightFetch) {
		return inFlightFetch;
	}

	registryCache.status = "loading";
	inFlightFetch = (async () => {
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			OFFICIAL_MCP_REGISTRY_TIMEOUT_MS,
		);

		try {
			const response = await fetch(OFFICIAL_MCP_REGISTRY_URL, {
				signal: controller.signal,
				headers: { Accept: "application/json" },
			});
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}

			const data = (await response.json()) as RegistryResponse;
			registryCache = buildCacheFromResponse(data);
			logger.debug("Loaded official MCP registry metadata", {
				exactMatches: registryCache.exact.size,
				regexMatches: registryCache.regex.length,
			});
		} catch (error) {
			registryCache = {
				exact: new Map(),
				regex: [],
				entries: [],
				status: "failed",
			};
			logger.warn("Failed to load official MCP registry metadata", {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			clearTimeout(timeout);
			inFlightFetch = null;
		}
	})();

	return inFlightFetch;
}

export function getOfficialMcpRegistryMatch(rawUrl: string): {
	trust: McpRemoteTrust;
	info?: McpOfficialRegistryInfo;
} {
	const normalizedUrl = normalizeMcpRemoteUrl(rawUrl);
	if (!normalizedUrl) {
		return { trust: "unknown" };
	}

	const exact = registryCache.exact.get(normalizedUrl);
	if (exact) {
		return {
			trust: "official",
			info: exact.info,
		};
	}

	for (const entry of registryCache.regex) {
		if (entry.pattern.test(rawUrl) || entry.pattern.test(normalizedUrl)) {
			return {
				trust: "official",
				info: entry.info,
			};
		}
	}

	if (registryCache.status !== "ready") {
		return { trust: "unknown" };
	}

	return { trust: "custom" };
}

export function getOfficialMcpRegistryEntries(): McpOfficialRegistryEntry[] {
	return [...registryCache.entries];
}

export function searchOfficialMcpRegistry(
	query: string,
	options: { limit?: number } = {},
): McpOfficialRegistryEntry[] {
	const limit = options.limit ?? 8;
	if (limit <= 0) {
		return [];
	}

	const trimmedQuery = query.trim().toLowerCase();
	if (trimmedQuery.length === 0) {
		return registryCache.entries.slice(0, limit);
	}

	const terms = trimmedQuery.split(/\s+/).filter(Boolean);
	return registryCache.entries
		.map((entry) => ({
			entry,
			score: scoreRegistryEntry(entry, trimmedQuery, terms),
		}))
		.filter((candidate) => candidate.score > 0)
		.sort(
			(left, right) =>
				right.score - left.score ||
				(left.entry.displayName ?? "").localeCompare(
					right.entry.displayName ?? "",
					undefined,
					{ sensitivity: "base" },
				),
		)
		.slice(0, limit)
		.map((candidate) => candidate.entry);
}

export function resolveOfficialMcpRegistryEntry(query: string): {
	entry?: McpOfficialRegistryEntry;
	matches: McpOfficialRegistryEntry[];
} {
	const trimmedQuery = query.trim();
	if (trimmedQuery.length === 0) {
		return { matches: [] };
	}

	const normalizedQuery = trimmedQuery.toLowerCase();
	const exactMatches = registryCache.entries.filter((entry) =>
		getRegistrySearchKeys(entry).some((key) => key === normalizedQuery),
	);
	if (exactMatches.length === 1) {
		return { entry: exactMatches[0], matches: exactMatches };
	}

	const matches = searchOfficialMcpRegistry(trimmedQuery, { limit: 5 });
	if (matches.length === 1) {
		return { entry: matches[0], matches };
	}

	return { matches };
}

export function getOfficialMcpRegistryUrls(
	entry: Pick<McpOfficialRegistryEntry, "url" | "urlOptions">,
): string[] {
	const urls = new Set<string>();
	if (entry.url) {
		urls.add(entry.url);
	}
	for (const option of entry.urlOptions ?? []) {
		urls.add(option.url);
	}
	return [...urls];
}

export function officialMcpRegistryEntryMatchesUrl(
	entry: Pick<McpOfficialRegistryEntry, "url" | "urlOptions" | "urlRegex">,
	rawUrl: string,
): boolean {
	const normalizedUrl = normalizeMcpRemoteUrl(rawUrl);
	if (!normalizedUrl) {
		return false;
	}

	for (const candidate of getOfficialMcpRegistryUrls(entry)) {
		if (normalizeMcpRemoteUrl(candidate) === normalizedUrl) {
			return true;
		}
	}

	if (entry.urlRegex) {
		try {
			const pattern = new RegExp(`^${entry.urlRegex}$`);
			return pattern.test(rawUrl) || pattern.test(normalizedUrl);
		} catch {
			return false;
		}
	}

	return false;
}

export function buildSuggestedMcpServerName(
	entry: Pick<McpOfficialRegistryEntry, "slug" | "displayName" | "serverName">,
): string {
	const candidates = [
		entry.slug,
		entry.displayName,
		entry.serverName?.split("/").at(-1),
		entry.serverName,
	];
	for (const candidate of candidates) {
		const normalized = sanitizeRegistryServerName(candidate);
		if (normalized) {
			return normalized;
		}
	}
	return "mcp-server";
}

export function resetOfficialMcpRegistryCacheForTesting(): void {
	registryCache = {
		exact: new Map(),
		regex: [],
		entries: [],
		status: "idle",
	};
	inFlightFetch = null;
}

export function setOfficialMcpRegistryCacheForTesting(data: unknown): void {
	registryCache = buildCacheFromResponse(data);
	inFlightFetch = null;
}

function getRegistrySearchKeys(entry: McpOfficialRegistryEntry): string[] {
	return [
		entry.slug,
		entry.displayName,
		entry.serverName,
		entry.oneLiner,
		entry.authorName,
	]
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.toLowerCase());
}

function scoreRegistryEntry(
	entry: McpOfficialRegistryEntry,
	query: string,
	terms: string[],
): number {
	const keys = getRegistrySearchKeys(entry);
	let score = 0;
	for (const key of keys) {
		if (key === query) {
			score = Math.max(score, 100);
		} else if (key.startsWith(query)) {
			score = Math.max(score, 80);
		} else if (key.includes(query)) {
			score = Math.max(score, 60);
		}
	}

	if (
		terms.length > 1 &&
		terms.every((term) => keys.some((key) => key.includes(term)))
	) {
		score = Math.max(score, 40);
	}

	return score;
}

function sanitizeRegistryServerName(
	value: string | undefined,
): string | undefined {
	if (!value) {
		return undefined;
	}
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
	return normalized.length > 0 ? normalized : undefined;
}
