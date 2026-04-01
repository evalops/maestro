import { useMemo } from "react";
import type {
	ComposerProfile,
	ComposerStatus,
	LspStatus,
	McpServerStatus,
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
	sourceLabel: string | null;
	transportLabel: string | null;
	errorLabel: string | null;
	toolCount: number;
	tools: Array<{ name: string; description?: string }>;
	toolDetailsLabel: string | null;
	resources: string[];
	prompts: string[];
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
	composerStatus: ComposerStatus | null;
	selectedComposer: string;
	onSelectedComposerChange: (name: string) => void;
	onRefreshComposers: () => Promise<void> | void;
	onActivateComposer: () => Promise<void> | void;
	onDeactivateComposer: () => Promise<void> | void;
}

function formatMcpScopeLabel(scope: McpServerStatus["scope"]): string | null {
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

function formatMcpTransportLabel(
	transport: McpServerStatus["transport"],
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
		sourceLabel,
		transportLabel,
		errorLabel: formatMcpErrorLabel(server.error),
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
	const composers = useMemo(
		() => buildComposerProfilesViewModel(composerStatus, selectedComposer),
		[composerStatus, selectedComposer],
	);

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
									<button
										type="button"
										className="w-full flex items-center justify-between text-xs text-text-muted px-3 py-2"
										onClick={() => onToggleMcpServer(server.name)}
									>
										<span className="text-text-primary">{server.name}</span>
										<span>{server.summary}</span>
									</button>
									{server.isExpanded && (
										<div className="border-t border-line-subtle/60 px-3 py-2 space-y-2 text-[11px] text-text-muted">
											{(server.sourceLabel || server.transportLabel) && (
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
												</div>
											)}
											{server.errorLabel && (
												<div className="rounded-lg border border-error/40 bg-error/10 px-2.5 py-2 text-error">
													{server.errorLabel}
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
