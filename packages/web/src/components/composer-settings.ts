/**
 * Settings panel component - comprehensive configuration interface
 */

import {
	extractMemoryTags,
	formatMcpArgsText,
	formatMcpPromptOutput,
	formatMcpRegistryImportMessage,
	formatMcpRegistryScopeLabel,
	formatMcpResourceOutput,
	formatMcpServerAddMessage,
	formatMcpServerRemoveMessage,
	formatMcpServerUpdateMessage,
	formatMcpTimeoutText,
	formatMcpTransportLabel,
	formatMemoryRelativeTime,
	getMcpRegistryEntryId,
	getMcpRegistryUrlOptions,
	getWritableMcpScope,
	parseMcpArgsText,
	parseMcpKeyValueText,
	parseMcpTimeoutText,
	truncateMemoryText,
} from "@evalops/contracts";
import type {
	MemoryEntry,
	MemoryStats,
	MemoryTopicSummary,
} from "@evalops/contracts";
import { LitElement, type PropertyValues, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
	ApiClient,
	McpAuthPresetConfigInput,
	McpAuthPresetRemoveResponse,
	McpAuthPresetStatus,
	McpOfficialRegistryEntry,
	McpRegistryImportRequest,
	McpRemoteTrust,
	McpServerAddRequest,
	McpServerConfigInput,
	McpServerRemoveResponse,
	McpServerStatus,
	McpServerUpdateRequest,
	McpStatus,
	Model,
	TeamMemoryStatus,
	UsageSummary,
	WorkspaceStatus,
} from "../services/api-client.js";
import "./composer-package-settings.js";
import { renderComposerSettingsMcpSection } from "./composer-settings-mcp-section.js";
import { composerSettingsStyles } from "./composer-settings.styles.js";

type MemoryView =
	| { kind: "recent" }
	| { kind: "topic"; topic: string }
	| { kind: "search"; query: string };

type MemoryAction =
	| "clear"
	| "delete"
	| "load"
	| "save"
	| "search"
	| "team-init"
	| null;

const EMPTY_MEMORY_STATS: MemoryStats = {
	totalEntries: 0,
	topics: 0,
	oldestEntry: null,
	newestEntry: null,
};

@customElement("composer-settings")
export class ComposerSettings extends LitElement {
	static override styles = composerSettingsStyles;

	@property({ attribute: false }) apiClient!: ApiClient;
	@property({ type: String }) currentModel = "";
	@property({ attribute: false }) currentSessionId: string | null = null;
	@property({ attribute: false }) statusPrefetch: WorkspaceStatus | null = null;
	@property({ attribute: false }) modelsPrefetch: Model[] | null = null;
	@property({ attribute: false }) usagePrefetch: UsageSummary | null = null;

	@state() private loading = true;
	@state() private error: string | null = null;
	@state() private status: WorkspaceStatus | null = null;
	@state() private models: Model[] = [];
	@state() private usage: UsageSummary | null = null;
	@state() private mcpStatus: McpStatus | null = null;
	@state() private mcpRegistryEntries: McpOfficialRegistryEntry[] = [];
	@state() private mcpRegistryQuery = "";
	@state() private mcpRegistryScope: McpRegistryImportRequest["scope"] =
		"local";
	@state() private mcpRegistryLoading = false;
	@state() private mcpRegistryError: string | null = null;
	@state() private mcpRegistryNotice: string | null = null;
	@state() private mcpImportingId: string | null = null;
	@state() private mcpRegistryNames: Record<string, string> = {};
	@state() private mcpRegistrySelectedUrls: Record<string, string> = {};
	@state() private mcpCustomName = "";
	@state() private mcpCustomCommand = "";
	@state() private mcpCustomArgsText = "";
	@state() private mcpCustomCwd = "";
	@state() private mcpCustomEnvText = "";
	@state() private mcpCustomUrl = "";
	@state() private mcpCustomHeadersText = "";
	@state() private mcpCustomHeadersHelper = "";
	@state() private mcpCustomAuthPreset = "";
	@state() private mcpCustomTimeoutText = "";
	@state() private mcpCustomTransport: "stdio" | "http" | "sse" = "http";
	@state() private mcpCustomScope: McpRegistryImportRequest["scope"] = "local";
	@state() private mcpAuthPresetName = "";
	@state() private mcpAuthPresetHeadersText = "";
	@state() private mcpAuthPresetHeadersHelper = "";
	@state() private mcpAuthPresetScope: McpRegistryImportRequest["scope"] =
		"local";
	@state() private mcpManagementError: string | null = null;
	@state() private mcpManagementNotice: string | null = null;
	@state() private mcpCustomSubmitting = false;
	@state() private mcpAuthPresetSubmitting = false;
	@state() private mcpRemovingName: string | null = null;
	@state() private mcpRemovingAuthPresetName: string | null = null;
	@state() private mcpProjectApprovalMutation: {
		name: string;
		decision: "approved" | "denied";
	} | null = null;
	@state() private mcpUpdatingName: string | null = null;
	@state() private mcpUpdatingAuthPresetName: string | null = null;
	@state() private mcpEditingCommands: Record<string, string> = {};
	@state() private mcpEditingArgsText: Record<string, string> = {};
	@state() private mcpEditingCwds: Record<string, string> = {};
	@state() private mcpEditingEnvTexts: Record<string, string> = {};
	@state() private mcpEditingReplaceEnv: Record<string, boolean> = {};
	@state() private mcpEditingUrls: Record<string, string> = {};
	@state() private mcpEditingHeadersTexts: Record<string, string> = {};
	@state() private mcpEditingReplaceHeaders: Record<string, boolean> = {};
	@state() private mcpEditingHeadersHelpers: Record<string, string> = {};
	@state() private mcpEditingAuthPresets: Record<string, string> = {};
	@state() private mcpEditingAuthPresetHeadersTexts: Record<string, string> =
		{};
	@state() private mcpEditingReplaceAuthPresetHeaders: Record<string, boolean> =
		{};
	@state() private mcpEditingAuthPresetHeadersHelpers: Record<string, string> =
		{};
	@state() private mcpEditingTimeouts: Record<string, string> = {};
	@state() private mcpEditingTransports: Record<
		string,
		"stdio" | "http" | "sse"
	> = {};
	@state() private mcpSelectedResources: Record<string, string> = {};
	@state() private mcpSelectedPrompts: Record<string, string> = {};
	@state() private mcpPromptArgsText: Record<string, string> = {};
	@state() private mcpPromptArgumentValues: Record<string, string> = {};
	@state() private mcpResourceOutputs: Record<string, string> = {};
	@state() private mcpPromptOutputs: Record<string, string> = {};
	@state() private mcpResourceErrors: Record<string, string> = {};
	@state() private mcpPromptErrors: Record<string, string> = {};
	@state() private mcpReadingResourceName: string | null = null;
	@state() private mcpGettingPromptName: string | null = null;
	@state() private memoryStats: MemoryStats = EMPTY_MEMORY_STATS;
	@state() private memoryTopics: MemoryTopicSummary[] = [];
	@state() private memoryEntries: MemoryEntry[] = [];
	@state() private memoryActiveView: MemoryView = { kind: "recent" };
	@state() private memorySearchQuery = "";
	@state() private memorySaveTopic = "";
	@state() private memorySaveContent = "";
	@state() private memoryClearConfirmed = false;
	@state() private memorySessionOnly = false;
	@state() private memoryPendingAction: MemoryAction = null;
	@state() private memoryError: string | null = null;
	@state() private memoryNotice: string | null = null;
	@state() private teamMemoryAvailable = false;
	@state() private teamMemoryStatus: TeamMemoryStatus | null = null;
	@state() private selectedTab: "workspace" | "models" | "usage" = "workspace";

	override async connectedCallback() {
		super.connectedCallback();
		this.memorySessionOnly = Boolean(this.currentSessionId);
		await this.loadData();
	}

	override updated(changed: PropertyValues<this>) {
		if (changed.has("currentSessionId")) {
			if (!this.currentSessionId) {
				this.memorySessionOnly = false;
			}
			if (!this.loading) {
				void this.reloadMemorySection();
			}
		}
	}

	private async loadData() {
		this.loading = true;
		this.error = null;
		this.mcpRegistryError = null;

		try {
			let statusData = this.statusPrefetch;
			let modelsData = this.modelsPrefetch;
			let usageData = this.usagePrefetch;

			if (!statusData) statusData = await this.apiClient.getStatus();
			if (!modelsData || modelsData.length === 0)
				modelsData = await this.apiClient.getModels();
			if (!usageData) usageData = await this.apiClient.getUsage();

			this.status = statusData;
			this.models = modelsData || [];
			this.usage = usageData || null;

			if (!statusData || !modelsData || modelsData.length === 0) {
				throw new Error("Failed to load settings data");
			}

			const [
				mcpStatusResult,
				registryResult,
				memoryTopicsResult,
				memoryStatsResult,
				memoryRecentResult,
				teamMemoryStatusResult,
			] = await Promise.allSettled([
				this.apiClient.getMcpStatus(),
				this.apiClient.searchMcpRegistry(""),
				this.apiClient.listMemoryTopics(this.activeMemorySessionId),
				this.apiClient.getMemoryStats(this.activeMemorySessionId),
				this.apiClient.getRecentMemories(12, this.activeMemorySessionId),
				this.apiClient.getTeamMemoryStatus(),
			]);

			if (mcpStatusResult.status === "fulfilled") {
				this.mcpStatus = mcpStatusResult.value;
			} else {
				this.mcpStatus = null;
			}

			if (registryResult.status === "fulfilled") {
				this.mcpRegistryEntries = registryResult.value.entries ?? [];
				this.mcpRegistryError = null;
			} else {
				this.mcpRegistryEntries = [];
				this.mcpRegistryError =
					registryResult.reason instanceof Error
						? registryResult.reason.message
						: "Failed to load official MCP registry";
			}

			if (
				memoryTopicsResult.status === "fulfilled" &&
				memoryStatsResult.status === "fulfilled" &&
				memoryRecentResult.status === "fulfilled"
			) {
				this.memoryTopics = memoryTopicsResult.value.topics ?? [];
				this.memoryStats = memoryStatsResult.value.stats ?? EMPTY_MEMORY_STATS;
				this.memoryEntries = memoryRecentResult.value.memories ?? [];
				this.memoryError = null;
			} else {
				this.memoryTopics = [];
				this.memoryStats = EMPTY_MEMORY_STATS;
				this.memoryEntries = [];
				const firstError = [
					memoryTopicsResult,
					memoryStatsResult,
					memoryRecentResult,
				].find((result) => result.status === "rejected");
				this.memoryError =
					firstError?.status === "rejected" &&
					firstError.reason instanceof Error
						? firstError.reason.message
						: "Failed to load memory";
			}

			if (teamMemoryStatusResult.status === "fulfilled") {
				this.teamMemoryAvailable = teamMemoryStatusResult.value.available;
				this.teamMemoryStatus = teamMemoryStatusResult.value.status;
			} else {
				this.teamMemoryAvailable = false;
				this.teamMemoryStatus = null;
			}
		} catch (e) {
			this.error = e instanceof Error ? e.message : "Failed to load settings";
		} finally {
			this.loading = false;
		}
	}

	private close() {
		this.dispatchEvent(
			new CustomEvent("close", { bubbles: true, composed: true }),
		);
	}

	private selectModel(model: Model) {
		this.dispatchEvent(
			new CustomEvent("model-select", {
				detail: { model: `${model.provider}/${model.id}` },
				bubbles: true,
				composed: true,
			}),
		);
		this.close();
	}

	private formatUptime(seconds: number): string {
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		if (hours > 0) return `${hours}h ${minutes}m`;
		return `${minutes}m`;
	}

	private formatCost(cost: number): string {
		if (cost === 0) return "$0.00";
		if (cost < 0.01) return `$${cost.toFixed(4)}`;
		return `$${cost.toFixed(2)}`;
	}

	private formatTokens(count: number): string {
		if (count < 1000) return count.toString();
		if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
		return `${(count / 1_000_000).toFixed(1)}M`;
	}

	private formatCountLabel(
		count: number,
		singular: string,
		plural: string,
	): string {
		return `${count} ${count === 1 ? singular : plural}`;
	}

	private formatMcpTransportLabel(
		transport: McpServerStatus["transport"],
	): string | null {
		return formatMcpTransportLabel(transport);
	}

	private formatMcpTrustLabel(
		trust: McpRemoteTrust | undefined,
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

	private formatMcpProjectApprovalLabel(
		projectApproval: McpServerStatus["projectApproval"],
	): string | null {
		switch (projectApproval) {
			case "pending":
				return "Pending approval";
			case "approved":
				return "Approved locally";
			case "denied":
				return "Denied locally";
			default:
				return null;
		}
	}

	private getMcpConnectionLabel(server: McpServerStatus): string {
		switch (server.projectApproval) {
			case "pending":
				return "Pending approval";
			case "denied":
				return "Denied";
			default:
				return server.connected ? "Connected" : "Offline";
		}
	}

	private formatMcpScopeLabel(
		scope:
			| McpRegistryImportRequest["scope"]
			| McpAuthPresetStatus["scope"]
			| McpServerStatus["scope"]
			| undefined,
	): string {
		return formatMcpRegistryScopeLabel(scope);
	}

	private getWritableMcpScope(
		scope:
			| McpAuthPresetStatus["scope"]
			| McpServerStatus["scope"]
			| McpRegistryImportRequest["scope"]
			| undefined,
	): McpRegistryImportRequest["scope"] | null {
		return getWritableMcpScope(scope);
	}

	private getMcpRegistryEntryId(
		entry: McpOfficialRegistryEntry,
		index: number,
	): string {
		return getMcpRegistryEntryId(entry, index);
	}

	private getMcpRegistryUrlOptions(entry: McpOfficialRegistryEntry) {
		return getMcpRegistryUrlOptions(entry);
	}

	private async searchMcpRegistry(query: string) {
		this.mcpRegistryLoading = true;
		this.mcpRegistryError = null;
		this.mcpRegistryNotice = null;
		try {
			const result = await this.apiClient.searchMcpRegistry(query);
			this.mcpRegistryEntries = result.entries ?? [];
		} catch (error) {
			this.mcpRegistryEntries = [];
			this.mcpRegistryError =
				error instanceof Error
					? error.message
					: "Failed to search the official MCP registry";
		} finally {
			this.mcpRegistryLoading = false;
		}
	}

	private async importMcpRegistry(
		entry: McpOfficialRegistryEntry,
		index: number,
	) {
		const entryId = this.getMcpRegistryEntryId(entry, index);
		const urlOptions = this.getMcpRegistryUrlOptions(entry);
		this.mcpImportingId = entryId;
		this.mcpRegistryError = null;
		this.mcpRegistryNotice = null;
		try {
			const result = await this.apiClient.importMcpRegistry({
				query:
					entry.slug?.trim() ||
					entry.serverName?.trim() ||
					entry.displayName?.trim() ||
					entry.url?.trim() ||
					`entry-${index}`,
				name: this.mcpRegistryNames[entryId]?.trim() || undefined,
				scope: this.mcpRegistryScope,
				url:
					this.mcpRegistrySelectedUrls[entryId] ||
					urlOptions[0]?.url ||
					undefined,
			});
			this.mcpStatus = await this.apiClient.getMcpStatus();
			this.mcpRegistryNotice = formatMcpRegistryImportMessage(result);
			this.mcpRegistryNames = {
				...this.mcpRegistryNames,
				[entryId]: "",
			};
		} catch (error) {
			this.mcpRegistryError =
				error instanceof Error
					? error.message
					: "Failed to import MCP registry entry";
		} finally {
			this.mcpImportingId = null;
		}
	}

	private formatMcpAddMessage(
		server: McpServerConfigInput & { transport: string },
		scope: McpRegistryImportRequest["scope"],
		name: string,
	): string {
		return formatMcpServerAddMessage({
			name,
			scope: scope ?? "local",
			server: {
				transport: server.transport,
			},
		});
	}

	private formatMcpRemoveMessage(result: McpServerRemoveResponse): string {
		return formatMcpServerRemoveMessage(result);
	}

	private formatMcpUpdateMessage(
		server: McpServerConfigInput & { transport: string },
		scope: McpRegistryImportRequest["scope"],
		name: string,
	): string {
		return formatMcpServerUpdateMessage({
			name,
			scope: scope ?? "local",
			server: {
				transport: server.transport,
			},
		});
	}

	private formatMcpAuthPresetAddMessage(
		name: string,
		scope: McpRegistryImportRequest["scope"],
	): string {
		return `Added auth preset ${name} to ${this.formatMcpScopeLabel(scope ?? "local")}.`;
	}

	private formatMcpAuthPresetUpdateMessage(
		name: string,
		scope: McpRegistryImportRequest["scope"],
	): string {
		return `Saved auth preset ${name} in ${this.formatMcpScopeLabel(scope ?? "local")}.`;
	}

	private formatMcpAuthPresetRemoveMessage(
		result: McpAuthPresetRemoveResponse,
	): string {
		const base = `Removed auth preset ${result.name} from ${this.formatMcpScopeLabel(result.scope)}.`;
		if (!result.fallback) {
			return base;
		}
		return `${base} ${result.fallback.name} from ${this.formatMcpScopeLabel(result.fallback.scope ?? "local")} is now active.`;
	}

	private getAvailableAuthPresets(): McpAuthPresetStatus[] {
		return this.mcpStatus?.authPresets ?? [];
	}

	private formatMcpArgsText(args: string[] | undefined): string {
		return formatMcpArgsText(args);
	}

	private parseMcpArgsText(text: string): string[] | undefined {
		return parseMcpArgsText(text);
	}

	private parseMcpKeyValueText(
		text: string,
	): Record<string, string> | undefined {
		return parseMcpKeyValueText(text);
	}

	private formatMcpTimeoutText(timeout: number | null | undefined): string {
		return formatMcpTimeoutText(timeout);
	}

	private parseMcpTimeoutText(text: string): number | undefined {
		return parseMcpTimeoutText(text);
	}

	private getMcpPromptArgumentValueKey(
		serverName: string,
		promptName: string,
		argumentName: string,
	): string {
		return `${serverName}::${promptName}::${argumentName}`;
	}

	private async readMcpResource(server: McpServerStatus, uri: string) {
		this.mcpReadingResourceName = server.name;
		this.mcpResourceErrors = Object.fromEntries(
			Object.entries(this.mcpResourceErrors).filter(
				([key]) => key !== server.name,
			),
		);
		this.mcpResourceOutputs = Object.fromEntries(
			Object.entries(this.mcpResourceOutputs).filter(
				([key]) => key !== server.name,
			),
		);
		try {
			const result = await this.apiClient.readMcpResource(server.name, uri);
			this.mcpResourceOutputs = {
				...this.mcpResourceOutputs,
				[server.name]: formatMcpResourceOutput(result),
			};
		} catch (error) {
			this.mcpResourceOutputs = Object.fromEntries(
				Object.entries(this.mcpResourceOutputs).filter(
					([key]) => key !== server.name,
				),
			);
			this.mcpResourceErrors = {
				...this.mcpResourceErrors,
				[server.name]:
					error instanceof Error
						? error.message
						: "Failed to read MCP resource",
			};
		} finally {
			if (this.mcpReadingResourceName === server.name) {
				this.mcpReadingResourceName = null;
			}
		}
	}

	private async getMcpPrompt(server: McpServerStatus, name: string) {
		this.mcpGettingPromptName = server.name;
		this.mcpPromptErrors = Object.fromEntries(
			Object.entries(this.mcpPromptErrors).filter(
				([key]) => key !== server.name,
			),
		);
		this.mcpPromptOutputs = Object.fromEntries(
			Object.entries(this.mcpPromptOutputs).filter(
				([key]) => key !== server.name,
			),
		);
		try {
			const selectedPrompt = server.promptDetails?.find(
				(prompt) => prompt.name === name,
			);
			const args =
				selectedPrompt && (selectedPrompt.arguments?.length ?? 0) > 0
					? (() => {
							const entries = (selectedPrompt.arguments ?? []).flatMap(
								(argument) => {
									const key = this.getMcpPromptArgumentValueKey(
										server.name,
										name,
										argument.name,
									);
									const value = this.mcpPromptArgumentValues[key]?.trim() ?? "";
									if (argument.required && value.length === 0) {
										throw new Error(
											`Missing required prompt argument "${argument.name}".`,
										);
									}
									return value.length > 0
										? ([[argument.name, value]] as const)
										: [];
								},
							);
							return entries.length > 0
								? Object.fromEntries(entries)
								: undefined;
						})()
					: this.parseMcpKeyValueText(
							this.mcpPromptArgsText[server.name] ?? "",
						);
			const result = await this.apiClient.getMcpPrompt(server.name, name, args);
			this.mcpPromptOutputs = {
				...this.mcpPromptOutputs,
				[server.name]: formatMcpPromptOutput(result),
			};
		} catch (error) {
			this.mcpPromptOutputs = Object.fromEntries(
				Object.entries(this.mcpPromptOutputs).filter(
					([key]) => key !== server.name,
				),
			);
			this.mcpPromptErrors = {
				...this.mcpPromptErrors,
				[server.name]:
					error instanceof Error ? error.message : "Failed to run MCP prompt",
			};
		} finally {
			if (this.mcpGettingPromptName === server.name) {
				this.mcpGettingPromptName = null;
			}
		}
	}

	private async addCustomMcpServer() {
		this.mcpCustomSubmitting = true;
		this.mcpManagementError = null;
		this.mcpManagementNotice = null;
		try {
			const input: McpServerAddRequest = {
				scope: this.mcpCustomScope,
				server: {
					name: this.mcpCustomName.trim(),
					transport: this.mcpCustomTransport,
					command:
						this.mcpCustomTransport === "stdio"
							? this.mcpCustomCommand.trim()
							: undefined,
					args:
						this.mcpCustomTransport === "stdio"
							? this.parseMcpArgsText(this.mcpCustomArgsText)
							: undefined,
					cwd:
						this.mcpCustomTransport === "stdio"
							? this.mcpCustomCwd.trim() || undefined
							: undefined,
					env:
						this.mcpCustomTransport === "stdio"
							? this.parseMcpKeyValueText(this.mcpCustomEnvText)
							: undefined,
					url:
						this.mcpCustomTransport === "stdio"
							? undefined
							: this.mcpCustomUrl.trim(),
					headers:
						this.mcpCustomTransport === "stdio"
							? undefined
							: this.parseMcpKeyValueText(this.mcpCustomHeadersText),
					headersHelper:
						this.mcpCustomTransport === "stdio"
							? undefined
							: this.mcpCustomHeadersHelper.trim() || undefined,
					authPreset:
						this.mcpCustomTransport === "stdio"
							? undefined
							: this.mcpCustomAuthPreset || undefined,
					timeout: this.parseMcpTimeoutText(this.mcpCustomTimeoutText),
				},
			};
			const result = await this.apiClient.addMcpServer(input);
			this.mcpStatus = await this.apiClient.getMcpStatus();
			this.mcpManagementNotice = this.formatMcpAddMessage(
				result.server,
				result.scope,
				result.name,
			);
			this.mcpCustomName = "";
			this.mcpCustomCommand = "";
			this.mcpCustomArgsText = "";
			this.mcpCustomCwd = "";
			this.mcpCustomEnvText = "";
			this.mcpCustomUrl = "";
			this.mcpCustomHeadersText = "";
			this.mcpCustomHeadersHelper = "";
			this.mcpCustomAuthPreset = "";
			this.mcpCustomTimeoutText = "";
			this.mcpCustomTransport = "http";
		} catch (error) {
			this.mcpManagementError =
				error instanceof Error ? error.message : "Failed to add MCP server";
		} finally {
			this.mcpCustomSubmitting = false;
		}
	}

	private async addMcpAuthPreset() {
		this.mcpAuthPresetSubmitting = true;
		this.mcpManagementError = null;
		this.mcpManagementNotice = null;
		try {
			const input = {
				scope: this.mcpAuthPresetScope,
				preset: {
					name: this.mcpAuthPresetName.trim(),
					headers:
						this.parseMcpKeyValueText(this.mcpAuthPresetHeadersText) ?? null,
					headersHelper: this.mcpAuthPresetHeadersHelper.trim() || null,
				} satisfies McpAuthPresetConfigInput,
			};
			const result = await this.apiClient.addMcpAuthPreset(input);
			this.mcpStatus = await this.apiClient.getMcpStatus();
			this.mcpManagementNotice = this.formatMcpAuthPresetAddMessage(
				result.name,
				result.scope,
			);
			this.mcpAuthPresetName = "";
			this.mcpAuthPresetHeadersText = "";
			this.mcpAuthPresetHeadersHelper = "";
		} catch (error) {
			this.mcpManagementError =
				error instanceof Error
					? error.message
					: "Failed to add MCP auth preset";
		} finally {
			this.mcpAuthPresetSubmitting = false;
		}
	}

	private async updateMcpAuthPreset(
		preset: McpAuthPresetStatus,
		scope: McpRegistryImportRequest["scope"],
	) {
		this.mcpUpdatingAuthPresetName = preset.name;
		this.mcpManagementError = null;
		this.mcpManagementNotice = null;
		try {
			const replacingHeaderValues =
				this.mcpEditingReplaceAuthPresetHeaders[preset.name] === true;
			const hasEditedHeaders =
				replacingHeaderValues ||
				((preset.headerKeys?.length ?? 0) === 0 &&
					Object.prototype.hasOwnProperty.call(
						this.mcpEditingAuthPresetHeadersTexts,
						preset.name,
					));
			const hasEditedHeadersHelper = Object.prototype.hasOwnProperty.call(
				this.mcpEditingAuthPresetHeadersHelpers,
				preset.name,
			);
			const headers = hasEditedHeaders
				? (this.parseMcpKeyValueText(
						this.mcpEditingAuthPresetHeadersTexts[preset.name] ?? "",
					) ?? null)
				: undefined;
			const headersHelper = hasEditedHeadersHelper
				? this.mcpEditingAuthPresetHeadersHelpers[preset.name]?.trim() || null
				: undefined;
			const result = await this.apiClient.updateMcpAuthPreset({
				name: preset.name,
				scope,
				preset: {
					name: preset.name,
					headers,
					headersHelper,
				},
			});
			this.mcpStatus = await this.apiClient.getMcpStatus();
			this.mcpManagementNotice = this.formatMcpAuthPresetUpdateMessage(
				result.name,
				result.scope,
			);
		} catch (error) {
			this.mcpManagementError =
				error instanceof Error
					? error.message
					: "Failed to update MCP auth preset";
		} finally {
			this.mcpUpdatingAuthPresetName = null;
		}
	}

	private async removeMcpAuthPreset(
		name: string,
		scope: McpRegistryImportRequest["scope"],
	) {
		this.mcpRemovingAuthPresetName = name;
		this.mcpManagementError = null;
		this.mcpManagementNotice = null;
		try {
			const result = await this.apiClient.removeMcpAuthPreset({ name, scope });
			this.mcpStatus = await this.apiClient.getMcpStatus();
			this.mcpManagementNotice = this.formatMcpAuthPresetRemoveMessage(result);
		} catch (error) {
			this.mcpManagementError =
				error instanceof Error
					? error.message
					: "Failed to remove MCP auth preset";
		} finally {
			this.mcpRemovingAuthPresetName = null;
		}
	}

	private async removeMcpServer(
		name: string,
		scope: McpRegistryImportRequest["scope"],
	) {
		this.mcpRemovingName = name;
		this.mcpManagementError = null;
		this.mcpManagementNotice = null;
		try {
			const result = await this.apiClient.removeMcpServer({ name, scope });
			this.mcpStatus = await this.apiClient.getMcpStatus();
			this.mcpManagementNotice = this.formatMcpRemoveMessage(result);
		} catch (error) {
			this.mcpManagementError =
				error instanceof Error ? error.message : "Failed to remove MCP server";
		} finally {
			this.mcpRemovingName = null;
		}
	}

	private async setMcpProjectApproval(
		name: string,
		decision: "approved" | "denied",
	) {
		this.mcpProjectApprovalMutation = { name, decision };
		this.mcpManagementError = null;
		this.mcpManagementNotice = null;
		try {
			const result = await this.apiClient.setMcpProjectApproval({
				name,
				decision,
			});
			this.mcpStatus = await this.apiClient.getMcpStatus();
			this.mcpManagementNotice =
				result.projectApproval === "approved"
					? `Approved project MCP server ${result.name}.`
					: `Denied project MCP server ${result.name}.`;
		} catch (error) {
			this.mcpManagementError =
				error instanceof Error
					? error.message
					: "Failed to update MCP project approval";
		} finally {
			if (this.mcpProjectApprovalMutation?.name === name) {
				this.mcpProjectApprovalMutation = null;
			}
		}
	}

	private async updateMcpServer(
		server: McpServerStatus,
		scope: McpRegistryImportRequest["scope"],
	) {
		this.mcpUpdatingName = server.name;
		this.mcpManagementError = null;
		this.mcpManagementNotice = null;
		try {
			const hasEditedArgs = Object.prototype.hasOwnProperty.call(
				this.mcpEditingArgsText,
				server.name,
			);
			const hasEditedCwd = Object.prototype.hasOwnProperty.call(
				this.mcpEditingCwds,
				server.name,
			);
			const replacingEnvValues =
				this.mcpEditingReplaceEnv[server.name] === true;
			const replacingHeaderValues =
				this.mcpEditingReplaceHeaders[server.name] === true;
			const hasEditedEnv =
				replacingEnvValues ||
				((server.envKeys?.length ?? 0) === 0 &&
					Object.prototype.hasOwnProperty.call(
						this.mcpEditingEnvTexts,
						server.name,
					));
			const hasEditedHeaders =
				replacingHeaderValues ||
				((server.headerKeys?.length ?? 0) === 0 &&
					Object.prototype.hasOwnProperty.call(
						this.mcpEditingHeadersTexts,
						server.name,
					));
			const hasEditedHeadersHelper = Object.prototype.hasOwnProperty.call(
				this.mcpEditingHeadersHelpers,
				server.name,
			);
			const hasEditedTimeout = Object.prototype.hasOwnProperty.call(
				this.mcpEditingTimeouts,
				server.name,
			);
			const editableAuthPreset =
				this.mcpEditingAuthPresets[server.name] ?? server.authPreset ?? "";
			const input: McpServerUpdateRequest = {
				name: server.name,
				scope,
				server:
					server.transport === "stdio"
						? {
								name: server.name,
								transport: "stdio",
								command:
									this.mcpEditingCommands[server.name]?.trim() ||
									server.command ||
									"",
								args: hasEditedArgs
									? (this.parseMcpArgsText(
											this.mcpEditingArgsText[server.name] ?? "",
										) ?? null)
									: undefined,
								cwd: hasEditedCwd
									? this.mcpEditingCwds[server.name]?.trim() || null
									: undefined,
								env: hasEditedEnv
									? (this.parseMcpKeyValueText(
											this.mcpEditingEnvTexts[server.name] ?? "",
										) ?? null)
									: undefined,
								timeout: hasEditedTimeout
									? (this.parseMcpTimeoutText(
											this.mcpEditingTimeouts[server.name] ?? "",
										) ?? null)
									: undefined,
							}
						: {
								name: server.name,
								transport:
									this.mcpEditingTransports[server.name] ??
									(server.transport === "sse" ? "sse" : "http"),
								url:
									this.mcpEditingUrls[server.name]?.trim() ||
									server.remoteUrl ||
									"",
								headers: hasEditedHeaders
									? (this.parseMcpKeyValueText(
											this.mcpEditingHeadersTexts[server.name] ?? "",
										) ?? null)
									: undefined,
								headersHelper: hasEditedHeadersHelper
									? this.mcpEditingHeadersHelpers[server.name]?.trim() || null
									: undefined,
								authPreset: editableAuthPreset.trim() || null,
								timeout: hasEditedTimeout
									? (this.parseMcpTimeoutText(
											this.mcpEditingTimeouts[server.name] ?? "",
										) ?? null)
									: undefined,
							},
			};
			const result = await this.apiClient.updateMcpServer(input);
			this.mcpStatus = await this.apiClient.getMcpStatus();
			this.mcpManagementNotice = this.formatMcpUpdateMessage(
				result.server,
				result.scope,
				result.name,
			);
		} catch (error) {
			this.mcpManagementError =
				error instanceof Error ? error.message : "Failed to update MCP server";
		} finally {
			this.mcpUpdatingName = null;
		}
	}

	private get memoryLoading(): boolean {
		return this.memoryPendingAction !== null;
	}

	private get activeMemorySessionId(): string | undefined {
		return this.memorySessionOnly
			? (this.currentSessionId ?? undefined)
			: undefined;
	}

	private getMemoryViewLabel(view: MemoryView): string {
		switch (view.kind) {
			case "topic":
				return `Topic: ${view.topic}`;
			case "search":
				return `Search results for "${view.query}"`;
			default:
				return "Recent memories";
		}
	}

	private async refreshMemorySummary() {
		const [topicsResponse, statsResponse] = await Promise.all([
			this.apiClient.listMemoryTopics(this.activeMemorySessionId),
			this.apiClient.getMemoryStats(this.activeMemorySessionId),
		]);
		this.memoryTopics = topicsResponse.topics ?? [];
		this.memoryStats = statsResponse.stats ?? EMPTY_MEMORY_STATS;
	}

	private async refreshTeamMemoryStatus() {
		const response = await this.apiClient.getTeamMemoryStatus();
		this.teamMemoryAvailable = response.available;
		this.teamMemoryStatus = response.status;
	}

	private async loadMemoryView(view: MemoryView) {
		if (view.kind === "topic") {
			const response = await this.apiClient.listMemoryTopic(
				view.topic,
				this.activeMemorySessionId,
			);
			this.memoryEntries = response.memories ?? [];
			return;
		}
		if (view.kind === "search") {
			const response = await this.apiClient.searchMemory(
				view.query,
				12,
				this.activeMemorySessionId,
			);
			this.memoryEntries = (response.results ?? []).map(
				(result) => result.entry,
			);
			return;
		}
		const response = await this.apiClient.getRecentMemories(
			12,
			this.activeMemorySessionId,
		);
		this.memoryEntries = response.memories ?? [];
	}

	private async reloadMemorySection() {
		try {
			await this.refreshMemorySummary();
			await this.loadMemoryView(this.memoryActiveView);
			await this.refreshTeamMemoryStatus();
		} catch (error) {
			this.memoryError =
				error instanceof Error ? error.message : "Failed to load memory";
		}
	}

	private async runMemoryAction(
		actionType: Exclude<MemoryAction, null>,
		action: () => Promise<void>,
	) {
		this.memoryPendingAction = actionType;
		this.memoryError = null;
		this.memoryNotice = null;
		try {
			await action();
		} catch (error) {
			this.memoryError =
				error instanceof Error ? error.message : "Memory action failed";
		} finally {
			this.memoryPendingAction = null;
		}
	}

	private async showRecentMemories() {
		const nextView: MemoryView = { kind: "recent" };
		await this.runMemoryAction("load", async () => {
			this.memoryActiveView = nextView;
			await this.loadMemoryView(nextView);
		});
	}

	private async selectMemoryTopic(topic: string) {
		const nextView: MemoryView = { kind: "topic", topic };
		await this.runMemoryAction("load", async () => {
			this.memoryActiveView = nextView;
			await this.loadMemoryView(nextView);
		});
	}

	private async searchMemoryEntries() {
		const query = this.memorySearchQuery.trim();
		if (!query) {
			this.memoryError = "Enter a memory search query.";
			return;
		}

		const nextView: MemoryView = { kind: "search", query };
		await this.runMemoryAction("search", async () => {
			this.memoryActiveView = nextView;
			await this.loadMemoryView(nextView);
		});
	}

	private async saveMemoryEntry() {
		const topic = this.memorySaveTopic.trim();
		const content = this.memorySaveContent.trim();
		if (!topic || !content) {
			this.memoryError = "Topic and content are required.";
			return;
		}

		await this.runMemoryAction("save", async () => {
			const tags = extractMemoryTags(content);
			const result = await this.apiClient.saveMemory(
				topic,
				content,
				tags.length > 0 ? tags : undefined,
				this.activeMemorySessionId,
			);
			const savedTopic = result.entry?.topic ?? topic;
			this.memoryNotice =
				result.message || `Memory saved to topic "${savedTopic}"`;
			this.memorySaveTopic = "";
			this.memorySaveContent = "";
			await this.refreshMemorySummary();
			const nextView: MemoryView = { kind: "topic", topic: savedTopic };
			this.memoryActiveView = nextView;
			await this.loadMemoryView(nextView);
		});
	}

	private async deleteMemoryEntry(entry: MemoryEntry) {
		await this.runMemoryAction("delete", async () => {
			const result = await this.apiClient.deleteMemory(entry.id);
			this.memoryNotice = result.message || `Memory ${entry.id} deleted`;
			await this.refreshMemorySummary();
			await this.loadMemoryView(this.memoryActiveView);
		});
	}

	private async clearMemoryEntries() {
		if (!this.memoryClearConfirmed) {
			this.memoryError = "Enable confirmation before clearing all memories.";
			return;
		}

		await this.runMemoryAction("clear", async () => {
			const result = await this.apiClient.clearMemory(true);
			this.memoryNotice = result.message || "Cleared all memories";
			this.memoryClearConfirmed = false;
			this.memoryActiveView = { kind: "recent" };
			this.memoryEntries = [];
			await this.refreshMemorySummary();
		});
	}

	private async initTeamMemoryEntrypoint() {
		await this.runMemoryAction("team-init", async () => {
			const result = await this.apiClient.initTeamMemory();
			this.memoryNotice = result.message || "Team memory initialized.";
			await this.refreshTeamMemoryStatus();
		});
	}

	private renderWorkspaceTab() {
		if (!this.status)
			return html`<div class="loading">Loading workspace status...</div>`;

		return html`
			<div class="section">
				<div class="section-header">
					<h3>Workspace</h3>
				</div>
				<div class="section-content">
					<div class="info-grid">
						<div class="info-label">CWD:</div>
						<div class="info-value">${this.status.cwd}</div>

						${
							this.status.git
								? html`
							<div class="info-label">Git Branch:</div>
							<div class="info-value highlight">${this.status.git.branch}</div>

							${
								this.status.git.status
									? html`
								<div class="info-label">Git Status:</div>
								<div class="info-value">
									${
										this.status.git.status.total === 0
											? html`<span class="success">Clean</span>`
											: html`
											${this.status.git.status.modified > 0 ? html`<span class="badge">${this.status.git.status.modified} Modified</span>` : ""}
											${this.status.git.status.added > 0 ? html`<span class="badge success">${this.status.git.status.added} Added</span>` : ""}
											${this.status.git.status.deleted > 0 ? html`<span class="badge error">${this.status.git.status.deleted} Deleted</span>` : ""}
											${this.status.git.status.untracked > 0 ? html`<span class="badge">${this.status.git.status.untracked} Untracked</span>` : ""}
										`
									}
								</div>
							`
									: ""
							}
						`
								: html`
							<div class="info-label">Git:</div>
							<div class="info-value">Not a git repository</div>
						`
						}
					</div>
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Context Files</h3>
				</div>
				<div class="section-content">
					<div class="info-grid">
						<div class="info-label">AGENT.md:</div>
						<div class="info-value ${this.status.context.agentMd ? "success" : ""}">
							${this.status.context.agentMd ? "Found" : "Not found"}
						</div>

						<div class="info-label">CLAUDE.md:</div>
						<div class="info-value ${this.status.context.claudeMd ? "success" : ""}">
							${this.status.context.claudeMd ? "Found" : "Not found"}
						</div>
					</div>
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Server</h3>
				</div>
				<div class="section-content">
					<div class="info-grid">
						<div class="info-label">Uptime:</div>
						<div class="info-value">${this.formatUptime(this.status.server.uptime)}</div>

						<div class="info-label">Node:</div>
						<div class="info-value">${this.status.server.version}</div>
					</div>
				</div>
			</div>

			${this.renderMcpSection()}
			<composer-package-settings
				.apiClient=${this.apiClient}
			></composer-package-settings>
			${this.renderMemorySection()}
		`;
	}

	private renderMemorySection() {
		const viewLabel = this.getMemoryViewLabel(this.memoryActiveView);

		return html`
			<div class="section">
				<div class="section-header">
					<h3>Memory</h3>
				</div>
				<div class="section-content">
					<div class="control-row">
						<div>
							<div class="info-value">
								${
									this.memorySessionOnly
										? "Current-session memory"
										: "Cross-session memory"
								}
							</div>
							<div class="info-label">
								Slash command: /memory
							</div>
						</div>
						<div class="panel-card-copy">
							Entries: ${this.memoryStats.totalEntries}<br />
							Topics: ${this.memoryStats.topics}<br />
							Newest: ${formatMemoryRelativeTime(this.memoryStats.newestEntry)}
						</div>
					</div>
					${
						this.currentSessionId
							? html`
								<label class="panel-card-copy">
									<input
										type="checkbox"
										.checked=${this.memorySessionOnly}
										aria-label=${"Show current session memories only"}
										@change=${(event: Event) => {
											this.memorySessionOnly = (
												event.target as HTMLInputElement
											).checked;
											void this.reloadMemorySection();
										}}
									/>
									${" "}Show current session only
								</label>
							`
							: ""
					}
					${
						this.memoryError
							? html`<div class="panel-feedback error">${this.memoryError}</div>`
							: ""
					}
					${
						this.memoryNotice && !this.memoryError
							? html`<div class="panel-feedback success">${this.memoryNotice}</div>`
							: ""
					}
					<div class="panel-card">
						<div class="panel-card-header">
							<div>
								<div class="panel-card-title">Team memory</div>
								<div class="panel-card-copy">
									Repo-scoped durable notes loaded into prompt context.
								</div>
							</div>
							${
								this.teamMemoryAvailable &&
								this.teamMemoryStatus &&
								!this.teamMemoryStatus.exists
									? html`
										<button
											class="action-btn"
											aria-label=${"Initialize team memory"}
											@click=${() => void this.initTeamMemoryEntrypoint()}
											?disabled=${this.memoryLoading}
										>
											${
												this.memoryPendingAction === "team-init"
													? "Initializing..."
													: "Initialize"
											}
										</button>
									`
									: ""
							}
						</div>
						${
							!this.teamMemoryAvailable || !this.teamMemoryStatus
								? html`<div class="panel-card-copy">
									Team memory is only available inside a git repository.
								</div>`
								: html`
									<div class="panel-card-copy">
										Repo: ${this.teamMemoryStatus.projectName}<br />
										Entrypoint: ${this.teamMemoryStatus.entrypoint}<br />
										Status:
										${
											this.teamMemoryStatus.exists
												? "initialized"
												: "not initialized"
										}<br />
										Files: ${this.teamMemoryStatus.fileCount}
									</div>
									${
										this.teamMemoryStatus.files.length > 0
											? html`<div class="panel-card-copy">
												Files: ${this.teamMemoryStatus.files
													.slice(0, 4)
													.join(", ")}
											</div>`
											: ""
									}
								`
						}
					</div>
					<div class="panel-grid">
						<div class="panel-card">
							<div class="panel-card-title">Save memory</div>
							<div class="control-row">
								<input
									class="field-input"
									type="text"
									.placeholder=${"api-design"}
									.value=${this.memorySaveTopic}
									aria-label=${"Memory topic"}
									@input=${(event: Event) => {
										this.memorySaveTopic = (
											event.target as HTMLInputElement
										).value;
									}}
								/>
							</div>
							<div class="control-row">
								<textarea
									class="field-input"
									style="min-height: 5.5rem;"
									.placeholder=${"Use REST conventions #rest"}
									.value=${this.memorySaveContent}
									aria-label=${"Memory content"}
									@input=${(event: Event) => {
										this.memorySaveContent = (
											event.target as HTMLTextAreaElement
										).value;
									}}
								></textarea>
							</div>
							<button
								class="action-btn memory-save-button"
								@click=${() => void this.saveMemoryEntry()}
								?disabled=${this.memoryLoading}
							>
								${
									this.memoryPendingAction === "save"
										? "Saving..."
										: "Save memory"
								}
							</button>
						</div>

						<div class="panel-card">
							<div class="panel-card-header">
								<div>
									<div class="panel-card-title">Topics</div>
									<div class="panel-card-copy">
										Select a topic or jump back to recent entries.
									</div>
								</div>
								<button
									class="action-btn"
									@click=${() => void this.showRecentMemories()}
									?disabled=${this.memoryLoading}
								>
									Recent
								</button>
							</div>
							${
								this.memoryTopics.length === 0
									? html`<div class="panel-card-copy">
										No topics saved yet.
									</div>`
									: html`${this.memoryTopics.map(
											(topic) => html`
											<button
												class="action-btn"
												aria-label=${`Show memories for topic ${topic.name}`}
												@click=${() => void this.selectMemoryTopic(topic.name)}
												?disabled=${this.memoryLoading}
											>
												${topic.name}
											</button>
											<div class="panel-card-copy">
												${topic.entryCount} ${
													topic.entryCount === 1 ? "entry" : "entries"
												}
												· ${formatMemoryRelativeTime(topic.lastUpdated)}
											</div>
										`,
										)}`
							}
						</div>

						<div class="panel-card">
							<div class="panel-card-title">Search</div>
							<div class="control-row">
								<input
									class="field-input"
									type="text"
									.placeholder=${"Search by topic, content, or tag"}
									.value=${this.memorySearchQuery}
									aria-label=${"Search memories"}
									@input=${(event: Event) => {
										this.memorySearchQuery = (
											event.target as HTMLInputElement
										).value;
									}}
								/>
								<button
									class="action-btn memory-search-button"
									@click=${() => void this.searchMemoryEntries()}
									?disabled=${this.memoryLoading}
								>
									Search
								</button>
							</div>
							<label class="panel-card-copy">
								<input
									type="checkbox"
									.checked=${this.memoryClearConfirmed}
									aria-label=${"Confirm clear all memories"}
									@change=${(event: Event) => {
										this.memoryClearConfirmed = (
											event.target as HTMLInputElement
										).checked;
									}}
								/>
								${" "}Confirm clear all memories
							</label>
							<button
								class="action-btn memory-clear-button"
								@click=${() => void this.clearMemoryEntries()}
								?disabled=${this.memoryLoading || !this.memoryClearConfirmed}
							>
								Clear all memories
							</button>
						</div>
					</div>

					<div class="section" style="margin: 1rem 0 0;">
						<div class="section-header">
							<h3>${viewLabel}${this.memoryLoading ? " · Loading…" : ""}</h3>
						</div>
						<div class="section-content">
							${
								this.memoryEntries.length === 0
									? html`<div class="empty-state">No memories to display.</div>`
									: html`
										<div class="panel-grid">
											${this.memoryEntries.map(
												(entry) => html`
													<div class="panel-card">
														<div class="panel-card-header">
															<div>
																<div class="panel-card-title">${entry.topic}</div>
																<div class="panel-card-copy">
																	${entry.id} · ${formatMemoryRelativeTime(entry.updatedAt)}
																</div>
															</div>
															<button
																class="action-btn"
																aria-label=${`Delete memory ${entry.id}`}
																@click=${() => void this.deleteMemoryEntry(entry)}
																?disabled=${this.memoryLoading}
															>
																Delete
															</button>
														</div>
														<div class="panel-card-copy">
															${truncateMemoryText(entry.content, 240)}
														</div>
														${
															entry.tags && entry.tags.length > 0
																? html`<div class="panel-card-copy">
																	Tags: ${entry.tags.join(", ")}
																</div>`
																: ""
														}
													</div>
												`,
											)}
										</div>
									`
							}
						</div>
					</div>
				</div>
			</div>
		`;
	}

	private renderMcpSection() {
		return renderComposerSettingsMcpSection(this);
	}

	private renderModelsTab() {
		if (this.models.length === 0) {
			return html`<div class="empty-state">No models available</div>`;
		}

		// Group by provider
		const byProvider = new Map<string, Model[]>();
		for (const model of this.models) {
			if (!byProvider.has(model.provider)) {
				byProvider.set(model.provider, []);
			}
			byProvider.get(model.provider)?.push(model);
		}

		return html`
			${[...byProvider.entries()].map(
				([provider, models]) => html`
				<div class="section">
					<div class="section-header">
						<h3>${provider.toUpperCase()} (${models.length})</h3>
					</div>
					<div class="section-content">
						<div class="model-grid">
							${models.map((model) => {
								const isSelected =
									this.currentModel === `${model.provider}/${model.id}`;
								return html`
									<div
										class="model-card ${isSelected ? "selected" : ""}"
										@click=${() => this.selectModel(model)}
									>
										<div class="model-name">${model.name}</div>
										<div class="model-provider">${model.provider}</div>
									<div class="info-grid">
										<div class="info-label">Context:</div>
										<div class="info-value">${this.formatTokens(model.contextWindow ?? 0)}</div>

										<div class="info-label">Max Out:</div>
										<div class="info-value">${this.formatTokens(model.maxTokens ?? model.maxOutputTokens ?? 0)}</div>

										<div class="info-label">Cost/1M:</div>
										<div class="info-value">
											In: ${this.formatCost(model.cost?.input ?? 0)} / Out: ${this.formatCost(model.cost?.output ?? 0)}
										</div>

										${
											model.cost?.cacheRead !== undefined ||
											model.cost?.cacheWrite !== undefined
												? html`
											<div class="info-label">Cache:</div>
											<div class="info-value">${this.formatCost(model.cost?.cacheRead ?? 0)} read / ${this.formatCost(model.cost?.cacheWrite ?? 0)} write</div>
										`
												: ""
										}

										${
											model.api
												? html`
											<div class="info-label">API:</div>
											<div class="info-value">${model.api}</div>
										`
												: ""
										}
									</div>
										<div class="model-stats">
											${model.capabilities?.vision ? html`<span class="badge active">Vision</span>` : ""}
											${model.capabilities?.reasoning ? html`<span class="badge active">Reasoning</span>` : ""}
											${model.capabilities?.tools ? html`<span class="badge active">Tools</span>` : ""}
										</div>
									</div>
								`;
							})}
						</div>
					</div>
				</div>
			`,
			)}
		`;
	}

	private renderUsageTab() {
		if (!this.usage) {
			return html`<div class="empty-state">No usage data available</div>`;
		}

		const totals = this.usage.totalTokensDetailed ||
			this.usage.totalTokensBreakdown || {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: this.usage.totalTokens || 0,
			};
		const cachedTotal = totals.cacheRead + totals.cacheWrite;
		const totalRequests = this.usage.totalRequests ?? 0;

		return html`
			<div class="usage-stats">
				<div class="stat-card">
					<div class="stat-value">${this.formatCost(this.usage.totalCost)}</div>
					<div class="stat-label">Total Cost</div>
				</div>
				<div class="stat-card">
					<div class="stat-value">${this.formatTokens(totals.input + totals.output)}</div>
					<div class="stat-label">Tokens (In + Out)</div>
				</div>
				<div class="stat-card">
					<div class="stat-value">${this.formatTokens(cachedTotal)}</div>
					<div class="stat-label">Cached Tokens</div>
				</div>
				<div class="stat-card">
					<div class="stat-value">${totalRequests}</div>
					<div class="stat-label">Requests</div>
				</div>
			</div>

			${
				Object.keys(this.usage.byProvider).length > 0
					? html`
				<div class="section">
					<div class="section-header">
						<h3>By Provider</h3>
					</div>
					<div class="section-content">
						<div class="info-grid">
							${Object.entries(this.usage.byProvider).map(
								([provider, stats]) => html`
								<div class="info-label">${provider}:</div>
								<div class="info-value">
									${this.formatCost(stats.cost)} (${stats.calls ?? stats.requests ?? 0} calls, ${this.formatTokens((stats.tokensDetailed?.total ?? stats.tokens) || 0)} tok)
								</div>
							`,
							)}
						</div>
					</div>
				</div>
			`
					: ""
			}

				${
					Object.keys(this.usage.byModel).length > 0
						? html`
					<div class="section">
						<div class="section-header">
							<h3>By Model</h3>
					</div>
						<div class="section-content">
							<div class="info-grid">
								${Object.entries(this.usage.byModel).map(
									([model, stats]) => html`
									<div class="info-label">${model}:</div>
									<div class="info-value">
										${this.formatCost(stats.cost)} (${stats.calls ?? stats.requests ?? 0} calls, ${this.formatTokens((stats.tokensDetailed?.total ?? stats.tokens) || 0)} tok)
									</div>
								`,
								)}
						</div>
					</div>
				</div>
			`
						: ""
				}
		`;
	}

	override render() {
		return html`
			<div class="settings-header">
				<h2>⚙ Settings</h2>
				<button class="close-btn" @click=${this.close}>✕</button>
			</div>

			${this.error ? html`<div class="error-message">${this.error}</div>` : ""}

			<div class="settings-content">
				${
					this.loading
						? html`<div class="loading">Loading settings...</div>`
						: html`
						${this.renderWorkspaceTab()}
						${this.renderModelsTab()}
						${this.renderUsageTab()}
					`
				}
			</div>
		`;
	}
}
