/**
 * Settings panel component - comprehensive configuration interface
 */

import {
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
	getMcpRegistryEntryId,
	getMcpRegistryUrlOptions,
	getWritableMcpScope,
	parseMcpArgsText,
	parseMcpKeyValueText,
	parseMcpTimeoutText,
} from "@evalops/contracts";
import type {
	MemoryEntry,
	MemoryStats,
	MemoryTopicSummary,
} from "@evalops/contracts";
import { LitElement, css, html } from "lit";
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
	UsageSummary,
	WorkspaceStatus,
} from "../services/api-client.js";

type MemoryView =
	| { kind: "recent" }
	| { kind: "topic"; topic: string }
	| { kind: "search"; query: string };

const EMPTY_MEMORY_STATS: MemoryStats = {
	totalEntries: 0,
	topics: 0,
	oldestEntry: null,
	newestEntry: null,
};

@customElement("composer-settings")
export class ComposerSettings extends LitElement {
	static override styles = css`
		:host {
			display: flex;
			flex-direction: column;
			height: 100%;
			background: var(--bg-primary);
			color: var(--text-primary);
			font-family: var(--font-sans);
		}

		.settings-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 1.25rem 1.5rem;
			border-bottom: 1px solid var(--border-primary);
			background: var(--bg-primary);
		}

		.settings-header h2 {
			font-size: 0.9rem;
			font-weight: 600;
			margin: 0;
			color: var(--text-primary);
			letter-spacing: -0.01em;
		}

		.close-btn {
			width: 28px;
			height: 28px;
			padding: 0;
			background: transparent;
			border: 1px solid var(--border-primary);
			border-radius: 6px;
			color: var(--text-secondary);
			cursor: pointer;
			transition: all 0.2s;
			font-size: 0.9rem;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.close-btn:hover {
			background: var(--bg-panel);
			color: var(--text-primary);
			border-color: var(--border-secondary);
		}

		.settings-content {
			flex: 1;
			overflow-y: auto;
			padding: 1.5rem;
		}

		.section {
			margin-bottom: 2rem;
			background: var(--bg-secondary);
			border: 1px solid var(--border-primary);
			border-radius: 8px;
			overflow: hidden;
		}

		.section-header {
			padding: 0.75rem 1rem;
			background: var(--bg-panel);
			border-bottom: 1px solid var(--border-primary);
		}

		.section-header h3 {
			font-family: var(--font-mono);
			font-size: 0.7rem;
			font-weight: 600;
			margin: 0;
			color: var(--text-secondary);
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.section-content {
			padding: 1rem;
		}

		.info-grid {
			display: grid;
			grid-template-columns: auto 1fr;
			gap: 0.75rem 1.5rem;
			font-size: 0.8rem;
			line-height: 1.6;
		}

		.info-label {
			font-family: var(--font-mono);
			color: var(--text-tertiary);
			font-size: 0.7rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			padding-top: 0.15em;
		}

		.info-value {
			color: var(--text-primary);
			word-break: break-all;
			font-family: var(--font-mono);
		}

		.info-value.highlight {
			color: var(--accent-blue);
		}

		.info-value.success {
			color: var(--accent-green);
		}

		.info-value.warning {
			color: var(--accent-yellow);
		}

		.info-value.error {
			color: var(--accent-red);
		}

		.badge {
			display: inline-block;
			padding: 0.15rem 0.4rem;
			background: var(--bg-panel);
			border: 1px solid var(--border-primary);
			border-radius: 4px;
			font-size: 0.65rem;
			font-weight: 600;
			color: var(--text-secondary);
			text-transform: uppercase;
			margin-right: 0.35rem;
			font-family: var(--font-mono);
		}

		.badge.active {
			background: var(--accent-blue-dim);
			color: var(--accent-blue);
			border-color: transparent;
		}

		.badge.success {
			background: rgba(16, 185, 129, 0.1);
			color: var(--accent-green);
			border-color: transparent;
		}

		.badge.error {
			background: rgba(239, 68, 68, 0.1);
			color: var(--accent-red);
			border-color: transparent;
		}

		.model-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
			gap: 1rem;
		}

		.model-card {
			background: var(--bg-primary);
			border: 1px solid var(--border-primary);
			border-radius: 6px;
			padding: 1rem;
			transition: all 0.2s;
			cursor: pointer;
		}

		.model-card:hover {
			border-color: var(--accent-blue);
			transform: translateY(-1px);
			box-shadow: var(--shadow-sm);
		}

		.model-card.selected {
			border-color: var(--accent-blue);
			background: var(--accent-blue-dim);
		}

		.model-name {
			font-size: 0.9rem;
			font-weight: 600;
			color: var(--text-primary);
			margin-bottom: 0.25rem;
			font-family: var(--font-sans);
		}

		.model-provider {
			font-size: 0.7rem;
			color: var(--text-tertiary);
			text-transform: uppercase;
			letter-spacing: 0.05em;
			margin-bottom: 0.75rem;
			font-family: var(--font-mono);
		}

		.model-stats {
			display: flex;
			flex-wrap: wrap;
			gap: 0.35rem;
			margin-top: 0.75rem;
		}

		.usage-stats {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
			gap: 1rem;
			margin-bottom: 1.5rem;
		}

		.stat-card {
			background: var(--bg-secondary);
			border: 1px solid var(--border-primary);
			border-radius: 8px;
			padding: 1rem;
			text-align: center;
		}

		.stat-value {
			font-size: 1.5rem;
			font-weight: 700;
			color: var(--text-primary);
			margin-bottom: 0.35rem;
			font-family: var(--font-mono);
			letter-spacing: -0.03em;
		}

		.stat-label {
			font-size: 0.7rem;
			color: var(--text-secondary);
			text-transform: uppercase;
			letter-spacing: 0.05em;
			font-family: var(--font-mono);
		}

		.empty-state {
			text-align: center;
			padding: 3rem 1rem;
			color: var(--text-tertiary);
			font-size: 0.8rem;
			font-family: var(--font-mono);
		}

		.loading {
			text-align: center;
			padding: 3rem 1rem;
			color: var(--text-tertiary);
			font-size: 0.8rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			font-family: var(--font-mono);
		}

		.error-message {
			background: rgba(239, 68, 68, 0.1);
			border-left: 3px solid var(--accent-red);
			padding: 0.75rem 1rem;
			margin-bottom: 1rem;
			font-size: 0.8rem;
			color: var(--accent-red);
			line-height: 1.5;
			font-family: var(--font-mono);
		}

		.control-row {
			display: flex;
			flex-wrap: wrap;
			gap: 0.75rem;
			align-items: center;
			margin-bottom: 0.75rem;
		}

		.field-input,
		.field-select {
			background: var(--bg-primary);
			border: 1px solid var(--border-primary);
			border-radius: 6px;
			padding: 0.65rem 0.75rem;
			color: var(--text-primary);
			font-size: 0.78rem;
			font-family: var(--font-mono);
		}

		.field-input {
			flex: 1 1 240px;
		}

		.field-select {
			min-width: 140px;
		}

		.action-btn {
			background: var(--bg-panel);
			border: 1px solid var(--border-primary);
			border-radius: 6px;
			padding: 0.65rem 0.85rem;
			color: var(--text-secondary);
			font-size: 0.72rem;
			font-family: var(--font-mono);
			text-transform: uppercase;
			letter-spacing: 0.05em;
			cursor: pointer;
			transition: all 0.2s;
		}

		.action-btn:hover {
			color: var(--text-primary);
			border-color: var(--border-secondary);
			transform: translateY(-1px);
		}

		.action-btn:disabled {
			opacity: 0.6;
			cursor: not-allowed;
			transform: none;
		}

		.panel-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
			gap: 0.75rem;
		}

		.panel-card {
			background: var(--bg-primary);
			border: 1px solid var(--border-primary);
			border-radius: 8px;
			padding: 0.9rem;
			display: flex;
			flex-direction: column;
			gap: 0.6rem;
		}

		.panel-card-header {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 0.75rem;
		}

		.panel-card-title {
			font-size: 0.84rem;
			font-weight: 600;
			color: var(--text-primary);
		}

		.panel-card-copy {
			font-size: 0.75rem;
			color: var(--text-secondary);
			line-height: 1.55;
		}

		.panel-badges {
			display: flex;
			flex-wrap: wrap;
			gap: 0.35rem;
		}

		.panel-link-row {
			display: flex;
			flex-wrap: wrap;
			gap: 0.85rem;
			font-size: 0.72rem;
			font-family: var(--font-mono);
		}

		.panel-link-row a {
			color: var(--accent-blue);
			text-decoration: none;
		}

		.panel-link-row a:hover {
			text-decoration: underline;
		}

		.panel-feedback {
			border-radius: 8px;
			padding: 0.75rem 0.9rem;
			font-size: 0.75rem;
			font-family: var(--font-mono);
			line-height: 1.5;
		}

		.panel-feedback.error {
			background: rgba(239, 68, 68, 0.1);
			border: 1px solid rgba(239, 68, 68, 0.3);
			color: var(--accent-red);
		}

		.panel-feedback.success {
			background: rgba(16, 185, 129, 0.1);
			border: 1px solid rgba(16, 185, 129, 0.3);
			color: var(--accent-green);
		}

		.panel-code-block {
			margin: 0;
			padding: 0.75rem 0.9rem;
			border-radius: 8px;
			border: 1px solid var(--border-primary);
			background: var(--bg-panel);
			font-size: 0.72rem;
			font-family: var(--font-mono);
			line-height: 1.55;
			color: var(--text-secondary);
			white-space: pre-wrap;
			word-break: break-word;
		}

		@media (max-width: 768px) {
			.model-grid {
				grid-template-columns: 1fr;
			}

			.usage-stats {
				grid-template-columns: 1fr;
			}

			.control-row {
				flex-direction: column;
				align-items: stretch;
			}
		}
	`;

	@property({ attribute: false }) apiClient!: ApiClient;
	@property({ type: String }) currentModel = "";
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
	@state() private memoryLoading = false;
	@state() private memoryError: string | null = null;
	@state() private memoryNotice: string | null = null;
	@state() private selectedTab: "workspace" | "models" | "usage" = "workspace";

	override async connectedCallback() {
		super.connectedCallback();
		await this.loadData();
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
			] = await Promise.allSettled([
				this.apiClient.getMcpStatus(),
				this.apiClient.searchMcpRegistry(""),
				this.apiClient.listMemoryTopics(),
				this.apiClient.getMemoryStats(),
				this.apiClient.getRecentMemories(12),
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

	private formatMcpScopeLabel(
		scope: McpRegistryImportRequest["scope"],
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

	private formatMemoryRelativeTime(
		timestamp: number | null | undefined,
	): string {
		if (!timestamp) return "Never";
		const diff = Date.now() - timestamp;
		if (diff < 60_000) return "just now";
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return `${Math.floor(diff / 86_400_000)}d ago`;
	}

	private truncateMemoryText(text: string, maxLength: number): string {
		if (text.length <= maxLength) return text;
		return `${text.slice(0, maxLength - 3)}...`;
	}

	private extractMemoryTags(content: string): string[] {
		return Array.from(
			new Set((content.match(/#(\w+)/g) ?? []).map((tag) => tag.slice(1))),
		);
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
			this.apiClient.listMemoryTopics(),
			this.apiClient.getMemoryStats(),
		]);
		this.memoryTopics = topicsResponse.topics ?? [];
		this.memoryStats = statsResponse.stats ?? EMPTY_MEMORY_STATS;
	}

	private async loadMemoryView(view: MemoryView) {
		if (view.kind === "topic") {
			const response = await this.apiClient.listMemoryTopic(view.topic);
			this.memoryEntries = response.memories ?? [];
			return;
		}
		if (view.kind === "search") {
			const response = await this.apiClient.searchMemory(view.query, 12);
			this.memoryEntries = (response.results ?? []).map(
				(result) => result.entry,
			);
			return;
		}
		const response = await this.apiClient.getRecentMemories(12);
		this.memoryEntries = response.memories ?? [];
	}

	private async runMemoryAction(action: () => Promise<void>) {
		this.memoryLoading = true;
		this.memoryError = null;
		this.memoryNotice = null;
		try {
			await action();
		} catch (error) {
			this.memoryError =
				error instanceof Error ? error.message : "Memory action failed";
		} finally {
			this.memoryLoading = false;
		}
	}

	private async showRecentMemories() {
		const nextView: MemoryView = { kind: "recent" };
		await this.runMemoryAction(async () => {
			this.memoryActiveView = nextView;
			await this.loadMemoryView(nextView);
		});
	}

	private async selectMemoryTopic(topic: string) {
		const nextView: MemoryView = { kind: "topic", topic };
		await this.runMemoryAction(async () => {
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
		await this.runMemoryAction(async () => {
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

		await this.runMemoryAction(async () => {
			const tags = this.extractMemoryTags(content);
			const result = await this.apiClient.saveMemory(
				topic,
				content,
				tags.length > 0 ? tags : undefined,
			);
			const savedTopic = result.entry?.topic ?? topic.toLowerCase();
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
		await this.runMemoryAction(async () => {
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

		await this.runMemoryAction(async () => {
			const result = await this.apiClient.clearMemory(true);
			this.memoryNotice = result.message || "Cleared all memories";
			this.memoryClearConfirmed = false;
			this.memoryActiveView = { kind: "recent" };
			this.memoryEntries = [];
			await this.refreshMemorySummary();
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

			${this.renderMcpSection()} ${this.renderMemorySection()}
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
							<div class="info-value">Cross-session memory</div>
							<div class="info-label">
								Slash command: /memory
							</div>
						</div>
						<div class="panel-card-copy">
							Entries: ${this.memoryStats.totalEntries}<br />
							Topics: ${this.memoryStats.topics}<br />
							Newest: ${this.formatMemoryRelativeTime(
								this.memoryStats.newestEntry,
							)}
						</div>
					</div>
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
								${this.memoryLoading ? "Saving..." : "Save memory"}
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
												· ${this.formatMemoryRelativeTime(topic.lastUpdated)}
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
																	${entry.id} · ${this.formatMemoryRelativeTime(
																		entry.updatedAt,
																	)}
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
															${this.truncateMemoryText(entry.content, 240)}
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
		const servers = this.mcpStatus?.servers ?? [];
		const authPresets = this.getAvailableAuthPresets();

		return html`
			<div class="section">
				<div class="section-header">
					<h3>MCP</h3>
				</div>
				<div class="section-content">
					<div class="control-row">
						<div>
							<div class="info-value">Auth Presets</div>
							<div class="info-label">
								Reusable hidden headers/helpers for remote MCP servers
							</div>
						</div>
					</div>
					${
						authPresets.length > 0
							? html`
								<div class="panel-grid" style="margin-bottom: 1rem;">
										${authPresets.map((preset) => {
											const writableScope = this.getWritableMcpScope(
												preset.scope,
											);
											const replaceHiddenHeaderValues =
												this.mcpEditingReplaceAuthPresetHeaders[preset.name] ===
												true;
											const canEditHeaderValues =
												(preset.headerKeys?.length ?? 0) === 0 ||
												replaceHiddenHeaderValues;
											const editableHeadersText =
												this.mcpEditingAuthPresetHeadersTexts[preset.name] ??
												"";
											const editableHeadersHelper =
												this.mcpEditingAuthPresetHeadersHelpers[preset.name] ??
												preset.headersHelper ??
												"";
											return html`
											<div class="panel-card">
												<div class="panel-card-header">
													<div>
														<div class="panel-card-title">${preset.name}</div>
														<div class="panel-card-copy">
															${preset.scope ? this.formatMcpScopeLabel(preset.scope) : "Merged config"}
														</div>
													</div>
													${
														writableScope
															? html`<button
																	class="action-btn mcp-auth-preset-remove-button"
																	@click=${() =>
																		void this.removeMcpAuthPreset(
																			preset.name,
																			writableScope,
																		)}
																	?disabled=${this.mcpRemovingAuthPresetName === preset.name}
																>
																	${
																		this.mcpRemovingAuthPresetName ===
																		preset.name
																			? "Removing..."
																			: "Remove"
																	}
																</button>`
															: ""
													}
												</div>
												<div class="panel-card-copy">
													${preset.headersHelper ? html`Headers helper: ${preset.headersHelper}<br />` : ""}
													${
														preset.headerKeys.length > 0
															? html`Header keys: ${preset.headerKeys.join(", ")}`
															: html`No static headers configured.`
													}
												</div>
												${
													writableScope
														? html`
															<div class="control-row">
																<input
																	class="field-input"
																	type="text"
																	.placeholder=${"Headers helper (optional)"}
																	.value=${editableHeadersHelper}
																	aria-label=${`Headers helper for auth preset ${preset.name}`}
																	@input=${(event: Event) => {
																		this.mcpEditingAuthPresetHeadersHelpers = {
																			...this
																				.mcpEditingAuthPresetHeadersHelpers,
																			[preset.name]: (
																				event.target as HTMLInputElement
																			).value,
																		};
																	}}
																/>
																<button
																	class="action-btn mcp-auth-preset-save-button"
																	@click=${() =>
																		void this.updateMcpAuthPreset(
																			preset,
																			writableScope,
																		)}
																	?disabled=${this.mcpUpdatingAuthPresetName === preset.name}
																>
																	${
																		this.mcpUpdatingAuthPresetName ===
																		preset.name
																			? "Saving..."
																			: "Save"
																	}
																</button>
																</div>
																<div class="control-row">
																	${
																		(preset.headerKeys?.length ?? 0) > 0
																			? html`
																				<label class="panel-card-copy">
																					<input
																						type="checkbox"
																						.checked=${replaceHiddenHeaderValues}
																						aria-label=${`Replace hidden headers for auth preset ${preset.name}`}
																						@change=${(event: Event) => {
																							const checked = (
																								event.target as HTMLInputElement
																							).checked;
																							this.mcpEditingReplaceAuthPresetHeaders =
																								checked
																									? {
																											...this
																												.mcpEditingReplaceAuthPresetHeaders,
																											[preset.name]: true,
																										}
																									: Object.fromEntries(
																											Object.entries(
																												this
																													.mcpEditingReplaceAuthPresetHeaders,
																											).filter(
																												([key]) =>
																													key !== preset.name,
																											),
																										);
																							if (!checked) {
																								this.mcpEditingAuthPresetHeadersTexts =
																									Object.fromEntries(
																										Object.entries(
																											this
																												.mcpEditingAuthPresetHeadersTexts,
																										).filter(
																											([key]) =>
																												key !== preset.name,
																										),
																									);
																							}
																						}}
																					/>
																					${" "}Replace hidden header values
																				</label>
																			`
																			: ""
																	}
																</div>
																<div class="control-row">
																	<textarea
																		class="field-input"
																		style="min-height: 5.5rem;"
																		.placeholder=${"Headers (KEY=VALUE, one per line)"}
																		.value=${editableHeadersText}
																		?disabled=${!canEditHeaderValues}
																		aria-label=${`Headers for auth preset ${preset.name}`}
																		@input=${(event: Event) => {
																			this.mcpEditingAuthPresetHeadersTexts = {
																				...this
																					.mcpEditingAuthPresetHeadersTexts,
																				[preset.name]: (
																					event.target as HTMLTextAreaElement
																				).value,
																			};
																		}}
																	></textarea>
																</div>
																<div class="panel-card-copy">
																	Header values stay hidden. ${
																		(preset.headerKeys?.length ?? 0) > 0 &&
																		!replaceHiddenHeaderValues
																			? 'Enable "Replace hidden header values" to edit them.'
																			: "Enter KEY=VALUE lines to replace them. Leave the field blank and save to clear them."
																	} Current keys: ${
																		preset.headerKeys.length > 0
																			? preset.headerKeys.join(", ")
																			: "none"
																	}.
															</div>
														`
														: ""
												}
											</div>
										`;
										})}
								</div>
							`
							: html`<div class="empty-state">No MCP auth presets configured</div>`
					}
					<div class="section" style="margin: 1rem 0;">
						<div class="section-header">
							<h3>New Auth Preset</h3>
						</div>
						<div class="section-content">
							<div class="panel-card-copy">
								Create a reusable remote auth preset with hidden header values or
								a headers helper command.
							</div>
							<div class="control-row" style="margin-top: 0.75rem;">
								<input
									class="field-input"
									type="text"
									.placeholder=${"Preset name"}
									.value=${this.mcpAuthPresetName}
									aria-label=${"MCP auth preset name"}
									@input=${(event: Event) => {
										this.mcpAuthPresetName = (
											event.target as HTMLInputElement
										).value;
									}}
								/>
								<input
									class="field-input"
									type="text"
									.placeholder=${"Headers helper (optional)"}
									.value=${this.mcpAuthPresetHeadersHelper}
									aria-label=${"MCP auth preset headers helper"}
									@input=${(event: Event) => {
										this.mcpAuthPresetHeadersHelper = (
											event.target as HTMLInputElement
										).value;
									}}
								/>
							</div>
							<div class="control-row">
								<textarea
									class="field-input"
									style="min-height: 5.5rem;"
									.placeholder=${"Headers (KEY=VALUE, one per line)"}
									.value=${this.mcpAuthPresetHeadersText}
									aria-label=${"MCP auth preset headers"}
									@input=${(event: Event) => {
										this.mcpAuthPresetHeadersText = (
											event.target as HTMLTextAreaElement
										).value;
									}}
								></textarea>
							</div>
							<div class="control-row">
								<select
									class="field-select"
									.value=${this.mcpAuthPresetScope}
									aria-label=${"MCP auth preset scope"}
									@change=${(event: Event) => {
										this.mcpAuthPresetScope = (
											event.target as HTMLSelectElement
										).value as McpRegistryImportRequest["scope"];
									}}
								>
									<option value="local">Local config</option>
									<option value="project">Project config</option>
									<option value="user">User config</option>
								</select>
								<button
									class="action-btn mcp-auth-preset-add-button"
									@click=${() => void this.addMcpAuthPreset()}
									?disabled=${
										this.mcpAuthPresetSubmitting ||
										this.mcpAuthPresetName.trim().length === 0 ||
										(this.mcpAuthPresetHeadersHelper.trim().length === 0 &&
											this.mcpAuthPresetHeadersText.trim().length === 0)
									}
								>
									${this.mcpAuthPresetSubmitting ? "Adding..." : "Add Preset"}
								</button>
							</div>
						</div>
					</div>
					<div class="control-row">
						<div>
							<div class="info-value">Configured Servers</div>
							<div class="info-label">Slash command: /mcp</div>
						</div>
					</div>
					${
						servers.length > 0
							? html`
								<div class="panel-grid">
									${servers.map((server) => {
										const writableScope = this.getWritableMcpScope(
											server.scope,
										);
										const replaceHiddenEnvValues =
											this.mcpEditingReplaceEnv[server.name] === true;
										const replaceHiddenHeaderValues =
											this.mcpEditingReplaceHeaders[server.name] === true;
										const canEditEnvValues =
											(server.envKeys?.length ?? 0) === 0 ||
											replaceHiddenEnvValues;
										const canEditHeaderValues =
											(server.headerKeys?.length ?? 0) === 0 ||
											replaceHiddenHeaderValues;
										const editableTransport =
											this.mcpEditingTransports[server.name] ??
											(server.transport === "stdio"
												? "stdio"
												: server.transport === "sse"
													? "sse"
													: "http");
										const editableUrl =
											this.mcpEditingUrls[server.name] ??
											server.remoteUrl ??
											"";
										const editableCommand =
											this.mcpEditingCommands[server.name] ??
											server.command ??
											"";
										const editableArgsText =
											this.mcpEditingArgsText[server.name] ??
											this.formatMcpArgsText(server.args);
										const editableCwd =
											this.mcpEditingCwds[server.name] ?? server.cwd ?? "";
										const editableEnvText =
											this.mcpEditingEnvTexts[server.name] ?? "";
										const editableHeadersHelper =
											this.mcpEditingHeadersHelpers[server.name] ??
											server.headersHelper ??
											"";
										const editableAuthPreset =
											this.mcpEditingAuthPresets[server.name] ??
											server.authPreset ??
											"";
										const editableHeadersText =
											this.mcpEditingHeadersTexts[server.name] ?? "";
										const editableTimeout =
											this.mcpEditingTimeouts[server.name] ??
											this.formatMcpTimeoutText(server.timeout);
										const selectedResource =
											this.mcpSelectedResources[server.name] ??
											server.resources?.[0] ??
											"";
										const selectedPrompt =
											this.mcpSelectedPrompts[server.name] ??
											server.prompts?.[0] ??
											"";
										const selectedPromptDetail =
											server.promptDetails?.find(
												(prompt) => prompt.name === selectedPrompt,
											) ?? null;
										const promptArgsText =
											this.mcpPromptArgsText[server.name] ?? "";
										const resourceOutput =
											this.mcpResourceOutputs[server.name] ?? "";
										const promptOutput =
											this.mcpPromptOutputs[server.name] ?? "";
										const resourceError =
											this.mcpResourceErrors[server.name] ?? null;
										const promptError =
											this.mcpPromptErrors[server.name] ?? null;
										return html`
											<div class="panel-card">
												<div class="panel-card-header">
													<div>
														<div class="panel-card-title">${server.name}</div>
														<div class="panel-card-copy">
															${server.connected ? "Connected" : "Offline"}
														</div>
													</div>
													${
														writableScope
															? html`<button
																	class="action-btn mcp-remove-button"
																	@click=${() =>
																		void this.removeMcpServer(
																			server.name,
																			writableScope,
																		)}
																	?disabled=${this.mcpRemovingName === server.name}
																>
																	${
																		this.mcpRemovingName === server.name
																			? "Removing..."
																			: "Remove"
																	}
																</button>`
															: ""
													}
												</div>
												<div class="panel-badges">
													${
														server.scope
															? html`<span class="badge">${server.scope}</span>`
															: ""
													}
													${
														this.formatMcpTransportLabel(server.transport)
															? html`<span class="badge active">${this.formatMcpTransportLabel(server.transport)}</span>`
															: ""
													}
													${
														this.formatMcpTrustLabel(server.remoteTrust)
															? html`<span class="badge">${this.formatMcpTrustLabel(server.remoteTrust)}</span>`
															: ""
													}
												</div>
												${
													server.remoteHost || server.remoteUrl
														? html`
															<div class="panel-card-copy">
																${server.remoteHost ? html`Host: ${server.remoteHost}<br />` : ""}
																${server.remoteUrl ? html`URL: ${server.remoteUrl}` : ""}
															</div>
														`
														: ""
												}
												${
													server.command ||
													server.cwd ||
													(server.args?.length ?? 0) > 0
														? html`
															<div class="panel-card-copy">
																${server.command ? html`Command: ${server.command}<br />` : ""}
																${
																	(server.args?.length ?? 0) > 0
																		? html`Args: ${(server.args ?? []).join(" ")}<br />`
																		: ""
																}
																${server.cwd ? html`CWD: ${server.cwd}` : ""}
															</div>
														`
														: ""
												}
												${
													server.timeout ||
													server.headersHelper ||
													server.authPreset ||
													(server.envKeys?.length ?? 0) > 0 ||
													(server.headerKeys?.length ?? 0) > 0
														? html`
															<div class="panel-card-copy">
																${server.timeout ? html`Timeout: ${server.timeout} ms<br />` : ""}
																${server.authPreset ? html`Auth preset: ${server.authPreset}<br />` : ""}
																${server.headersHelper ? html`Headers helper: ${server.headersHelper}<br />` : ""}
																${
																	(server.envKeys?.length ?? 0) > 0
																		? html`Env keys: ${(server.envKeys ?? []).join(", ")}<br />`
																		: ""
																}
																${
																	(server.headerKeys?.length ?? 0) > 0
																		? html`Header keys: ${(server.headerKeys ?? []).join(", ")}`
																		: ""
																}
															</div>
														`
														: ""
												}
												${
													writableScope && server.remoteUrl
														? html`
															<div class="control-row">
																<input
																	class="field-input"
																	type="url"
																	.placeholder=${"https://example.com/mcp"}
																	.value=${editableUrl}
																	aria-label=${`Remote URL for ${server.name}`}
																	@input=${(event: Event) => {
																		this.mcpEditingUrls = {
																			...this.mcpEditingUrls,
																			[server.name]: (
																				event.target as HTMLInputElement
																			).value,
																		};
																	}}
																/>
																<select
																	class="field-select"
																	.value=${editableTransport}
																	aria-label=${`Remote transport for ${server.name}`}
																	@change=${(event: Event) => {
																		this.mcpEditingTransports = {
																			...this.mcpEditingTransports,
																			[server.name]: (
																				event.target as HTMLSelectElement
																			).value as "stdio" | "http" | "sse",
																		};
																	}}
																>
																	<option value="http">HTTP</option>
																	<option value="sse">SSE</option>
																</select>
																<select
																	class="field-select"
																	.value=${editableAuthPreset}
																	aria-label=${`Auth preset for ${server.name}`}
																	@change=${(event: Event) => {
																		this.mcpEditingAuthPresets = {
																			...this.mcpEditingAuthPresets,
																			[server.name]: (
																				event.target as HTMLSelectElement
																			).value,
																		};
																	}}
																>
																	<option value="">No auth preset</option>
																	${authPresets.map(
																		(
																			preset,
																		) => html`<option value=${preset.name}>
																			${preset.name}
																		</option>`,
																	)}
																</select>
																<button
																	class="action-btn mcp-update-button"
																	@click=${() =>
																		void this.updateMcpServer(
																			server,
																			writableScope,
																		)}
																	?disabled=${this.mcpUpdatingName === server.name}
																>
																	${
																		this.mcpUpdatingName === server.name
																			? "Saving..."
																			: "Save"
																	}
																</button>
															</div>
															<div class="control-row">
																<input
																	class="field-input"
																	type="text"
																	.placeholder=${"Headers helper (optional)"}
																	.value=${editableHeadersHelper}
																	aria-label=${`Headers helper for ${server.name}`}
																	@input=${(event: Event) => {
																		this.mcpEditingHeadersHelpers = {
																			...this.mcpEditingHeadersHelpers,
																			[server.name]: (
																				event.target as HTMLInputElement
																			).value,
																		};
																	}}
																/>
																<input
																	class="field-input"
																	type="number"
																	min="1"
																	.placeholder=${"Timeout (ms)"}
																	.value=${editableTimeout}
																	aria-label=${`Timeout for ${server.name}`}
																	@input=${(event: Event) => {
																		this.mcpEditingTimeouts = {
																			...this.mcpEditingTimeouts,
																			[server.name]: (
																				event.target as HTMLInputElement
																			).value,
																		};
																	}}
																/>
															</div>
															<div class="control-row">
																${
																	(server.headerKeys?.length ?? 0) > 0
																		? html`
																			<label class="panel-card-copy">
																				<input
																					type="checkbox"
																					.checked=${replaceHiddenHeaderValues}
																					aria-label=${`Replace hidden headers for ${server.name}`}
																					@change=${(event: Event) => {
																						const checked = (
																							event.target as HTMLInputElement
																						).checked;
																						this.mcpEditingReplaceHeaders =
																							checked
																								? {
																										...this
																											.mcpEditingReplaceHeaders,
																										[server.name]: true,
																									}
																								: Object.fromEntries(
																										Object.entries(
																											this
																												.mcpEditingReplaceHeaders,
																										).filter(
																											([key]) =>
																												key !== server.name,
																										),
																									);
																						if (!checked) {
																							this.mcpEditingHeadersTexts =
																								Object.fromEntries(
																									Object.entries(
																										this.mcpEditingHeadersTexts,
																									).filter(
																										([key]) =>
																											key !== server.name,
																									),
																								);
																						}
																					}}
																				/>
																				${" "}Replace hidden header values
																			</label>
																		`
																		: ""
																}
															</div>
															<div class="control-row">
																<textarea
																	class="field-input"
																	style="min-height: 5.5rem;"
																	.placeholder=${"Headers (KEY=VALUE, one per line)"}
																	.value=${editableHeadersText}
																	?disabled=${!canEditHeaderValues}
																	aria-label=${`Headers for ${server.name}`}
																	@input=${(event: Event) => {
																		this.mcpEditingHeadersTexts = {
																			...this.mcpEditingHeadersTexts,
																			[server.name]: (
																				event.target as HTMLTextAreaElement
																			).value,
																		};
																	}}
																></textarea>
															</div>
															<div class="panel-card-copy">
																${
																	(server.headerKeys?.length ?? 0) > 0
																		? replaceHiddenHeaderValues
																			? html`Header values stay hidden. Enter KEY=VALUE lines to replace them. Leave the field blank and save to clear them. Current keys: ${(server.headerKeys ?? []).join(", ")}.`
																			: html`Header values stay hidden and will be preserved unless you enable replacement. Current keys: ${(server.headerKeys ?? []).join(", ")}.`
																		: html`Enter KEY=VALUE lines to set headers for this server.`
																}
																<br />
																Delete optional values like timeout or headers
																helper, or select "No auth preset", then save to clear
																them.
															</div>
															<div class="panel-card-copy">
																Edits apply to the ${this.formatMcpScopeLabel(
																	writableScope,
																)} config file.
															</div>
														`
														: ""
												}
												${
													writableScope && server.transport === "stdio"
														? html`
															<div class="control-row" style="align-items: stretch;">
																<input
																	class="field-input"
																	type="text"
																	.placeholder=${"Command"}
																	.value=${editableCommand}
																	aria-label=${`Command for ${server.name}`}
																	@input=${(event: Event) => {
																		this.mcpEditingCommands = {
																			...this.mcpEditingCommands,
																			[server.name]: (
																				event.target as HTMLInputElement
																			).value,
																		};
																	}}
																/>
																<textarea
																	class="field-input"
																	style="min-height: 5.5rem;"
																	.placeholder=${"Arguments (one per line)"}
																	.value=${editableArgsText}
																	aria-label=${`Arguments for ${server.name}`}
																	@input=${(event: Event) => {
																		this.mcpEditingArgsText = {
																			...this.mcpEditingArgsText,
																			[server.name]: (
																				event.target as HTMLTextAreaElement
																			).value,
																		};
																	}}
																></textarea>
																<textarea
																	class="field-input"
																	style="min-height: 5.5rem;"
																	.placeholder=${"Env vars (KEY=VALUE, one per line)"}
																	.value=${editableEnvText}
																	?disabled=${!canEditEnvValues}
																	aria-label=${`Environment variables for ${server.name}`}
																	@input=${(event: Event) => {
																		this.mcpEditingEnvTexts = {
																			...this.mcpEditingEnvTexts,
																			[server.name]: (
																				event.target as HTMLTextAreaElement
																			).value,
																		};
																	}}
																></textarea>
																<input
																	class="field-input"
																	type="text"
																	.placeholder=${"Working directory (optional)"}
																	.value=${editableCwd}
																	aria-label=${`Working directory for ${server.name}`}
																	@input=${(event: Event) => {
																		this.mcpEditingCwds = {
																			...this.mcpEditingCwds,
																			[server.name]: (
																				event.target as HTMLInputElement
																			).value,
																		};
																	}}
																/>
																<input
																	class="field-input"
																	type="number"
																	min="1"
																	.placeholder=${"Timeout (ms)"}
																	.value=${editableTimeout}
																	aria-label=${`Timeout for ${server.name}`}
																	@input=${(event: Event) => {
																		this.mcpEditingTimeouts = {
																			...this.mcpEditingTimeouts,
																			[server.name]: (
																				event.target as HTMLInputElement
																			).value,
																		};
																	}}
																/>
																<button
																	class="action-btn mcp-update-button"
																	@click=${() =>
																		void this.updateMcpServer(
																			server,
																			writableScope,
																		)}
																	?disabled=${this.mcpUpdatingName === server.name || editableCommand.trim().length === 0}
																>
																	${
																		this.mcpUpdatingName === server.name
																			? "Saving..."
																			: "Save"
																	}
																</button>
															</div>
															${
																(server.envKeys?.length ?? 0) > 0
																	? html`
																		<div class="control-row">
																			<label class="panel-card-copy">
																				<input
																					type="checkbox"
																					.checked=${replaceHiddenEnvValues}
																					aria-label=${`Replace hidden environment variables for ${server.name}`}
																					@change=${(event: Event) => {
																						const checked = (
																							event.target as HTMLInputElement
																						).checked;
																						this.mcpEditingReplaceEnv = checked
																							? {
																									...this.mcpEditingReplaceEnv,
																									[server.name]: true,
																								}
																							: Object.fromEntries(
																									Object.entries(
																										this.mcpEditingReplaceEnv,
																									).filter(
																										([key]) =>
																											key !== server.name,
																									),
																								);
																						if (!checked) {
																							this.mcpEditingEnvTexts =
																								Object.fromEntries(
																									Object.entries(
																										this.mcpEditingEnvTexts,
																									).filter(
																										([key]) =>
																											key !== server.name,
																									),
																								);
																						}
																					}}
																				/>
																				${" "}Replace hidden environment values
																			</label>
																		</div>
																	`
																	: ""
															}
															<div class="panel-card-copy">
																${
																	(server.envKeys?.length ?? 0) > 0
																		? replaceHiddenEnvValues
																			? html`Env values stay hidden. Enter KEY=VALUE lines to replace them. Leave the field blank and save to clear them. Current keys: ${(server.envKeys ?? []).join(", ")}.`
																			: html`Env values stay hidden and will be preserved unless you enable replacement. Current keys: ${(server.envKeys ?? []).join(", ")}.`
																		: html`Enter KEY=VALUE lines to set environment variables for this server.`
																}
																<br />
																Delete optional values like args, cwd, env vars, or
																timeout, then save, to clear them.
															</div>
															<div class="panel-card-copy">
																Edits apply to the ${this.formatMcpScopeLabel(
																	writableScope,
																)} config file.
															</div>
														`
														: ""
												}
												${
													server.officialRegistry?.displayName
														? html`
															<div class="panel-card-copy">
																Official registry: ${server.officialRegistry.displayName}
																${
																	server.officialRegistry.authorName
																		? html`<br />Author: ${server.officialRegistry.authorName}`
																		: ""
																}
															</div>
															<div class="panel-link-row">
																${
																	server.officialRegistry.directoryUrl
																		? html`<a
																				href=${server.officialRegistry.directoryUrl}
																				target="_blank"
																				rel="noreferrer"
																			>
																				Directory
																			</a>`
																		: ""
																}
																${
																	server.officialRegistry.documentationUrl
																		? html`<a
																				href=${server.officialRegistry.documentationUrl}
																				target="_blank"
																				rel="noreferrer"
																			>
																				Docs
																			</a>`
																		: ""
																}
															</div>
														`
														: ""
												}
												${
													(server.resources?.length ?? 0) > 0
														? html`
															<div class="section" style="margin: 0;">
																<div class="section-header">
																	<h3>Resources</h3>
																</div>
																<div class="section-content">
																	<div class="control-row">
																		<select
																			class="field-select"
																			.value=${selectedResource}
																			aria-label=${`MCP resource for ${server.name}`}
																			@change=${(event: Event) => {
																				this.mcpSelectedResources = {
																					...this.mcpSelectedResources,
																					[server.name]: (
																						event.target as HTMLSelectElement
																					).value,
																				};
																			}}
																		>
																			${(server.resources ?? []).map(
																				(
																					resource,
																				) => html`<option value=${resource}>
																					${resource}
																				</option>`,
																			)}
																		</select>
																		<button
																			class="action-btn"
																			aria-label=${`Read resource for ${server.name}`}
																			@click=${() =>
																				void this.readMcpResource(
																					server,
																					selectedResource,
																				)}
																			?disabled=${this.mcpReadingResourceName === server.name || !selectedResource}
																		>
																			${
																				this.mcpReadingResourceName ===
																				server.name
																					? "Loading..."
																					: "Read Resource"
																			}
																		</button>
																	</div>
																	${
																		resourceError
																			? html`<div class="panel-feedback error">${resourceError}</div>`
																			: ""
																	}
																	${
																		resourceOutput
																			? html`<pre class="panel-code-block">${resourceOutput}</pre>`
																			: ""
																	}
																</div>
															</div>
														`
														: ""
												}
												${
													(server.prompts?.length ?? 0) > 0
														? html`
															<div class="section" style="margin: 0;">
																<div class="section-header">
																	<h3>Prompts</h3>
																</div>
																<div class="section-content">
																	<div class="control-row">
																		<select
																			class="field-select"
																			.value=${selectedPrompt}
																			aria-label=${`MCP prompt for ${server.name}`}
																			@change=${(event: Event) => {
																				this.mcpSelectedPrompts = {
																					...this.mcpSelectedPrompts,
																					[server.name]: (
																						event.target as HTMLSelectElement
																					).value,
																				};
																			}}
																			>
																				${(server.prompts ?? []).map(
																					(prompt) => {
																						const promptDetail =
																							server.promptDetails?.find(
																								(detail) =>
																									detail.name === prompt,
																							);
																						return html`<option value=${prompt}>
																							${promptDetail?.title ?? prompt}
																						</option>`;
																					},
																				)}
																			</select>
																			<button
																			class="action-btn"
																			aria-label=${`Run prompt for ${server.name}`}
																			@click=${() =>
																				void this.getMcpPrompt(
																					server,
																					selectedPrompt,
																				)}
																			?disabled=${this.mcpGettingPromptName === server.name || !selectedPrompt}
																			>
																				${
																					this.mcpGettingPromptName ===
																					server.name
																						? "Running..."
																						: "Run Prompt"
																				}
																			</button>
																		</div>
																		${
																			selectedPromptDetail?.description
																				? html`<div class="panel-card-copy">${selectedPromptDetail.description}</div>`
																				: ""
																		}
																		${
																			(
																				selectedPromptDetail?.arguments
																					?.length ?? 0
																			) > 0
																				? html`
																					<div class="section-content" style="padding: 0;">
																						${(
																							selectedPromptDetail?.arguments ??
																								[]
																						).map((argument) => {
																							const argumentKey =
																								this.getMcpPromptArgumentValueKey(
																									server.name,
																									selectedPrompt,
																									argument.name,
																								);
																							return html`
																									<label class="section" style="margin: 0 0 0.75rem 0;">
																										<div class="section-header">
																											<h3>
																												${argument.name}${
																													argument.required
																														? " (required)"
																														: ""
																												}
																											</h3>
																										</div>
																										<div class="section-content">
																											<input
																												class="field-input"
																												type="text"
																												.placeholder=${
																													argument.description ??
																													argument.name
																												}
																												.value=${
																													this
																														.mcpPromptArgumentValues[
																														argumentKey
																													] ?? ""
																												}
																												aria-label=${`Prompt argument ${argument.name} for ${server.name}`}
																												@input=${(
																													event: Event,
																												) => {
																													this.mcpPromptArgumentValues =
																														{
																															...this
																																.mcpPromptArgumentValues,
																															[argumentKey]: (
																																event.target as HTMLInputElement
																															).value,
																														};
																												}}
																											/>
																											${
																												argument.description
																													? html`<div class="panel-card-copy">${argument.description}</div>`
																													: ""
																											}
																										</div>
																									</label>
																								`;
																						})}
																					</div>
																				`
																				: selectedPromptDetail
																					? ""
																					: html`
																						<div class="control-row">
																							<textarea
																								class="field-input"
																								style="min-height: 5.5rem;"
																								.placeholder=${"Prompt args (KEY=VALUE, one per line)"}
																								.value=${promptArgsText}
																								aria-label=${`Prompt arguments for ${server.name}`}
																								@input=${(event: Event) => {
																									this.mcpPromptArgsText = {
																										...this.mcpPromptArgsText,
																										[server.name]: (
																											event.target as HTMLTextAreaElement
																										).value,
																									};
																								}}
																							></textarea>
																						</div>
																					`
																		}
																		${
																			promptError
																				? html`<div class="panel-feedback error">${promptError}</div>`
																				: ""
																		}
																	${
																		promptOutput
																			? html`<pre class="panel-code-block">${promptOutput}</pre>`
																			: ""
																	}
																</div>
															</div>
														`
														: ""
												}
											</div>
										`;
									})}
								</div>
							`
							: html`<div class="empty-state">No MCP servers configured</div>`
					}
					<div class="section" style="margin: 1rem 0 0;">
						<div class="section-header">
							<h3>Custom Server</h3>
						</div>
						<div class="section-content">
							<div class="panel-card-copy">
								Add a stdio command or arbitrary HTTP/SSE MCP endpoint to local,
								project, or user config.
							</div>
							<div class="control-row" style="margin-top: 0.75rem;">
								<input
									class="field-input"
									type="text"
									.placeholder=${"Server name"}
									.value=${this.mcpCustomName}
									@input=${(event: Event) => {
										this.mcpCustomName = (
											event.target as HTMLInputElement
										).value;
									}}
								/>
								${
									this.mcpCustomTransport === "stdio"
										? html`
											<input
												class="field-input"
												type="text"
												.placeholder=${"Command"}
												.value=${this.mcpCustomCommand}
												aria-label=${"Custom MCP server command"}
												@input=${(event: Event) => {
													this.mcpCustomCommand = (
														event.target as HTMLInputElement
													).value;
												}}
											/>
											<textarea
												class="field-input"
												style="min-height: 5.5rem;"
												.placeholder=${"Arguments (one per line)"}
												.value=${this.mcpCustomArgsText}
												aria-label=${"Custom MCP server arguments"}
												@input=${(event: Event) => {
													this.mcpCustomArgsText = (
														event.target as HTMLTextAreaElement
													).value;
												}}
											></textarea>
											<input
												class="field-input"
												type="text"
												.placeholder=${"Working directory (optional)"}
												.value=${this.mcpCustomCwd}
												aria-label=${"Custom MCP server working directory"}
												@input=${(event: Event) => {
													this.mcpCustomCwd = (
														event.target as HTMLInputElement
													).value;
												}}
											/>
											<textarea
												class="field-input"
												style="min-height: 5.5rem;"
												.placeholder=${"Env vars (KEY=VALUE, one per line)"}
												.value=${this.mcpCustomEnvText}
												aria-label=${"Custom MCP server environment variables"}
												@input=${(event: Event) => {
													this.mcpCustomEnvText = (
														event.target as HTMLTextAreaElement
													).value;
												}}
											></textarea>
										`
										: html`
											<input
												class="field-input"
												type="url"
												.placeholder=${"https://example.com/mcp"}
												.value=${this.mcpCustomUrl}
												@input=${(event: Event) => {
													this.mcpCustomUrl = (
														event.target as HTMLInputElement
													).value;
												}}
											/>
											<input
												class="field-input"
												type="text"
												.placeholder=${"Headers helper (optional)"}
												.value=${this.mcpCustomHeadersHelper}
												aria-label=${"Custom MCP server headers helper"}
												@input=${(event: Event) => {
													this.mcpCustomHeadersHelper = (
														event.target as HTMLInputElement
													).value;
												}}
											/>
											<select
												class="field-select"
												.value=${this.mcpCustomAuthPreset}
												aria-label=${"Custom MCP server auth preset"}
												@change=${(event: Event) => {
													this.mcpCustomAuthPreset = (
														event.target as HTMLSelectElement
													).value;
												}}
											>
												<option value="">No auth preset</option>
												${authPresets.map(
													(preset) => html`<option value=${preset.name}>
														${preset.name}
													</option>`,
												)}
											</select>
											<textarea
												class="field-input"
												style="min-height: 5.5rem;"
												.placeholder=${"Headers (KEY=VALUE, one per line)"}
												.value=${this.mcpCustomHeadersText}
												aria-label=${"Custom MCP server headers"}
												@input=${(event: Event) => {
													this.mcpCustomHeadersText = (
														event.target as HTMLTextAreaElement
													).value;
												}}
											></textarea>
										`
								}
							</div>
							<div class="control-row">
								<select
									class="field-select"
									.value=${this.mcpCustomTransport}
									aria-label=${"Custom MCP server transport"}
									@change=${(event: Event) => {
										this.mcpCustomTransport = (
											event.target as HTMLSelectElement
										).value as "stdio" | "http" | "sse";
									}}
								>
									<option value="stdio">stdio</option>
									<option value="http">HTTP</option>
									<option value="sse">SSE</option>
								</select>
								<select
									class="field-select"
									.value=${this.mcpCustomScope}
									aria-label=${"Custom MCP server scope"}
									@change=${(event: Event) => {
										this.mcpCustomScope = (event.target as HTMLSelectElement)
											.value as McpRegistryImportRequest["scope"];
									}}
								>
									<option value="local">Local config</option>
									<option value="project">Project config</option>
									<option value="user">User config</option>
								</select>
								<input
									class="field-input"
									type="number"
									min="1"
									.placeholder=${"Timeout (ms)"}
									.value=${this.mcpCustomTimeoutText}
									aria-label=${"Custom MCP server timeout"}
									@input=${(event: Event) => {
										this.mcpCustomTimeoutText = (
											event.target as HTMLInputElement
										).value;
									}}
								/>
								<button
									class="action-btn mcp-custom-add-button"
									@click=${() => void this.addCustomMcpServer()}
									?disabled=${
										this.mcpCustomSubmitting ||
										this.mcpCustomName.trim().length === 0 ||
										(this.mcpCustomTransport === "stdio"
											? this.mcpCustomCommand.trim().length === 0
											: this.mcpCustomUrl.trim().length === 0)
									}
								>
									${this.mcpCustomSubmitting ? "Adding..." : "Add Server"}
								</button>
							</div>
							${
								this.mcpManagementError
									? html`<div class="panel-feedback error">${this.mcpManagementError}</div>`
									: ""
							}
							${
								this.mcpManagementNotice
									? html`<div class="panel-feedback success">${this.mcpManagementNotice}</div>`
									: ""
							}
						</div>
					</div>
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Official Registry</h3>
				</div>
				<div class="section-content">
					<div class="control-row">
						<input
							class="field-input mcp-search-input"
							type="text"
							.placeholder=${"Search official MCP registry"}
							.value=${this.mcpRegistryQuery}
							@input=${(event: Event) => {
								this.mcpRegistryQuery = (
									event.target as HTMLInputElement
								).value;
							}}
						/>
						<select
							class="field-select"
							.value=${this.mcpRegistryScope}
							@change=${(event: Event) => {
								this.mcpRegistryScope = (event.target as HTMLSelectElement)
									.value as McpRegistryImportRequest["scope"];
							}}
						>
							<option value="local">Local config</option>
							<option value="project">Project config</option>
							<option value="user">User config</option>
						</select>
						<button
							class="action-btn"
							@click=${() => void this.searchMcpRegistry(this.mcpRegistryQuery)}
							?disabled=${this.mcpRegistryLoading}
						>
							${this.mcpRegistryLoading ? "Searching..." : "Search"}
						</button>
						<button
							class="action-btn"
							@click=${() => {
								this.mcpRegistryQuery = "";
								void this.searchMcpRegistry("");
							}}
							?disabled=${this.mcpRegistryLoading}
						>
							Top Picks
						</button>
					</div>
					<div class="panel-card-copy">
						Imports target the ${this.formatMcpScopeLabel(this.mcpRegistryScope)}
						config by default.
					</div>
					${
						this.mcpRegistryError
							? html`<div class="panel-feedback error">${this.mcpRegistryError}</div>`
							: ""
					}
					${
						this.mcpRegistryNotice
							? html`<div class="panel-feedback success">${this.mcpRegistryNotice}</div>`
							: ""
					}
					${
						this.mcpRegistryEntries.length > 0
							? html`
								<div class="panel-grid">
									${this.mcpRegistryEntries.map((entry, index) => {
										const entryId = this.getMcpRegistryEntryId(entry, index);
										const urlOptions = this.getMcpRegistryUrlOptions(entry);
										const selectedUrl =
											this.mcpRegistrySelectedUrls[entryId] ||
											urlOptions[0]?.url ||
											"";
										const transportLabel = this.formatMcpTransportLabel(
											entry.transport,
										);
										const countBits = [
											typeof entry.toolCount === "number"
												? this.formatCountLabel(
														entry.toolCount,
														"tool",
														"tools",
													)
												: null,
											typeof entry.promptCount === "number"
												? this.formatCountLabel(
														entry.promptCount,
														"prompt",
														"prompts",
													)
												: null,
										].filter((value): value is string => Boolean(value));
										return html`
											<div class="panel-card">
												<div class="panel-card-header">
													<div>
														<div class="panel-card-title">
															${
																entry.displayName ||
																entry.serverName ||
																entry.slug ||
																"Unnamed registry entry"
															}
														</div>
														${
															entry.oneLiner
																? html`<div class="panel-card-copy">${entry.oneLiner}</div>`
																: ""
														}
													</div>
													<button
														class="action-btn mcp-import-button"
														@click=${() => void this.importMcpRegistry(entry, index)}
														?disabled=${Boolean(
															this.mcpImportingId &&
																this.mcpImportingId !== entryId,
														)}
													>
														${
															this.mcpImportingId === entryId
																? "Importing..."
																: "Import"
														}
													</button>
												</div>
												<div class="panel-badges">
													${
														transportLabel
															? html`<span class="badge active">${transportLabel}</span>`
															: ""
													}
													${
														countBits.length > 0
															? html`<span class="badge">${countBits.join(" · ")}</span>`
															: ""
													}
													${
														entry.authorName
															? html`<span class="badge">by ${entry.authorName}</span>`
															: ""
													}
												</div>
												<input
													class="field-input"
													type="text"
													.placeholder=${"Name override (optional)"}
													.value=${this.mcpRegistryNames[entryId] ?? ""}
													@input=${(event: Event) => {
														this.mcpRegistryNames = {
															...this.mcpRegistryNames,
															[entryId]: (event.target as HTMLInputElement)
																.value,
														};
													}}
												/>
												${
													urlOptions.length > 1
														? html`
															<select
																class="field-select"
																.value=${selectedUrl}
																@change=${(event: Event) => {
																	this.mcpRegistrySelectedUrls = {
																		...this.mcpRegistrySelectedUrls,
																		[entryId]: (
																			event.target as HTMLSelectElement
																		).value,
																	};
																}}
															>
																${urlOptions.map(
																	(option) => html`
																		<option value=${option.url}>
																			${option.label}
																		</option>
																	`,
																)}
															</select>
														`
														: html`
															<div class="panel-card-copy">
																${
																	selectedUrl ||
																	"Default endpoint provided by registry"
																}
															</div>
														`
												}
												${
													entry.permissions
														? html`<div class="panel-card-copy">
																Permissions: ${entry.permissions}
															</div>`
														: ""
												}
												${
													entry.directoryUrl || entry.documentationUrl
														? html`
															<div class="panel-link-row">
																${
																	entry.directoryUrl
																		? html`<a
																				href=${entry.directoryUrl}
																				target="_blank"
																				rel="noreferrer"
																			>
																				Directory
																			</a>`
																		: ""
																}
																${
																	entry.documentationUrl
																		? html`<a
																				href=${entry.documentationUrl}
																				target="_blank"
																				rel="noreferrer"
																			>
																				Docs
																			</a>`
																		: ""
																}
															</div>
														`
														: ""
												}
											</div>
										`;
									})}
								</div>
							`
							: html`<div class="empty-state">
									${
										this.mcpRegistryLoading
											? "Loading official MCP registry..."
											: "No official registry matches"
									}
								</div>`
					}
				</div>
			</div>
		`;
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
