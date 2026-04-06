export type McpTransport = "stdio" | "http" | "sse";
export type McpWritableScope = "local" | "project" | "user";
export type McpScope = "enterprise" | "plugin" | "project" | "local" | "user";

export interface McpOfficialRegistryUrlOptionLike {
	url?: string;
	label?: string;
	description?: string;
}

export interface McpOfficialRegistryEntryLike {
	displayName?: string;
	directoryUrl?: string;
	documentationUrl?: string;
	permissions?: string;
	authorName?: string;
	url?: string;
	slug?: string;
	serverName?: string;
	oneLiner?: string;
	transport?: McpTransport;
	urlOptions?: McpOfficialRegistryUrlOptionLike[];
	toolCount?: number;
	promptCount?: number;
}

interface McpTransportResponseLike {
	transport: McpTransport | string;
}

export interface McpRegistryImportResponseLike {
	name: string;
	scope: McpWritableScope;
	server: McpTransportResponseLike;
}

export interface McpServerMutationResponseLike {
	name: string;
	scope: McpWritableScope;
	server: McpTransportResponseLike;
}

export interface McpServerRemoveResponseLike {
	name: string;
	scope: McpWritableScope;
	fallback: {
		name: string;
		scope?: McpScope;
	} | null;
}

export function formatMcpTransportLabel(
	transport: McpTransport | undefined,
): string | null {
	switch (transport) {
		case "stdio":
			return "stdio";
		case "http":
			return "HTTP";
		case "sse":
			return "SSE";
		default:
			return null;
	}
}

export function formatMcpRegistryScopeLabel(
	scope: McpWritableScope | undefined,
): string {
	switch (scope) {
		case "project":
			return "Project";
		case "user":
			return "User";
		default:
			return "Local";
	}
}

export function formatAnyMcpScopeLabel(scope: McpScope | undefined): string {
	switch (scope) {
		case "enterprise":
			return "Enterprise";
		case "plugin":
			return "Plugin";
		case "project":
			return "Project";
		case "user":
			return "User";
		default:
			return "Local";
	}
}

export function formatMcpConfigScopeLabel(
	scope: McpScope | undefined,
): string | null {
	switch (scope) {
		case "enterprise":
			return "Enterprise config";
		case "plugin":
			return "Plugin config";
		case "project":
			return "Project config";
		case "local":
			return "Local config";
		case "user":
			return "User config";
		default:
			return null;
	}
}

export function getWritableMcpScope(
	scope: McpScope | McpWritableScope | undefined,
): McpWritableScope | null {
	switch (scope) {
		case "local":
		case "project":
		case "user":
			return scope;
		default:
			return null;
	}
}

export function getMcpRegistryEntryId(
	entry: McpOfficialRegistryEntryLike,
	fallbackIndex = 0,
): string {
	const rawId =
		entry.slug?.trim() ||
		entry.serverName?.trim() ||
		entry.displayName?.trim() ||
		entry.url?.trim() ||
		entry.directoryUrl?.trim() ||
		`entry-${fallbackIndex}`;
	return rawId.toLowerCase().replace(/\s+/g, "-");
}

export function getMcpRegistryUrlOptions(
	entry: McpOfficialRegistryEntryLike,
): Array<{ url: string; label: string }> {
	const options =
		entry.urlOptions
			?.map((option, index) => {
				const url = option.url?.trim();
				if (!url) {
					return null;
				}
				const label =
					option.label?.trim() ||
					option.description?.trim() ||
					(index === 0 ? "Default endpoint" : `Endpoint ${index + 1}`);
				return { url, label };
			})
			.filter((option): option is { url: string; label: string } =>
				Boolean(option),
			) ?? [];
	const fallbackUrl = entry.url?.trim();
	return options.length > 0
		? options
		: fallbackUrl
			? [{ url: fallbackUrl, label: "Default endpoint" }]
			: [];
}

export function formatMcpRegistryImportMessage(
	result: McpRegistryImportResponseLike,
): string {
	const transportLabel =
		formatMcpTransportLabel(result.server.transport as McpTransport) ??
		result.server.transport;
	return `Imported ${result.name} into ${formatMcpRegistryScopeLabel(result.scope)} config via ${transportLabel}.`;
}

export function formatMcpServerAddMessage(
	result: McpServerMutationResponseLike,
): string {
	const transportLabel =
		formatMcpTransportLabel(result.server.transport as McpTransport) ??
		result.server.transport;
	return `Added ${result.name} to ${formatMcpRegistryScopeLabel(result.scope)} config via ${transportLabel}.`;
}

export function formatMcpServerUpdateMessage(
	result: McpServerMutationResponseLike,
): string {
	const transportLabel =
		formatMcpTransportLabel(result.server.transport as McpTransport) ??
		result.server.transport;
	return `Updated ${result.name} in ${formatMcpRegistryScopeLabel(result.scope)} config via ${transportLabel}.`;
}

export function formatMcpServerRemoveMessage(
	result: McpServerRemoveResponseLike,
): string {
	if (result.fallback) {
		return `Removed ${result.name} from ${formatMcpRegistryScopeLabel(result.scope)} config. Now using ${result.fallback.name} from ${formatMcpConfigScopeLabel(result.fallback.scope) ?? result.fallback.scope ?? "another config"}.`;
	}
	return `Removed ${result.name} from ${formatMcpRegistryScopeLabel(result.scope)} config.`;
}

export function formatMcpArgsText(args: string[] | undefined): string {
	if (!Array.isArray(args) || args.length === 0) {
		return "";
	}
	return args.join("\n");
}

export function parseMcpArgsText(text: string): string[] | undefined {
	const args = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return args.length > 0 ? args : undefined;
}

export function formatMcpKeyValueText(
	values: Record<string, string> | undefined,
): string {
	if (!values) {
		return "";
	}
	return Object.entries(values)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
}

export function parseMcpKeyValueText(
	text: string,
): Record<string, string> | undefined {
	const entries = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const separatorIndex = line.indexOf("=");
			if (separatorIndex <= 0) {
				throw new Error(`Expected KEY=VALUE format for "${line}".`);
			}
			return [
				line.slice(0, separatorIndex).trim(),
				line.slice(separatorIndex + 1),
			] as const;
		});

	if (entries.length === 0) {
		return undefined;
	}

	return Object.fromEntries(entries);
}

export function formatMcpTimeoutText(
	timeout: number | null | undefined,
): string {
	return typeof timeout === "number" ? String(timeout) : "";
}

export function parseMcpTimeoutText(text: string): number | undefined {
	const trimmed = text.trim();
	if (!trimmed) {
		return undefined;
	}
	const value = Number(trimmed);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error("Timeout must be a positive integer in milliseconds.");
	}
	return value;
}
