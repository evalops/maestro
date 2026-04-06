import {
	formatMcpArgsText,
	formatMcpConfigScopeLabel,
	formatMcpKeyValueText,
	formatMcpRegistryImportMessage,
	formatMcpRegistryScopeLabel,
	formatMcpServerAddMessage,
	formatMcpServerRemoveMessage,
	formatMcpServerUpdateMessage,
	formatMcpTimeoutText,
	formatMcpTransportLabel,
	getMcpRegistryEntryId,
	getMcpRegistryUrlOptions,
	getWritableMcpScope,
	parseMcpArgsText,
	parseMcpKeyValueText,
	parseMcpTimeoutText,
} from "@evalops/contracts";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import type {
	ComposerProfile,
	ComposerStatus,
	LspStatus,
	McpOfficialRegistryEntry,
	McpRegistryImportRequest,
	McpRegistryImportResponse,
	McpRegistrySearchResponse,
	McpServerAddRequest,
	McpServerMutationResponse,
	McpServerRemoveRequest,
	McpServerRemoveResponse,
	McpServerStatus,
	McpServerUpdateRequest,
	McpStatus,
} from "../../lib/api-client";

export type LspAction = "start" | "stop" | "restart";

export interface LspDetection {
	serverId: string;
	root: string;
}

export interface LspServerViewModel {
	id: string;
	summary: string;
}

export interface LspViewModel {
	enabledLabel: string;
	autostartLabel: string;
	serverCount: number;
	servers: LspServerViewModel[];
	detectionsLabel: string;
}

export interface McpServerViewModel {
	name: string;
	summary: string;
	isExpanded: boolean;
	transport: McpServerStatus["transport"];
	writableScope: McpRegistryImportRequest["scope"] | null;
	sourceLabel: string | null;
	transportLabel: string | null;
	remoteTrustLabel: string | null;
	errorLabel: string | null;
	command: string | null;
	args: string[];
	cwd: string | null;
	envKeys: string[];
	remoteHost: string | null;
	remoteUrl: string | null;
	headerKeys: string[];
	headersHelper: string | null;
	timeout: number | null;
	officialRegistryName: string | null;
	officialRegistryDirectoryUrl: string | null;
	officialRegistryDocumentationUrl: string | null;
	officialRegistryAuthor: string | null;
	officialRegistryPermissions: string | null;
	toolCount: number;
	tools: Array<{ name: string; description?: string }>;
	toolDetailsLabel: string | null;
	resources: string[];
	prompts: string[];
}

export interface McpRegistryEntryViewModel {
	id: string;
	importQuery: string;
	title: string;
	description: string | null;
	summary: string | null;
	transportLabel: string | null;
	countsLabel: string | null;
	authorLabel: string | null;
	permissionsLabel: string | null;
	directoryUrl: string | null;
	documentationUrl: string | null;
	urlOptions: Array<{ url: string; label: string }>;
	defaultUrl: string | null;
}

export interface ComposerProfilesViewModel {
	options: ComposerProfile[];
	activeLabel: string;
	canActivate: boolean;
}

export interface ToolsRuntimeSectionProps {
	lspStatus: LspStatus | null;
	lspDetections: LspDetection[];
	onLspAction: (action: LspAction) => Promise<void> | void;
	onDetectLsp: () => Promise<void> | void;
	mcpStatus: McpStatus | null;
	expandedMcpServer: string | null;
	onToggleMcpServer: (name: string) => void;
	onRefreshMcpStatus: () => Promise<void> | void;
	onSearchMcpRegistry: (query: string) => Promise<McpRegistrySearchResponse>;
	onImportMcpRegistry: (
		input: McpRegistryImportRequest,
	) => Promise<McpRegistryImportResponse>;
	onAddMcpServer: (
		input: McpServerAddRequest,
	) => Promise<McpServerMutationResponse>;
	onUpdateMcpServer: (
		input: McpServerUpdateRequest,
	) => Promise<McpServerMutationResponse>;
	onRemoveMcpServer: (
		input: McpServerRemoveRequest,
	) => Promise<McpServerRemoveResponse>;
	composerStatus: ComposerStatus | null;
	selectedComposer: string;
	onSelectedComposerChange: (name: string) => void;
	onRefreshComposers: () => Promise<void> | void;
	onActivateComposer: () => Promise<void> | void;
	onDeactivateComposer: () => Promise<void> | void;
}

function formatCountLabel(
	count: number,
	singular: string,
	plural: string,
): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function formatMcpErrorLabel(error: string | undefined): string | null {
	if (typeof error !== "string") {
		return null;
	}

	return error.trim() || "Connection failed.";
}

function formatMcpTrustLabel(
	trust: McpServerStatus["remoteTrust"],
): string | null {
	switch (trust) {
		case "official":
			return "Official remote";
		case "custom":
			return "Custom remote";
		case "unknown":
			return "Unverified remote";
		default:
			return null;
	}
}

export {
	formatMcpArgsText,
	formatMcpKeyValueText,
	formatMcpRegistryImportMessage,
	formatMcpServerAddMessage,
	formatMcpServerRemoveMessage,
	formatMcpServerUpdateMessage,
	formatMcpTimeoutText,
	getMcpRegistryEntryId,
	parseMcpArgsText,
	parseMcpKeyValueText,
	parseMcpTimeoutText,
};

const formatMcpScopeLabel = formatMcpConfigScopeLabel;

export function buildLspViewModel(
	status: LspStatus | null,
	detections: LspDetection[],
): LspViewModel {
	const servers = status?.servers ?? [];

	return {
		enabledLabel: status?.enabled ? "Yes" : "No",
		autostartLabel: status?.autostart ? "Yes" : "No",
		serverCount: servers.length,
		servers: servers.map((server) => ({
			id: server.id,
			summary: `${server.fileCount} files · ${server.diagnosticCount} diag`,
		})),
		detectionsLabel: detections
			.map((detection) => detection.serverId)
			.join(", "),
	};
}

export function buildMcpServerViewModel(
	server: McpServerStatus,
	expandedServer: string | null,
): McpServerViewModel {
	const tools = Array.isArray(server.tools) ? server.tools : [];
	const toolCount = Array.isArray(server.tools)
		? server.tools.length
		: (server.tools ?? 0);
	const resources = server.resources ?? [];
	const prompts = server.prompts ?? [];
	const sourceLabel = formatMcpScopeLabel(server.scope);
	const transportLabel = formatMcpTransportLabel(server.transport);
	const remoteTrustLabel = formatMcpTrustLabel(server.remoteTrust);
	const summaryParts = [
		server.connected ? "Connected" : "Offline",
		sourceLabel,
		transportLabel ? `via ${transportLabel}` : null,
		formatCountLabel(toolCount, "tool", "tools"),
		formatCountLabel(resources.length, "resource", "resources"),
		formatCountLabel(prompts.length, "prompt", "prompts"),
	].filter((part): part is string => Boolean(part));

	return {
		name: server.name,
		summary: summaryParts.join(" · "),
		isExpanded: expandedServer === server.name,
		transport: server.transport,
		writableScope: getWritableMcpScope(server.scope),
		sourceLabel,
		transportLabel,
		remoteTrustLabel,
		errorLabel: formatMcpErrorLabel(server.error),
		command: server.command?.trim() || null,
		args: Array.isArray(server.args) ? server.args : [],
		cwd: server.cwd?.trim() || null,
		envKeys: Array.isArray(server.envKeys) ? server.envKeys : [],
		remoteHost: server.remoteHost?.trim() || null,
		remoteUrl: server.remoteUrl?.trim() || null,
		headerKeys: Array.isArray(server.headerKeys) ? server.headerKeys : [],
		headersHelper: server.headersHelper?.trim() || null,
		timeout: typeof server.timeout === "number" ? server.timeout : null,
		officialRegistryName: server.officialRegistry?.displayName?.trim() || null,
		officialRegistryDirectoryUrl:
			server.officialRegistry?.directoryUrl?.trim() || null,
		officialRegistryDocumentationUrl:
			server.officialRegistry?.documentationUrl?.trim() || null,
		officialRegistryAuthor: server.officialRegistry?.authorName?.trim() || null,
		officialRegistryPermissions:
			server.officialRegistry?.permissions?.trim() || null,
		toolCount,
		tools,
		toolDetailsLabel:
			tools.length > 0
				? null
				: toolCount > 0
					? `${toolCount} tools reported (details unavailable).`
					: "No tools reported.",
		resources,
		prompts,
	};
}

export function buildMcpRegistryEntryViewModel(
	entry: McpOfficialRegistryEntry,
	fallbackIndex = 0,
): McpRegistryEntryViewModel {
	const transportLabel = formatMcpTransportLabel(entry.transport);
	const counts = [
		typeof entry.toolCount === "number"
			? formatCountLabel(entry.toolCount, "tool", "tools")
			: null,
		typeof entry.promptCount === "number"
			? formatCountLabel(entry.promptCount, "prompt", "prompts")
			: null,
	].filter((part): part is string => Boolean(part));
	const normalizedUrlOptions = getMcpRegistryUrlOptions(entry);
	const fallbackUrl = entry.url?.trim() || null;
	const importQuery =
		entry.slug?.trim() ||
		entry.serverName?.trim() ||
		entry.displayName?.trim() ||
		fallbackUrl ||
		`entry-${fallbackIndex}`;
	const title =
		entry.displayName?.trim() ||
		entry.serverName?.trim() ||
		entry.slug?.trim() ||
		fallbackUrl ||
		"Unnamed registry entry";
	const summaryParts = [
		transportLabel ? `via ${transportLabel}` : null,
		entry.authorName?.trim() ? `by ${entry.authorName.trim()}` : null,
		counts.length > 0 ? counts.join(" · ") : null,
	].filter((part): part is string => Boolean(part));

	return {
		id: getMcpRegistryEntryId(entry, fallbackIndex),
		importQuery,
		title,
		description: entry.oneLiner?.trim() || null,
		summary: summaryParts.length > 0 ? summaryParts.join(" · ") : null,
		transportLabel,
		countsLabel: counts.length > 0 ? counts.join(" · ") : null,
		authorLabel: entry.authorName?.trim() || null,
		permissionsLabel: entry.permissions?.trim() || null,
		directoryUrl: entry.directoryUrl?.trim() || null,
		documentationUrl: entry.documentationUrl?.trim() || null,
		urlOptions: normalizedUrlOptions,
		defaultUrl: normalizedUrlOptions[0]?.url ?? null,
	};
}

export function buildComposerProfilesViewModel(
	status: ComposerStatus | null,
	selectedComposer: string,
): ComposerProfilesViewModel {
	return {
		options: status?.composers ?? [],
		activeLabel: status?.active?.name ?? "none",
		canActivate: Boolean(selectedComposer),
	};
}

export function resolveComposerSelection(
	status: ComposerStatus | null,
	currentSelection: string,
): string {
	if (!status) {
		return currentSelection;
	}

	const activeName = status.active?.name;
	if (activeName) {
		return activeName;
	}

	if (!currentSelection && status.composers.length > 0) {
		return status.composers[0].name;
	}

	return currentSelection;
}

export function ToolsRuntimeSection({
	lspStatus,
	lspDetections,
	onLspAction,
	onDetectLsp,
	mcpStatus,
	expandedMcpServer,
	onToggleMcpServer,
	onRefreshMcpStatus,
	onSearchMcpRegistry,
	onImportMcpRegistry,
	onAddMcpServer,
	onUpdateMcpServer,
	onRemoveMcpServer,
	composerStatus,
	selectedComposer,
	onSelectedComposerChange,
	onRefreshComposers,
	onActivateComposer,
	onDeactivateComposer,
}: ToolsRuntimeSectionProps) {
	const lsp = useMemo(
		() => buildLspViewModel(lspStatus, lspDetections),
		[lspStatus, lspDetections],
	);
	const mcpServers = useMemo(
		() =>
			(mcpStatus?.servers ?? []).map((server) =>
				buildMcpServerViewModel(server, expandedMcpServer),
			),
		[mcpStatus, expandedMcpServer],
	);
	const [registryQuery, setRegistryQuery] = useState("");
	const [registryScope, setRegistryScope] =
		useState<McpRegistryImportRequest["scope"]>("local");
	const [registryEntries, setRegistryEntries] = useState<
		McpOfficialRegistryEntry[]
	>([]);
	const [registryLoading, setRegistryLoading] = useState(false);
	const [registryImportingId, setRegistryImportingId] = useState<string | null>(
		null,
	);
	const [registryError, setRegistryError] = useState<string | null>(null);
	const [registryNotice, setRegistryNotice] = useState<string | null>(null);
	const [registryNames, setRegistryNames] = useState<Record<string, string>>(
		{},
	);
	const [registrySelectedUrls, setRegistrySelectedUrls] = useState<
		Record<string, string>
	>({});
	const [customServerName, setCustomServerName] = useState("");
	const [customServerCommand, setCustomServerCommand] = useState("");
	const [customServerArgsText, setCustomServerArgsText] = useState("");
	const [customServerCwd, setCustomServerCwd] = useState("");
	const [customServerEnvText, setCustomServerEnvText] = useState("");
	const [customServerUrl, setCustomServerUrl] = useState("");
	const [customServerHeadersText, setCustomServerHeadersText] = useState("");
	const [customServerHeadersHelper, setCustomServerHeadersHelper] =
		useState("");
	const [customServerTimeoutText, setCustomServerTimeoutText] = useState("");
	const [customServerTransport, setCustomServerTransport] = useState<
		"stdio" | "http" | "sse"
	>("http");
	const [customServerScope, setCustomServerScope] =
		useState<McpRegistryImportRequest["scope"]>("local");
	const [serverMutationError, setServerMutationError] = useState<string | null>(
		null,
	);
	const [serverMutationNotice, setServerMutationNotice] = useState<
		string | null
	>(null);
	const [customServerSubmitting, setCustomServerSubmitting] = useState(false);
	const [removingServerName, setRemovingServerName] = useState<string | null>(
		null,
	);
	const [editingServerUrls, setEditingServerUrls] = useState<
		Record<string, string>
	>({});
	const [editingServerCommands, setEditingServerCommands] = useState<
		Record<string, string>
	>({});
	const [editingServerArgsText, setEditingServerArgsText] = useState<
		Record<string, string>
	>({});
	const [editingServerCwds, setEditingServerCwds] = useState<
		Record<string, string>
	>({});
	const [editingServerEnvTexts, setEditingServerEnvTexts] = useState<
		Record<string, string>
	>({});
	const [editingServerHeadersHelpers, setEditingServerHeadersHelpers] =
		useState<Record<string, string>>({});
	const [editingServerHeadersTexts, setEditingServerHeadersTexts] = useState<
		Record<string, string>
	>({});
	const [editingServerTimeouts, setEditingServerTimeouts] = useState<
		Record<string, string>
	>({});
	const [editingServerTransports, setEditingServerTransports] = useState<
		Record<string, "stdio" | "http" | "sse">
	>({});
	const [updatingServerName, setUpdatingServerName] = useState<string | null>(
		null,
	);
	const registryResults = useMemo(
		() =>
			registryEntries.map((entry, index) =>
				buildMcpRegistryEntryViewModel(entry, index),
			),
		[registryEntries],
	);
	const composers = useMemo(
		() => buildComposerProfilesViewModel(composerStatus, selectedComposer),
		[composerStatus, selectedComposer],
	);

	useEffect(() => {
		let active = true;

		const loadRegistry = async () => {
			setRegistryLoading(true);
			setRegistryError(null);
			try {
				const result = await onSearchMcpRegistry("");
				if (!active) {
					return;
				}
				setRegistryEntries(result.entries ?? []);
			} catch (error) {
				if (!active) {
					return;
				}
				setRegistryError(
					error instanceof Error
						? error.message
						: "Failed to load official MCP registry",
				);
			} finally {
				if (active) {
					setRegistryLoading(false);
				}
			}
		};

		void loadRegistry();

		return () => {
			active = false;
		};
	}, [onSearchMcpRegistry]);

	const runRegistrySearch = async (query: string) => {
		setRegistryLoading(true);
		setRegistryError(null);
		setRegistryNotice(null);
		try {
			const result = await onSearchMcpRegistry(query);
			setRegistryEntries(result.entries ?? []);
		} catch (error) {
			setRegistryEntries([]);
			setRegistryError(
				error instanceof Error
					? error.message
					: "Failed to search the official MCP registry",
			);
		} finally {
			setRegistryLoading(false);
		}
	};

	const handleRegistrySearchSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		void runRegistrySearch(registryQuery);
	};

	const handleRegistryImport = async (
		entry: McpRegistryEntryViewModel,
	): Promise<void> => {
		setRegistryImportingId(entry.id);
		setRegistryError(null);
		setRegistryNotice(null);
		try {
			const customName = registryNames[entry.id]?.trim() || undefined;
			const selectedUrl =
				registrySelectedUrls[entry.id]?.trim() || entry.defaultUrl || undefined;
			const result = await onImportMcpRegistry({
				query: entry.importQuery,
				scope: registryScope,
				name: customName,
				url: selectedUrl,
			});
			setRegistryNotice(formatMcpRegistryImportMessage(result));
			setRegistryNames((prev) => ({ ...prev, [entry.id]: "" }));
		} catch (error) {
			setRegistryError(
				error instanceof Error
					? error.message
					: "Failed to import MCP registry entry",
			);
		} finally {
			setRegistryImportingId(null);
		}
	};

	const handleCustomServerSubmit = async (
		event: FormEvent<HTMLFormElement>,
	): Promise<void> => {
		event.preventDefault();
		setCustomServerSubmitting(true);
		setServerMutationError(null);
		setServerMutationNotice(null);
		try {
			const result = await onAddMcpServer({
				scope: customServerScope,
				server: {
					name: customServerName.trim(),
					transport: customServerTransport,
					command:
						customServerTransport === "stdio"
							? customServerCommand.trim()
							: undefined,
					args:
						customServerTransport === "stdio"
							? parseMcpArgsText(customServerArgsText)
							: undefined,
					cwd:
						customServerTransport === "stdio"
							? customServerCwd.trim() || undefined
							: undefined,
					env:
						customServerTransport === "stdio"
							? parseMcpKeyValueText(customServerEnvText)
							: undefined,
					url:
						customServerTransport === "stdio"
							? undefined
							: customServerUrl.trim(),
					headers:
						customServerTransport === "stdio"
							? undefined
							: parseMcpKeyValueText(customServerHeadersText),
					headersHelper:
						customServerTransport === "stdio"
							? undefined
							: customServerHeadersHelper.trim() || undefined,
					timeout: parseMcpTimeoutText(customServerTimeoutText),
				},
			});
			setServerMutationNotice(formatMcpServerAddMessage(result));
			setCustomServerName("");
			setCustomServerCommand("");
			setCustomServerArgsText("");
			setCustomServerCwd("");
			setCustomServerEnvText("");
			setCustomServerUrl("");
			setCustomServerHeadersText("");
			setCustomServerHeadersHelper("");
			setCustomServerTimeoutText("");
			setCustomServerTransport("http");
		} catch (error) {
			setServerMutationError(
				error instanceof Error ? error.message : "Failed to add MCP server",
			);
		} finally {
			setCustomServerSubmitting(false);
		}
	};

	const handleRemoveServer = async (
		server: McpServerViewModel,
	): Promise<void> => {
		if (!server.writableScope) {
			return;
		}
		setRemovingServerName(server.name);
		setServerMutationError(null);
		setServerMutationNotice(null);
		try {
			const result = await onRemoveMcpServer({
				name: server.name,
				scope: server.writableScope,
			});
			setServerMutationNotice(formatMcpServerRemoveMessage(result));
		} catch (error) {
			setServerMutationError(
				error instanceof Error ? error.message : "Failed to remove MCP server",
			);
		} finally {
			setRemovingServerName(null);
		}
	};

	const handleUpdateServer = async (
		server: McpServerViewModel,
	): Promise<void> => {
		if (!server.writableScope || !server.transport) {
			return;
		}
		setUpdatingServerName(server.name);
		setServerMutationError(null);
		setServerMutationNotice(null);
		try {
			const hasEditedArgs = Object.prototype.hasOwnProperty.call(
				editingServerArgsText,
				server.name,
			);
			const hasEditedCwd = Object.prototype.hasOwnProperty.call(
				editingServerCwds,
				server.name,
			);
			const hasEditedEnv = Object.prototype.hasOwnProperty.call(
				editingServerEnvTexts,
				server.name,
			);
			const hasEditedHeaders = Object.prototype.hasOwnProperty.call(
				editingServerHeadersTexts,
				server.name,
			);
			const hasEditedHeadersHelper = Object.prototype.hasOwnProperty.call(
				editingServerHeadersHelpers,
				server.name,
			);
			const hasEditedTimeout = Object.prototype.hasOwnProperty.call(
				editingServerTimeouts,
				server.name,
			);
			const serverInput: McpServerUpdateRequest["server"] =
				server.transport === "stdio"
					? {
							name: server.name,
							transport: "stdio",
							command:
								editingServerCommands[server.name]?.trim() ||
								server.command ||
								"",
							args: hasEditedArgs
								? (parseMcpArgsText(editingServerArgsText[server.name] ?? "") ??
									null)
								: undefined,
							cwd: hasEditedCwd
								? editingServerCwds[server.name]?.trim() || null
								: undefined,
							env: hasEditedEnv
								? (parseMcpKeyValueText(
										editingServerEnvTexts[server.name] ?? "",
									) ?? null)
								: undefined,
							timeout: hasEditedTimeout
								? (parseMcpTimeoutText(
										editingServerTimeouts[server.name] ?? "",
									) ?? null)
								: undefined,
						}
					: {
							name: server.name,
							transport:
								editingServerTransports[server.name] ??
								(server.transport === "sse" ? "sse" : "http"),
							url:
								editingServerUrls[server.name]?.trim() ||
								server.remoteUrl ||
								"",
							headers: hasEditedHeaders
								? (parseMcpKeyValueText(
										editingServerHeadersTexts[server.name] ?? "",
									) ?? null)
								: undefined,
							headersHelper: hasEditedHeadersHelper
								? editingServerHeadersHelpers[server.name]?.trim() || null
								: undefined,
							timeout: hasEditedTimeout
								? (parseMcpTimeoutText(
										editingServerTimeouts[server.name] ?? "",
									) ?? null)
								: undefined,
						};
			const result = await onUpdateMcpServer({
				name: server.name,
				scope: server.writableScope,
				server: serverInput,
			});
			setServerMutationNotice(formatMcpServerUpdateMessage(result));
		} catch (error) {
			setServerMutationError(
				error instanceof Error ? error.message : "Failed to update MCP server",
			);
		} finally {
			setUpdatingServerName(null);
		}
	};

	return (
		<section className="border border-line-subtle rounded-xl overflow-hidden">
			<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
				Tools & Runtime
			</div>
			<div className="p-4 space-y-5">
				<div className="space-y-2">
					<div className="flex items-center justify-between gap-4">
						<div>
							<div className="text-text-primary font-medium">LSP servers</div>
							<div className="text-xs text-text-muted">Slash command: /lsp</div>
						</div>
						<div className="flex items-center gap-2">
							<button
								type="button"
								className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
								onClick={() => onLspAction("start")}
							>
								Start
							</button>
							<button
								type="button"
								className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
								onClick={() => onLspAction("stop")}
							>
								Stop
							</button>
							<button
								type="button"
								className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
								onClick={() => onLspAction("restart")}
							>
								Restart
							</button>
							<button
								type="button"
								className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
								onClick={onDetectLsp}
							>
								Detect
							</button>
						</div>
					</div>
					<div className="text-xs text-text-muted">
						Enabled: {lsp.enabledLabel} · Autostart: {lsp.autostartLabel} ·
						Servers: {lsp.serverCount}
					</div>
					{lsp.servers.length ? (
						<div className="grid grid-cols-1 gap-2">
							{lsp.servers.map((server) => (
								<div
									key={server.id}
									className="flex items-center justify-between text-xs text-text-muted"
								>
									<span>{server.id}</span>
									<span>{server.summary}</span>
								</div>
							))}
						</div>
					) : (
						<div className="text-xs text-text-muted">
							No active LSP servers.
						</div>
					)}
					{lsp.detectionsLabel && (
						<div className="text-xs text-text-muted">
							Detected: {lsp.detectionsLabel}
						</div>
					)}
				</div>

				<div className="space-y-2">
					<div className="flex items-center justify-between gap-4">
						<div>
							<div className="text-text-primary font-medium">MCP servers</div>
							<div className="text-xs text-text-muted">Slash command: /mcp</div>
						</div>
						<button
							type="button"
							className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
							onClick={onRefreshMcpStatus}
						>
							Refresh
						</button>
					</div>
					{mcpServers.length ? (
						<div className="grid grid-cols-1 gap-2">
							{mcpServers.map((server) => (
								<div
									key={server.name}
									className="rounded-lg border border-line-subtle/60 bg-bg-tertiary/30"
								>
									<div className="flex items-center gap-2 px-3 py-2">
										<button
											type="button"
											className="flex-1 flex items-center justify-between text-xs text-text-muted"
											onClick={() => onToggleMcpServer(server.name)}
										>
											<span className="text-text-primary">{server.name}</span>
											<span>{server.summary}</span>
										</button>
										{server.writableScope && (
											<button
												type="button"
												className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-secondary/60 disabled:opacity-60"
												onClick={() => void handleRemoveServer(server)}
												disabled={removingServerName === server.name}
											>
												{removingServerName === server.name
													? "Removing..."
													: "Remove"}
											</button>
										)}
									</div>
									{server.isExpanded && (
										<div className="border-t border-line-subtle/60 px-3 py-2 space-y-2 text-[11px] text-text-muted">
											{(server.sourceLabel ||
												server.transportLabel ||
												server.remoteTrustLabel) && (
												<div className="flex flex-wrap gap-1">
													{server.sourceLabel && (
														<span className="px-2 py-0.5 rounded-full border border-line-subtle/60 bg-bg-secondary/60 text-text-secondary">
															{server.sourceLabel}
														</span>
													)}
													{server.transportLabel && (
														<span className="px-2 py-0.5 rounded-full border border-line-subtle/60 bg-bg-secondary/60 text-text-secondary">
															{server.transportLabel}
														</span>
													)}
													{server.remoteTrustLabel && (
														<span className="px-2 py-0.5 rounded-full border border-line-subtle/60 bg-bg-secondary/60 text-text-secondary">
															{server.remoteTrustLabel}
														</span>
													)}
												</div>
											)}
											{server.errorLabel && (
												<div className="rounded-lg border border-error/40 bg-error/10 px-2.5 py-2 text-error">
													{server.errorLabel}
												</div>
											)}
											{(server.remoteHost || server.remoteUrl) && (
												<div className="space-y-1">
													{server.remoteHost && (
														<div>Host: {server.remoteHost}</div>
													)}
													{server.remoteUrl && (
														<div className="truncate" title={server.remoteUrl}>
															URL: {server.remoteUrl}
														</div>
													)}
												</div>
											)}
											{(server.command ||
												server.cwd ||
												server.args.length > 0) && (
												<div className="space-y-1">
													{server.command && (
														<div>Command: {server.command}</div>
													)}
													{server.args.length > 0 && (
														<div title={server.args.join(" ")}>
															Args: {server.args.join(" ")}
														</div>
													)}
													{server.cwd && (
														<div className="truncate" title={server.cwd}>
															CWD: {server.cwd}
														</div>
													)}
												</div>
											)}
											{(server.timeout ||
												server.headersHelper ||
												server.envKeys.length > 0 ||
												server.headerKeys.length > 0) && (
												<div className="space-y-1">
													{server.timeout && (
														<div>Timeout: {server.timeout} ms</div>
													)}
													{server.headersHelper && (
														<div
															className="truncate"
															title={server.headersHelper}
														>
															Headers helper: {server.headersHelper}
														</div>
													)}
													{server.envKeys.length > 0 && (
														<div title={server.envKeys.join(", ")}>
															Env keys: {server.envKeys.join(", ")}
														</div>
													)}
													{server.headerKeys.length > 0 && (
														<div title={server.headerKeys.join(", ")}>
															Header keys: {server.headerKeys.join(", ")}
														</div>
													)}
												</div>
											)}
											{server.officialRegistryName && (
												<div className="rounded-lg border border-line-subtle/60 bg-bg-secondary/50 px-2.5 py-2 space-y-1">
													<div className="text-text-primary">
														Official registry: {server.officialRegistryName}
													</div>
													{server.officialRegistryAuthor && (
														<div>Author: {server.officialRegistryAuthor}</div>
													)}
													{server.officialRegistryPermissions && (
														<div>
															Permissions: {server.officialRegistryPermissions}
														</div>
													)}
													{(server.officialRegistryDirectoryUrl ||
														server.officialRegistryDocumentationUrl) && (
														<div className="flex flex-wrap gap-3">
															{server.officialRegistryDirectoryUrl && (
																<a
																	href={server.officialRegistryDirectoryUrl}
																	target="_blank"
																	rel="noreferrer"
																	className="text-accent hover:underline"
																>
																	Directory
																</a>
															)}
															{server.officialRegistryDocumentationUrl && (
																<a
																	href={server.officialRegistryDocumentationUrl}
																	target="_blank"
																	rel="noreferrer"
																	className="text-accent hover:underline"
																>
																	Docs
																</a>
															)}
														</div>
													)}
												</div>
											)}
											{server.writableScope && server.remoteUrl && (
												<div className="rounded-lg border border-line-subtle/60 bg-bg-secondary/40 px-2.5 py-2 space-y-2">
													<div className="text-text-primary">Edit remote</div>
													<div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_140px_auto] gap-2">
														<input
															type="url"
															value={
																editingServerUrls[server.name] ??
																server.remoteUrl
															}
															onChange={(event) =>
																setEditingServerUrls((prev) => ({
																	...prev,
																	[server.name]: event.target.value,
																}))
															}
															placeholder="https://example.com/mcp"
															aria-label={`Remote URL for ${server.name}`}
															className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
														/>
														<select
															value={
																editingServerTransports[server.name] ??
																(server.transport === "sse" ? "sse" : "http")
															}
															onChange={(event) =>
																setEditingServerTransports((prev) => ({
																	...prev,
																	[server.name]: event.target.value as
																		| "http"
																		| "sse",
																}))
															}
															aria-label={`Remote transport for ${server.name}`}
															className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
														>
															<option value="http">HTTP</option>
															<option value="sse">SSE</option>
														</select>
														<button
															type="button"
															className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-60"
															onClick={() => void handleUpdateServer(server)}
															disabled={updatingServerName === server.name}
														>
															{updatingServerName === server.name
																? "Saving..."
																: "Save"}
														</button>
													</div>
													<div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_180px] gap-2">
														<input
															type="text"
															value={
																editingServerHeadersHelpers[server.name] ??
																server.headersHelper ??
																""
															}
															onChange={(event) =>
																setEditingServerHeadersHelpers((prev) => ({
																	...prev,
																	[server.name]: event.target.value,
																}))
															}
															placeholder="Headers helper (optional)"
															aria-label={`Headers helper for ${server.name}`}
															className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
														/>
														<input
															type="number"
															min="1"
															value={
																editingServerTimeouts[server.name] ??
																formatMcpTimeoutText(server.timeout)
															}
															onChange={(event) =>
																setEditingServerTimeouts((prev) => ({
																	...prev,
																	[server.name]: event.target.value,
																}))
															}
															placeholder="Timeout (ms)"
															aria-label={`Timeout for ${server.name}`}
															className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
														/>
													</div>
													<textarea
														value={editingServerHeadersTexts[server.name] ?? ""}
														onChange={(event) =>
															setEditingServerHeadersTexts((prev) => ({
																...prev,
																[server.name]: event.target.value,
															}))
														}
														placeholder="Headers (KEY=VALUE, one per line)"
														aria-label={`Headers for ${server.name}`}
														className="min-h-[88px] bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
													/>
													<div>
														Header values stay hidden. Enter KEY=VALUE lines to
														replace them.
														{server.headerKeys.length > 0
															? ` Current keys: ${server.headerKeys.join(", ")}.`
															: ""}{" "}
														Delete optional values like timeout or headers
														helper, then save, to clear them.
													</div>
													<div>
														Edits apply to the{" "}
														{formatMcpRegistryScopeLabel(server.writableScope)}{" "}
														config file.
													</div>
												</div>
											)}
											{server.writableScope && server.transport === "stdio" && (
												<div className="rounded-lg border border-line-subtle/60 bg-bg-secondary/40 px-2.5 py-2 space-y-2">
													<div className="text-text-primary">Edit stdio</div>
													<div className="grid grid-cols-1 gap-2">
														<input
															type="text"
															value={
																editingServerCommands[server.name] ??
																server.command ??
																""
															}
															onChange={(event) =>
																setEditingServerCommands((prev) => ({
																	...prev,
																	[server.name]: event.target.value,
																}))
															}
															placeholder="Command"
															aria-label={`Command for ${server.name}`}
															className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
														/>
														<textarea
															value={
																editingServerArgsText[server.name] ??
																formatMcpArgsText(server.args)
															}
															onChange={(event) =>
																setEditingServerArgsText((prev) => ({
																	...prev,
																	[server.name]: event.target.value,
																}))
															}
															placeholder={"Arguments (one per line)"}
															aria-label={`Arguments for ${server.name}`}
															className="min-h-[88px] bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
														/>
														<textarea
															value={editingServerEnvTexts[server.name] ?? ""}
															onChange={(event) =>
																setEditingServerEnvTexts((prev) => ({
																	...prev,
																	[server.name]: event.target.value,
																}))
															}
															placeholder={"Env vars (KEY=VALUE, one per line)"}
															aria-label={`Environment variables for ${server.name}`}
															className="min-h-[88px] bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
														/>
														<div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_180px_auto] gap-2">
															<input
																type="text"
																value={
																	editingServerCwds[server.name] ??
																	server.cwd ??
																	""
																}
																onChange={(event) =>
																	setEditingServerCwds((prev) => ({
																		...prev,
																		[server.name]: event.target.value,
																	}))
																}
																placeholder="Working directory (optional)"
																aria-label={`Working directory for ${server.name}`}
																className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
															/>
															<input
																type="number"
																min="1"
																value={
																	editingServerTimeouts[server.name] ??
																	formatMcpTimeoutText(server.timeout)
																}
																onChange={(event) =>
																	setEditingServerTimeouts((prev) => ({
																		...prev,
																		[server.name]: event.target.value,
																	}))
																}
																placeholder="Timeout (ms)"
																aria-label={`Timeout for ${server.name}`}
																className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
															/>
															<button
																type="button"
																className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-60"
																onClick={() => void handleUpdateServer(server)}
																disabled={
																	updatingServerName === server.name ||
																	(
																		editingServerCommands[server.name] ??
																		server.command ??
																		""
																	).trim().length === 0
																}
															>
																{updatingServerName === server.name
																	? "Saving..."
																	: "Save"}
															</button>
														</div>
													</div>
													<div>
														Env values stay hidden. Enter KEY=VALUE lines to
														replace them.
														{server.envKeys.length > 0
															? ` Current keys: ${server.envKeys.join(", ")}.`
															: ""}{" "}
														Delete optional values like args, cwd, env vars, or
														timeout, then save, to clear them.
													</div>
													<div>
														Edits apply to the{" "}
														{formatMcpRegistryScopeLabel(server.writableScope)}{" "}
														config file.
													</div>
												</div>
											)}
											{server.tools.length > 0 ? (
												<div>
													<div className="text-text-tertiary uppercase tracking-wide text-[10px] mb-1">
														Tools
													</div>
													<div className="flex flex-wrap gap-1">
														{server.tools.map((tool) => (
															<span
																key={`${server.name}:${tool.name}`}
																className="px-2 py-0.5 rounded-full border border-line-subtle/60 bg-bg-secondary/60 text-text-secondary"
																title={tool.description}
															>
																{tool.name}
															</span>
														))}
													</div>
												</div>
											) : (
												<div>{server.toolDetailsLabel}</div>
											)}
											<div className="grid grid-cols-2 gap-2">
												<div>
													<div className="text-text-tertiary uppercase tracking-wide text-[10px] mb-1">
														Resources
													</div>
													{server.resources.length ? (
														<ul className="space-y-1">
															{server.resources.map((resource) => (
																<li
																	key={`${server.name}:${resource}`}
																	className="truncate"
																>
																	{resource}
																</li>
															))}
														</ul>
													) : (
														<div>None</div>
													)}
												</div>
												<div>
													<div className="text-text-tertiary uppercase tracking-wide text-[10px] mb-1">
														Prompts
													</div>
													{server.prompts.length ? (
														<ul className="space-y-1">
															{server.prompts.map((prompt) => (
																<li
																	key={`${server.name}:${prompt}`}
																	className="truncate"
																>
																	{prompt}
																</li>
															))}
														</ul>
													) : (
														<div>None</div>
													)}
												</div>
											</div>
										</div>
									)}
								</div>
							))}
						</div>
					) : (
						<div className="text-xs text-text-muted">
							No MCP servers configured.
						</div>
					)}
					<div className="rounded-lg border border-line-subtle/60 bg-bg-secondary/30 p-3 space-y-3">
						<div>
							<div className="text-text-primary font-medium">Custom server</div>
							<div className="text-xs text-text-muted">
								Add a stdio command or arbitrary HTTP/SSE MCP endpoint to local,
								project, or user config.
							</div>
						</div>
						<form
							className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2"
							onSubmit={(event) => void handleCustomServerSubmit(event)}
						>
							<input
								type="text"
								value={customServerName}
								onChange={(event) => setCustomServerName(event.target.value)}
								placeholder="Server name"
								aria-label="Custom MCP server name"
								className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
							/>
							<select
								value={customServerTransport}
								onChange={(event) =>
									setCustomServerTransport(
										event.target.value as "stdio" | "http" | "sse",
									)
								}
								aria-label="Custom MCP server transport"
								className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
							>
								<option value="stdio">stdio</option>
								<option value="http">HTTP</option>
								<option value="sse">SSE</option>
							</select>
							{customServerTransport === "stdio" ? (
								<>
									<input
										type="text"
										value={customServerCommand}
										onChange={(event) =>
											setCustomServerCommand(event.target.value)
										}
										placeholder="Command"
										aria-label="Custom MCP server command"
										className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
									/>
									<textarea
										value={customServerArgsText}
										onChange={(event) =>
											setCustomServerArgsText(event.target.value)
										}
										placeholder={"Arguments (one per line)"}
										aria-label="Custom MCP server arguments"
										className="min-h-[88px] bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
									/>
									<input
										type="text"
										value={customServerCwd}
										onChange={(event) => setCustomServerCwd(event.target.value)}
										placeholder="Working directory (optional)"
										aria-label="Custom MCP server working directory"
										className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
									/>
									<textarea
										value={customServerEnvText}
										onChange={(event) =>
											setCustomServerEnvText(event.target.value)
										}
										placeholder={"Env vars (KEY=VALUE, one per line)"}
										aria-label="Custom MCP server environment variables"
										className="min-h-[88px] bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
									/>
								</>
							) : (
								<>
									<input
										type="url"
										value={customServerUrl}
										onChange={(event) => setCustomServerUrl(event.target.value)}
										placeholder="https://example.com/mcp"
										aria-label="Custom MCP server URL"
										className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
									/>
									<input
										type="text"
										value={customServerHeadersHelper}
										onChange={(event) =>
											setCustomServerHeadersHelper(event.target.value)
										}
										placeholder="Headers helper (optional)"
										aria-label="Custom MCP server headers helper"
										className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
									/>
									<textarea
										value={customServerHeadersText}
										onChange={(event) =>
											setCustomServerHeadersText(event.target.value)
										}
										placeholder={"Headers (KEY=VALUE, one per line)"}
										aria-label="Custom MCP server headers"
										className="min-h-[88px] bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
									/>
								</>
							)}
							<div className="flex items-center gap-2">
								<select
									value={customServerScope}
									onChange={(event) =>
										setCustomServerScope(
											event.target.value as McpRegistryImportRequest["scope"],
										)
									}
									aria-label="Custom MCP server scope"
									className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
								>
									<option value="local">Local config</option>
									<option value="project">Project config</option>
									<option value="user">User config</option>
								</select>
								<input
									type="number"
									min="1"
									value={customServerTimeoutText}
									onChange={(event) =>
										setCustomServerTimeoutText(event.target.value)
									}
									placeholder="Timeout (ms)"
									aria-label="Custom MCP server timeout"
									className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
								/>
								<button
									type="submit"
									className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-60"
									disabled={
										customServerSubmitting ||
										customServerName.trim().length === 0 ||
										(customServerTransport === "stdio"
											? customServerCommand.trim().length === 0
											: customServerUrl.trim().length === 0)
									}
								>
									{customServerSubmitting ? "Adding..." : "Add server"}
								</button>
							</div>
						</form>
						{serverMutationError && (
							<div className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">
								{serverMutationError}
							</div>
						)}
						{serverMutationNotice && (
							<div className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
								{serverMutationNotice}
							</div>
						)}
					</div>
					<div className="rounded-lg border border-line-subtle/60 bg-bg-secondary/30 p-3 space-y-3">
						<div className="flex items-center justify-between gap-4">
							<div>
								<div className="text-text-primary font-medium">
									Official registry
								</div>
								<div className="text-xs text-text-muted">
									Search known remote MCP servers and import them without
									memorizing ids.
								</div>
							</div>
							<button
								type="button"
								className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-60"
								onClick={() => {
									setRegistryQuery("");
									void runRegistrySearch("");
								}}
								disabled={registryLoading}
							>
								Top picks
							</button>
						</div>
						<form
							className="flex flex-wrap items-center gap-2"
							onSubmit={handleRegistrySearchSubmit}
						>
							<input
								type="text"
								value={registryQuery}
								onChange={(event) => setRegistryQuery(event.target.value)}
								placeholder="Search official MCP registry"
								aria-label="Search official MCP registry"
								className="flex-1 min-w-[220px] bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
							/>
							<select
								value={registryScope}
								onChange={(event) =>
									setRegistryScope(
										event.target.value as McpRegistryImportRequest["scope"],
									)
								}
								aria-label="Select MCP import scope"
								className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
							>
								<option value="local">Local config</option>
								<option value="project">Project config</option>
								<option value="user">User config</option>
							</select>
							<button
								type="submit"
								className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-60"
								disabled={registryLoading}
							>
								{registryLoading ? "Searching..." : "Search"}
							</button>
						</form>
						<div className="text-[11px] text-text-muted">
							Imports target the {formatMcpRegistryScopeLabel(registryScope)}{" "}
							config by default.
						</div>
						{registryError && (
							<div className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">
								{registryError}
							</div>
						)}
						{registryNotice && (
							<div className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
								{registryNotice}
							</div>
						)}
						{registryResults.length > 0 ? (
							<div className="grid grid-cols-1 gap-2">
								{registryResults.map((entry) => {
									const selectedUrl =
										registrySelectedUrls[entry.id] || entry.defaultUrl || "";
									return (
										<div
											key={entry.id}
											className="rounded-lg border border-line-subtle/60 bg-bg-tertiary/30 p-3 space-y-2"
										>
											<div className="flex items-start justify-between gap-4">
												<div className="min-w-0 space-y-1">
													<div className="text-text-primary font-medium">
														{entry.title}
													</div>
													{entry.description && (
														<div className="text-xs text-text-muted">
															{entry.description}
														</div>
													)}
													{entry.summary && (
														<div className="text-[11px] text-text-muted">
															{entry.summary}
														</div>
													)}
												</div>
												<button
													type="button"
													className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-60"
													onClick={() => void handleRegistryImport(entry)}
													disabled={
														registryImportingId !== null &&
														registryImportingId !== entry.id
													}
												>
													{registryImportingId === entry.id
														? "Importing..."
														: "Import"}
												</button>
											</div>
											<div className="flex flex-wrap gap-1">
												{entry.transportLabel && (
													<span className="px-2 py-0.5 rounded-full border border-line-subtle/60 bg-bg-secondary/60 text-text-secondary text-[11px]">
														{entry.transportLabel}
													</span>
												)}
												{entry.countsLabel && (
													<span className="px-2 py-0.5 rounded-full border border-line-subtle/60 bg-bg-secondary/60 text-text-secondary text-[11px]">
														{entry.countsLabel}
													</span>
												)}
												{entry.authorLabel && (
													<span className="px-2 py-0.5 rounded-full border border-line-subtle/60 bg-bg-secondary/60 text-text-secondary text-[11px]">
														by {entry.authorLabel}
													</span>
												)}
											</div>
											<div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
												<input
													type="text"
													value={registryNames[entry.id] ?? ""}
													onChange={(event) =>
														setRegistryNames((prev) => ({
															...prev,
															[entry.id]: event.target.value,
														}))
													}
													placeholder="Name override (optional)"
													aria-label={`Name override for ${entry.title}`}
													className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
												/>
												{entry.urlOptions.length > 1 ? (
													<select
														value={selectedUrl}
														onChange={(event) =>
															setRegistrySelectedUrls((prev) => ({
																...prev,
																[entry.id]: event.target.value,
															}))
														}
														aria-label={`Endpoint for ${entry.title}`}
														className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
													>
														{entry.urlOptions.map((option) => (
															<option key={option.url} value={option.url}>
																{option.label}
															</option>
														))}
													</select>
												) : (
													<div
														className="truncate rounded-lg border border-line-subtle/60 bg-bg-secondary/40 px-3 py-2 text-[11px] text-text-muted"
														title={selectedUrl || undefined}
													>
														{selectedUrl ||
															"Default endpoint provided by registry"}
													</div>
												)}
											</div>
											{entry.permissionsLabel && (
												<div className="text-[11px] text-text-muted">
													Permissions: {entry.permissionsLabel}
												</div>
											)}
											{(entry.directoryUrl || entry.documentationUrl) && (
												<div className="flex flex-wrap gap-3 text-[11px]">
													{entry.directoryUrl && (
														<a
															href={entry.directoryUrl}
															target="_blank"
															rel="noreferrer"
															className="text-accent hover:underline"
														>
															Directory
														</a>
													)}
													{entry.documentationUrl && (
														<a
															href={entry.documentationUrl}
															target="_blank"
															rel="noreferrer"
															className="text-accent hover:underline"
														>
															Docs
														</a>
													)}
												</div>
											)}
										</div>
									);
								})}
							</div>
						) : (
							<div className="text-xs text-text-muted">
								{registryLoading
									? "Loading official MCP registry..."
									: "No official registry matches."}
							</div>
						)}
					</div>
				</div>

				<div className="space-y-2">
					<div className="flex items-center justify-between gap-4">
						<div>
							<div className="text-text-primary font-medium">
								Composer profiles
							</div>
							<div className="text-xs text-text-muted">
								Slash command: /composer
							</div>
						</div>
						<div className="flex items-center gap-2">
							<button
								type="button"
								className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
								onClick={onRefreshComposers}
							>
								Refresh
							</button>
						</div>
					</div>
					<div className="flex items-center justify-between gap-4">
						<select
							value={selectedComposer}
							onChange={(event) => onSelectedComposerChange(event.target.value)}
							className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary w-64"
						>
							{composers.options.length ? (
								composers.options.map((composer) => (
									<option key={composer.name} value={composer.name}>
										{composer.name}
									</option>
								))
							) : (
								<option value="">No profiles</option>
							)}
						</select>
						<div className="flex items-center gap-2">
							<button
								type="button"
								className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
								onClick={onActivateComposer}
								disabled={!composers.canActivate}
							>
								Activate
							</button>
							<button
								type="button"
								className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
								onClick={onDeactivateComposer}
							>
								Deactivate
							</button>
						</div>
					</div>
					<div className="text-xs text-text-muted">
						Active: {composers.activeLabel}
					</div>
				</div>
			</div>
		</section>
	);
}
