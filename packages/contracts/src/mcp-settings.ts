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

export interface McpResourceContentLike {
	uri: string;
	mimeType?: string;
	text?: string;
	blob?: string;
}

export interface McpResourceReadResponseLike {
	contents: McpResourceContentLike[];
}

export interface McpPromptMessageLike {
	role: string;
	content: string;
}

export interface McpPromptResponseLike {
	description?: string;
	messages: McpPromptMessageLike[];
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

export function formatMcpResourceOutput(
	result: McpResourceReadResponseLike,
): string {
	if (result.contents.length === 0) {
		return "No resource contents returned.";
	}

	return result.contents
		.map((content) => {
			const lines = [content.uri];
			if (content.mimeType) {
				lines.push(`mime: ${content.mimeType}`);
			}
			if (typeof content.text === "string") {
				lines.push("", content.text);
			} else if (typeof content.blob === "string") {
				lines.push("", `[binary content: ${content.blob.length} chars]`);
			} else {
				lines.push("", "[empty content]");
			}
			return lines.join("\n");
		})
		.join("\n\n");
}

export function formatMcpPromptOutput(result: McpPromptResponseLike): string {
	const lines: string[] = [];
	if (result.description) {
		lines.push(result.description, "");
	}
	if (result.messages.length === 0) {
		lines.push("No prompt messages returned.");
		return lines.join("\n").trim();
	}
	for (const message of result.messages) {
		lines.push(`${message.role}:`, message.content, "");
	}
	return lines.join("\n").trim();
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
