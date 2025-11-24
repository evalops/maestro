/**
 * Main chat interface component
 */

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
	ApiClient,
	type Message,
	type Model,
	type Session,
	type SessionSummary,
	type UsageSummary,
	type WorkspaceStatus,
} from "../services/api-client.js";
import { dataStore } from "../services/data-store.js";
import "./composer-message.js";
import "./composer-input.js";
import "./composer-settings.js";
import "./model-selector.js";

const STATUS_CACHE_KEY = "composer_status_cache";
const MODELS_CACHE_KEY = "composer_models_cache";
const USAGE_CACHE_KEY = "composer_usage_cache";
const MODEL_OVERRIDE_KEY = "composer_model_override";

@customElement("composer-chat")
export class ComposerChat extends LitElement {
	static styles = css`
		:host {
			display: flex !important;
			height: 100% !important;
			width: 100% !important;
			background: #0a0e14;
			color: #e6edf3;
			overflow: hidden;
			font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
			--icon-btn-size: 24px;
			--icon-btn-font-size: 0.78rem;
			--icon-btn-border-color: #1f242a;
			--icon-btn-hover: rgba(88, 166, 255, 0.06);
		}

		/* Sidebar - compact, high-density */
		.sidebar {
			width: 260px;
			background: #0d1117;
			border-right: 1px solid #21262d;
			display: flex;
			flex-direction: column;
			transition: transform 0.2s ease;
		}

		.sidebar.collapsed {
			transform: translateX(-100%);
		}

		.sidebar-header {
			padding: 0.75rem;
			border-bottom: 1px solid #21262d;
			background: #161b22;
		}

		.sidebar-header {
			padding: 0.6rem 0.75rem;
			border-bottom: 1px solid #21262d;
			background: #161b22;
			display: flex;
			flex-direction: column;
			gap: 0.35rem;
		}

		.sidebar-header h2 {
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.7rem;
			font-weight: 600;
			margin: 0;
			color: #8b949e;
			text-transform: uppercase;
			letter-spacing: 0.1em;
		}

		.new-session-btn {
			width: 100%;
			padding: 0.5rem 0.75rem;
			background: #21262d;
			color: #e6edf3;
			border: 1px solid #30363d;
			border-radius: 3px;
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.75rem;
			font-weight: 600;
			cursor: pointer;
			transition: all 0.15s;
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 0.5rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.new-session-btn:hover {
			background: #30363d;
			border-color: #58a6ff;
			color: #58a6ff;
		}

		.new-session-btn::before {
			content: "+";
			font-size: 1rem;
		}

		.sessions-list {
			flex: 1;
			overflow-y: auto;
			padding: 0;
		}

			.session-item {
				padding: 0.55rem 0.75rem;
				border-bottom: 1px solid #21262d;
				cursor: pointer;
				transition: all 0.15s;
				background: transparent;
			}

		.session-item:hover {
			background: #161b22;
			border-left: 2px solid #58a6ff;
			padding-left: calc(0.75rem - 2px);
		}

		.session-item.active {
			background: #1c2128;
			border-left: 3px solid #58a6ff;
			padding-left: calc(0.75rem - 3px);
		}

			.session-title {
				font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
				font-size: 0.78rem;
				font-weight: 500;
				margin-bottom: 0.1rem;
				color: #e6edf3;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				pointer-events: none;
		}

		.session-meta {
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.65rem;
			color: #6e7681;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			pointer-events: none;
		}

		/* Main content - instrument panel style */
		.main-content {
			flex: 1;
			display: flex;
			flex-direction: column;
			position: relative;
			min-width: 0; /* Fix flex shrinking issue */
			width: 100%; /* Ensure it takes available space */
		}

		.header {
			display: grid;
			grid-template-columns: auto 1fr auto;
			align-items: center;
			gap: 1rem;
			padding: 0.625rem 1rem;
			background: #0d1117;
			border-bottom: 1px solid #21262d;
			min-height: 44px;
		}

		.header-left {
			display: flex;
			align-items: center;
			gap: 0.4rem;
		}

		.toggle-sidebar-btn {
			width: 28px;
			height: 28px;
			padding: 0;
			background: transparent;
			border: 1px solid #30363d;
			border-radius: 2px;
			color: #8b949e;
			cursor: pointer;
			transition: all 0.15s;
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.7rem;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.toggle-sidebar-btn:hover {
			background: #21262d;
			border-color: #58a6ff;
			color: #58a6ff;
		}

		.header h1 {
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.85rem;
			font-weight: 700;
			margin: 0;
			color: #e6edf3;
			letter-spacing: -0.02em;
			text-transform: uppercase;
		}

		.header h1::before {
			content: "♪ ";
			color: #58a6ff;
			margin-right: 0.35rem;
		}

		.status-bar {
			display: flex;
			align-items: center;
			gap: 0.35rem;
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.7rem;
			color: #6e7681;
		}

		.muted {
			color: #6e7681;
		}

		.status-item {
			display: flex;
			align-items: center;
			gap: 0.25rem;
			padding: 0.2rem 0.45rem;
			background: #0b1016;
			border: 1px solid #252b33;
			border-radius: 4px;
			font-size: 0.64rem;
			letter-spacing: 0.02em;
		}

			.status-item.active {
				border-color: #3a82c2;
				color: #d7e7ff;
				background: rgba(88, 166, 255, 0.05);
			}

		.pill {
			display: inline-flex;
			align-items: center;
			gap: 0.25rem;
			padding: 0.1rem 0.4rem;
			background: #0b1016;
			border: 1px solid #252b33;
			border-radius: 4px;
			color: #e6edf3;
			font-weight: 600;
			font-size: 0.7rem;
			letter-spacing: 0.01em;
		}

		.pill.warning {
			border-color: #d29922;
			color: #d29922;
		}

		.pill.success {
			border-color: #3fb950;
			color: #3fb950;
		}

			.status-dot {
				width: 8px;
				height: 8px;
				border-radius: 2px;
				background: #3fb950;
				animation: pulse 2s ease-in-out infinite;
			}

			.status-dot.offline {
				background: #f85149;
				animation: none;
			}

			.status-dot.warning {
				background: #d29922;
			}

			.status-dot.success {
				background: #3fb950;
			}

		@keyframes pulse {
			0%, 100% { opacity: 1; }
			50% { opacity: 0.4; }
		}

		.header-right {
			display: flex;
			align-items: center;
			gap: 0.4rem;
		}

		.toast {
			position: fixed;
			bottom: 16px;
			right: 16px;
			padding: 0.75rem 1rem;
			border-radius: 6px;
			background: #161b22;
			border: 1px solid #30363d;
			color: #e6edf3;
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.75rem;
			box-shadow: 0 10px 25px rgba(0,0,0,0.4);
			z-index: 300;
			animation: fadeIn 0.2s ease;
		}

		.toast.success { border-color: #3fb950; color: #c2f5cd; }
		.toast.error { border-color: #f85149; color: #fca5a5; }
		.toast.info { border-color: #58a6ff; color: #cde5ff; }

		@keyframes fadeIn {
			from { opacity: 0; transform: translateY(6px); }
			to { opacity: 1; transform: translateY(0); }
		}

		.model-selector {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			padding: 0.35rem 0.625rem;
			background: #161b22;
			border: 1px solid #30363d;
			border-radius: 2px;
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.7rem;
			color: #e6edf3;
			font-weight: 600;
			cursor: pointer;
			transition: all 0.15s;
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.model-selector:hover {
			background: #21262d;
			border-color: #58a6ff;
		}

		.model-badge {
			padding: 0.125rem 0.35rem;
			background: #58a6ff;
			border-radius: 2px;
			font-size: 0.65rem;
			font-weight: 700;
			color: #0d1117;
		}

	.icon-btn {
		width: var(--icon-btn-size);
		height: var(--icon-btn-size);
		padding: 0;
		background: transparent;
			border: 1px solid var(--icon-btn-border-color);
			border-radius: 4px;
			color: #8b949e;
			cursor: pointer;
			transition: all 0.15s;
			font-size: var(--icon-btn-font-size);
			display: inline-flex;
			align-items: center;
			justify-content: center;
			line-height: 1;
			opacity: 0.92;
			transform: translateY(0.5px); /* optical align */
	}

	.icon-btn:hover {
		background: var(--icon-btn-hover);
		border-color: #3a82c2;
		color: #58a6ff;
		opacity: 1;
	}

	.icon-btn:focus-visible,
	.toggle-sidebar-btn:focus-visible,
	.new-session-btn:focus-visible {
		outline: 2px solid #58a6ff;
		outline-offset: 2px;
	}

	.icon-btn.active {
		border-color: #58a6ff;
		color: #58a6ff;
		background: rgba(88, 166, 255, 0.08);
	}

	.icon {
		width: 16px;
		height: 16px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
		pointer-events: none;
	}

		/* Messages - dense, terminal-like */
	.messages {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 1px;
		background: #0a0e14;
		min-height: 0; /* Fix flexbox overflow issue */
	}

	.messages.compact {
		padding: 0.5rem;
		gap: 0;
	}

		.input-container {
			border-top: 2px solid #21262d;
			padding: 0.75rem 1rem;
			background: #0d1117;
		}

		.error {
			padding: 0.625rem 0.875rem;
			background: #1c2128;
			color: #f85149;
			border-left: 3px solid #f85149;
			margin: 0 1rem 0.5rem 1rem;
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.75rem;
			line-height: 1.5;
		}

		.banner {
			padding: 0.6rem 1rem;
			background: #1c2128;
			border-bottom: 1px solid #30363d;
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.75rem;
			color: #f2f2f2;
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}

		.banner.offline {
			border-left: 3px solid #f85149;
		}

		.banner.retry {
			border-left: 3px solid #d29922;
		}

		.loading {
			display: flex;
			align-items: center;
			gap: 0.625rem;
			padding: 0.5rem 0.75rem;
			background: #161b22;
			border: 1px solid #30363d;
			border-left: 3px solid #58a6ff;
			color: #8b949e;
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.75rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.loading::before {
			content: "";
			width: 12px;
			height: 12px;
			border: 2px solid #30363d;
			border-top-color: #58a6ff;
			border-radius: 50%;
			animation: spin 0.6s linear infinite;
		}

		@keyframes spin {
			to { transform: rotate(360deg); }
		}

		/* Empty state - workspace status panel */
		.empty-state {
			flex: 1;
			display: grid;
			grid-template-rows: auto 1fr;
			padding: 0;
			background: #0a0e14;
		}

		.workspace-panel {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
			gap: 1px;
			background: #21262d;
			border: 1px solid #21262d;
			margin: 1rem;
		}

		.panel-section {
			background: #0d1117;
			padding: 0.875rem;
			border: 1px solid #21262d;
		}

		.panel-section h3 {
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.65rem;
			font-weight: 700;
			color: #6e7681;
			text-transform: uppercase;
			letter-spacing: 0.1em;
			margin: 0 0 0.625rem 0;
		}

		.panel-item {
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.75rem;
			color: #e6edf3;
			margin: 0.35rem 0;
			line-height: 1.6;
		}

		.panel-item span {
			color: #6e7681;
			margin-right: 0.5rem;
		}

		.panel-item.active {
			color: #58a6ff;
		}

		.session-gallery {
			margin: 1.5rem;
			background: #0d1117;
			border: 1px solid #21262d;
			border-radius: 4px;
			padding: 1.25rem;
			box-shadow: 0 20px 35px rgba(0, 0, 0, 0.35);
		}

		.session-gallery-header {
			display: flex;
			justify-content: space-between;
			align-items: baseline;
			margin-bottom: 1rem;
			gap: 1rem;
			flex-wrap: wrap;
		}

		.session-gallery-header h3 {
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.75rem;
			letter-spacing: 0.1em;
			text-transform: uppercase;
			color: #8b949e;
			margin: 0;
		}

		.session-gallery-header span {
			font-size: 0.75rem;
			color: #6e7681;
		}

		.session-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
			gap: 0.75rem;
		}

		.session-card {
			background: #0a0e14;
			border: 1px solid #21262d;
			border-radius: 4px;
			padding: 0.85rem 1rem;
			text-align: left;
			cursor: pointer;
			transition: all 0.15s ease;
			color: #e6edf3;
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
		}

		.session-card:hover {
			border-color: #58a6ff;
			box-shadow: 0 10px 25px rgba(88, 166, 255, 0.12);
			transform: translateY(-1px);
		}

		.session-card:focus-visible {
			outline: 2px solid #58a6ff;
			outline-offset: 2px;
		}

		.session-card-title {
			font-size: 0.85rem;
			font-weight: 600;
			margin-bottom: 0.35rem;
			color: #e6edf3;
		}

		.session-card-meta {
			display: flex;
			flex-wrap: wrap;
			gap: 0.35rem;
			font-size: 0.7rem;
			color: #8b949e;
		}

		/* Hide the legacy command hint that duplicated the slash-command prompt. */
		.command-hint {
			display: none !important;
		}

	@media (max-width: 768px) {
		.sidebar {
			position: absolute;
			left: 0;
			top: 0;
				bottom: 0;
				z-index: 10;
			}

			.status-bar {
				display: none;
			}

			.workspace-panel {
			grid-template-columns: 1fr;
		}
	}

	:host([reduced-motion]) .status-dot {
		animation: none;
	}

	:host([reduced-motion]) .toast {
		animation: none;
	}

	:host([reduced-motion]) .loading::before {
		animation: none;
	}
	`;

	@property() apiEndpoint = "";
	@property() model = "claude-sonnet-4-5";

	@state() private messages: Message[] = [];
	@state() private loading = false;
	@state() private error: string | null = null;
	@state() private currentModel = "";
	@state() private sidebarOpen = true;
	@state() private sessions: SessionSummary[] = [];
	@state() private currentSessionId: string | null = null;
	@state() private settingsOpen = false;
	@state() private status: WorkspaceStatus | null = null;
	@state() private showModelSelector = false;
	@state() private currentModelTokens: string | null = null;
	@state() private models: Model[] = [];
	@state() private usage: UsageSummary | null = null;
	@state() private toast: {
		message: string;
		type: "info" | "error" | "success";
	} | null = null;
	@state() private clientOnline =
		typeof navigator !== "undefined" ? navigator.onLine : true;
	@state() private lastSendFailed: string | null = null;
	@state() private lastApiError: string | null = null;
	@state() private nextRefreshAllowed = 0;
	@state() private showHealth = false;
	@state() private showShortcuts = false;
	@state() private sessionSearch = "";
	@property({ type: Boolean, reflect: true, attribute: "reduced-motion" })
	private reducedMotion = false;
	@property({ type: Boolean }) private compactMode = false;

	private static COMPACT_KEY = "composer_compact_mode";
	private static REDUCED_MOTION_KEY = "composer_reduced_motion";

	private apiClient!: ApiClient;
	private unsubscribeStore?: () => void;
	private handleOnline = () => {
		this.clientOnline = true;
		this.refreshStatus();
	};
	private handleOffline = () => {
		this.clientOnline = false;
	};
	private toggleHealth() {
		this.showHealth = !this.showHealth;
	}
	private closeHealth() {
		this.showHealth = false;
	}
	private handleKeydown = (e: KeyboardEvent) => {
		if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			this.toggleShortcuts();
		}
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "m") {
			e.preventDefault();
			this.toggleCompact();
		}
	};
	private toggleShortcuts() {
		this.showShortcuts = !this.showShortcuts;
	}
	private closeShortcuts() {
		this.showShortcuts = false;
	}
	private toggleCompact() {
		this.compactMode = !this.compactMode;
		try {
			localStorage.setItem(
				ComposerChat.COMPACT_KEY,
				this.compactMode ? "true" : "false",
			);
		} catch {
			/* ignore storage errors */
		}
		this.showToast(
			this.compactMode ? "Compact mode on" : "Compact mode off",
			"info",
			1500,
		);
	}
	private toggleReducedMotion() {
		this.reducedMotion = !this.reducedMotion;
		try {
			localStorage.setItem(
				ComposerChat.REDUCED_MOTION_KEY,
				this.reducedMotion ? "true" : "false",
			);
		} catch {
			/* ignore storage errors */
		}
		this.showToast(
			this.reducedMotion ? "Reduced motion on" : "Reduced motion off",
			"info",
			1500,
		);
	}

	connectedCallback() {
		super.connectedCallback();
		this.apiClient = new ApiClient(this.apiEndpoint);
		this.subscribeToStore();
		this.loadCurrentModel();
		this.loadSessions();
		dataStore.ensureStatus(this.apiClient);
		dataStore.ensureModels(this.apiClient);
		dataStore.ensureUsage(this.apiClient);
		this.hydrateDisplayPrefs();
		window.addEventListener("online", this.handleOnline);
		window.addEventListener("offline", this.handleOffline);
		window.addEventListener("keydown", this.handleKeydown);
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		if (this.unsubscribeStore) this.unsubscribeStore();
		window.removeEventListener("online", this.handleOnline);
		window.removeEventListener("offline", this.handleOffline);
		window.removeEventListener("keydown", this.handleKeydown);
	}

	private hydrateDisplayPrefs() {
		if (typeof window === "undefined") return;
		try {
			const compact = localStorage.getItem(ComposerChat.COMPACT_KEY);
			if (compact) this.compactMode = compact === "true";
			const rm = localStorage.getItem(ComposerChat.REDUCED_MOTION_KEY);
			if (rm) this.reducedMotion = rm === "true";
		} catch {
			/* ignore storage errors */
		}
	}

	private subscribeToStore() {
		// hydrate from cache immediately
		if (typeof window !== "undefined") {
			try {
				const savedModel = localStorage.getItem(MODEL_OVERRIDE_KEY);
				if (savedModel) this.currentModel = savedModel;
				const statusCache = localStorage.getItem(STATUS_CACHE_KEY);
				if (statusCache) this.status = JSON.parse(statusCache);
				const modelsCache = localStorage.getItem(MODELS_CACHE_KEY);
				if (modelsCache) this.models = JSON.parse(modelsCache);
				const usageCache = localStorage.getItem(USAGE_CACHE_KEY);
				if (usageCache) this.usage = JSON.parse(usageCache);
			} catch {
				/* ignore cache parse errors */
			}
		}

		this.unsubscribeStore = dataStore.subscribe((snapshot) => {
			this.status = snapshot.status;
			this.models = snapshot.models;
			this.usage = snapshot.usage;
			if (!this.currentModelTokens && snapshot.models.length > 0) {
				this.updateModelMeta();
			}
		});
	}

	private async loadCurrentModel() {
		try {
			const model = await this.apiClient.getCurrentModel();
			this.currentModel = model ? `${model.provider}/${model.id}` : this.model;
			const tokens = this.deriveModelTokens(model);
			this.currentModelTokens = tokens;
		} catch (e) {
			console.error("Failed to load current model:", e);
			this.currentModel = this.model;
			this.currentModelTokens = null;
		}
	}

	private deriveModelTokens(
		model: Partial<{
			contextWindow?: number;
			maxOutputTokens?: number;
			maxTokens?: number;
		}> | null,
	): string | null {
		if (!model) return null;
		if (model.contextWindow)
			return `${Math.round(model.contextWindow / 1000)}k ctx`;
		if (model.maxOutputTokens)
			return `${Math.round(model.maxOutputTokens / 1000)}k max out`;
		if (model.maxTokens) return `${Math.round(model.maxTokens / 1000)}k tokens`;
		return null;
	}

	private async updateModelMeta() {
		// Avoid extra fetches when we already have tokens or no models yet
		if (this.currentModelTokens && this.models.length === 0) return;
		try {
			const models =
				this.models.length > 0 ? this.models : await this.apiClient.getModels();
			const current =
				models.find((m) => `${m.provider}/${m.id}` === this.currentModel) ??
				models.find((m) => m.id === this.currentModel);
			const tokens = this.deriveModelTokens(current || null);
			this.currentModelTokens = tokens ?? "n/a";
		} catch (e) {
			console.error("Failed to load model metadata:", e);
			this.currentModelTokens = "n/a";
		}
	}

	private async loadSessions() {
		try {
			this.sessions = await this.apiClient.getSessions();
		} catch (e) {
			console.error("Failed to load sessions:", e);
		}
	}

	private renderIcon(
		name:
			| "chevron-left"
			| "chevron-right"
			| "info"
			| "refresh"
			| "globe"
			| "settings"
			| "grid"
			| "reduce"
			| "close",
	) {
		const paths: Record<string, string> = {
			"chevron-left": "M15 18l-6-6 6-6",
			"chevron-right": "M9 6l6 6-6 6",
			info: "M12 12v4m0-8h.01M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z",
			refresh: "M4.93 4.93A10 10 0 0 1 19.07 5M20 9v-4h-4M19.07 19.07A10 10 0 0 1 4.93 19M4 15v4h4",
			globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0c3 0 5-4 5-9s-2-9-5-9-5 4-5 9 2 9 5 9Zm0 0c2.5 0 4.5-4 4.5-9S14.5 3 12 3 7.5 7 7.5 12 9.5 21 12 21Zm0-9h9M3 12h9",
			settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.63a1 1 0 0 0 0-1.74l-1.17-.68a1 1 0 0 1-.46-.86l.05-1.35a1 1 0 0 0-1.17-1.01l-1.35.23a1 1 0 0 1-.9-.26L13.2 6a1 1 0 0 0-1.4 0l-.9.9a1 1 0 0 1-.9.26l-1.35-.23a1 1 0 0 0-1.17 1.01l.05 1.35a1 1 0 0 1-.46.86l-1.17.68a1 1 0 0 0 0 1.74l1.17.68a1 1 0 0 1 .46.86l-.05 1.35a1 1 0 0 0 1.17 1.01l1.35-.23a1 1 0 0 1 .9.26l.9.9a1 1 0 0 0 1.4 0l.9-.9a1 1 0 0 1 .9-.26l1.35.23a1 1 0 0 0 1.17-1.01l-.05-1.35a1 1 0 0 1 .46-.86Z",
			grid: "M4 4h7v7H4Zm9 0h7v7h-7ZM4 13h7v7H4Zm9 7v-7h7v7Z",
			reduce: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Zm-5-9h10",
			close: "M18 6 6 18M6 6l12 12",
		};
		return html`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
			<path d=${paths[name]}></path>
		</svg>`;
	}

	private toggleSidebar() {
		this.sidebarOpen = !this.sidebarOpen;
	}

	private toggleSettings() {
		this.settingsOpen = !this.settingsOpen;
	}

	private openModelSelector() {
		// Ensure models are ready for the dialog
		dataStore.ensureModels(this.apiClient);
		this.showModelSelector = true;
	}

	private closeModelSelector() {
		this.showModelSelector = false;
	}

	private handleModelSelect(event: CustomEvent) {
		const selected = event.detail.model as string;
		this.currentModel = selected;
		localStorage.setItem(MODEL_OVERRIDE_KEY, selected);
		// Persist selection server-side if possible
		this.apiClient
			.setModel(selected)
			.catch((err) => console.error("Failed to set model:", err));
		// Update tokens from cached models; fall back to later refresh if missing
		const cached = this.models.find(
			(m) => `${m.provider}/${m.id}` === selected || m.id === selected,
		);
		if (cached) {
			this.currentModelTokens =
				this.deriveModelTokens(cached) ?? this.currentModelTokens;
		} else {
			this.currentModelTokens = this.currentModelTokens ?? null;
		}
		if (this.models.length === 0) {
			this.updateModelMeta();
		}
		this.closeModelSelector();
		this.showToast("Model updated", "success");
	}

	private async createNewSession() {
		this.error = null;
		try {
			const session = await this.apiClient.createSession("New Chat");
			this.currentSessionId = session.id;
			this.messages = session.messages || [];
			await this.loadSessions();
			this.showToast("New session created", "success");
		} catch (e) {
			this.error =
				e instanceof Error ? e.message : "Failed to create new session";
			this.showToast(this.error, "error");
		}
	}

	private async selectSession(sessionId: string) {
		this.currentSessionId = sessionId;
		try {
			const session = await this.apiClient.getSession(sessionId);
			if (!session || !session.id) {
				throw new Error("Invalid session response");
			}
			this.currentSessionId = session.id;
			this.messages = Array.isArray(session.messages)
				? [...session.messages]
				: [];
			this.error = null;
			this.requestUpdate(); // Force update
			await this.updateComplete; // Wait for render
			this.scrollToBottom();
		} catch (e) {
			console.error("Failed to load session:", e);
			this.error = e instanceof Error ? e.message : "Failed to load session";
			this.showToast(this.error, "error");
		}
	}

	private async deleteSession(sessionId: string) {
		if (!confirm("Delete this session?")) return;
		try {
			await this.apiClient.deleteSession(sessionId);
			if (this.currentSessionId === sessionId) {
				this.currentSessionId = null;
				this.messages = [];
			}
			await this.loadSessions();
			this.showToast("Session deleted", "success");
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Failed to delete session";
			this.showToast(msg, "error");
		}
	}

	private async handleSubmit(
		event: CustomEvent<{ text: string; retry?: boolean }>,
	) {
		const text = event.detail.text.trim();
		if (!text || this.loading || !this.clientOnline) {
			return;
		}
		this.lastSendFailed = null;
		this.lastApiError = null;

		// Add user message unless reusing the existing one for a retry
		if (!event.detail.retry) {
			const userMessage: Message = {
				role: "user",
				content: text,
				timestamp: new Date().toISOString(),
			};
			this.messages = [...this.messages, userMessage];
		}

		// Start loading
		this.loading = true;
		this.error = null;

		// Add assistant message placeholder
		const assistantMessage: Message = {
			role: "assistant",
			content: "",
			timestamp: new Date().toISOString(),
			tools: [],
			thinking: "",
		};
		this.messages = [...this.messages, assistantMessage];

		// Track active tool calls
		const activeTools = new Map<string, any>();
		const thinkingBlocks = new Map<number, string>();
		let currentThinkingIndex: number | null = null;

		try {
			// Stream response with FULL events
			const stream = this.apiClient.chatWithEvents({
				model: this.currentModel,
				messages: this.messages.slice(0, -1), // Exclude placeholder
				sessionId: this.currentSessionId || undefined,
			});

			for await (const agentEvent of stream) {
				// Handle different event types
				switch (agentEvent.type) {
					case "session_update":
						if (agentEvent.sessionId) {
							this.currentSessionId = agentEvent.sessionId;
							this.requestUpdate();
						}
						break;
					case "message_update":
						if (agentEvent.assistantMessageEvent) {
							const msgEvent = agentEvent.assistantMessageEvent;

							// Text deltas
							if (msgEvent.type === "text_delta" && msgEvent.delta) {
								assistantMessage.content += msgEvent.delta;
								this.messages = [...this.messages];
							}

							// Thinking deltas
							else if (msgEvent.type === "thinking_start") {
								currentThinkingIndex = msgEvent.contentIndex;
								thinkingBlocks.set(msgEvent.contentIndex, "");
							} else if (
								msgEvent.type === "thinking_delta" &&
								currentThinkingIndex !== null
							) {
								const current = thinkingBlocks.get(currentThinkingIndex) || "";
								thinkingBlocks.set(
									currentThinkingIndex,
									current + msgEvent.delta,
								);
								assistantMessage.thinking = Array.from(
									thinkingBlocks.values(),
								).join("\n\n");
								this.messages = [...this.messages];
							} else if (msgEvent.type === "thinking_end") {
								currentThinkingIndex = null;
							}

							// Tool call tracking
							else if (msgEvent.type === "toolcall_end") {
								const toolCall = msgEvent.toolCall;
								if (!assistantMessage.tools) assistantMessage.tools = [];
								assistantMessage.tools.push({
									id: toolCall.id,
									name: toolCall.name,
									status: "pending",
									args: toolCall.arguments,
								});
								activeTools.set(toolCall.id, {
									name: toolCall.name,
									args: toolCall.arguments,
									index: assistantMessage.tools.length - 1,
								});
								this.messages = [...this.messages];
							}
						}
						break;

					case "tool_execution_start": {
						// Update tool status to running
						const toolInfo = activeTools.get(agentEvent.toolCallId);
						if (toolInfo && assistantMessage.tools) {
							assistantMessage.tools[toolInfo.index].status = "running";
							assistantMessage.tools[toolInfo.index].startTime = Date.now();
							this.messages = [...this.messages];
						}
						break;
					}

					case "tool_execution_end": {
						// Update tool with result
						const completedTool = activeTools.get(agentEvent.toolCallId);
						if (completedTool && assistantMessage.tools) {
							assistantMessage.tools[completedTool.index].status =
								agentEvent.isError ? "error" : "completed";
							assistantMessage.tools[completedTool.index].result =
								agentEvent.result;
							assistantMessage.tools[completedTool.index].endTime = Date.now();
							this.messages = [...this.messages];
						}
						activeTools.delete(agentEvent.toolCallId);
						break;
					}

					case "message_end":
						// Finalize assistant message
						if (agentEvent.message.role === "assistant") {
							assistantMessage.timestamp = new Date().toISOString();
							this.messages = [...this.messages];
						}
						break;

					case "agent_end":
						// All done
						break;
				}

				this.scrollToBottom();
			}

			// Refresh sessions list
			await this.loadSessions();
		} catch (e) {
			this.error = e instanceof Error ? e.message : "Failed to send message";
			this.messages = this.messages.slice(0, -1); // Remove placeholder
			this.showToast(this.error, "error");
			this.lastSendFailed = text;
			this.lastApiError = this.error;
		} finally {
			this.loading = false;
		}
	}

	private retryLastSend = () => {
		if (!this.lastSendFailed) return;
		this.handleSubmit(
			new CustomEvent("submit", {
				detail: { text: this.lastSendFailed, retry: true },
			}),
		);
	};

	private scrollToBottom() {
		this.updateComplete.then(() => {
			const messagesEl = this.shadowRoot?.querySelector(".messages");
			if (messagesEl) {
				messagesEl.scrollTop = messagesEl.scrollHeight;
			}
		});
	}

	private formatSessionDate(date: string): string {
		const d = new Date(date);
		const now = new Date();
		const diff = now.getTime() - d.getTime();
		const days = Math.floor(diff / (1000 * 60 * 60 * 24));

		if (days === 0) return "Today";
		if (days === 1) return "Yesterday";
		if (days < 7) return `${days} days ago`;
		return d.toLocaleDateString();
	}

	private refreshStatus() {
		const now = Date.now();
		if (now < this.nextRefreshAllowed) {
			this.showToast("Refresh throttled, try again shortly", "info", 1500);
			return;
		}
		this.nextRefreshAllowed = now + 3000; // 3s debounce
		dataStore.ensureStatus(this.apiClient, true);
		dataStore.ensureModels(this.apiClient, true);
		dataStore.ensureUsage(this.apiClient, true);
		this.showToast("Refreshing API state", "info", 1200);
	}

	private showToast(
		message: string,
		type: "info" | "error" | "success" = "info",
		duration = 3200,
	) {
		this.toast = { message, type };
		setTimeout(() => {
			if (this.toast?.message === message) {
				this.toast = null;
			}
		}, duration);
	}

	render() {
		const cwd = this.status?.cwd || "unknown";
		const gitBranch = this.status?.git?.branch || "unknown";
		const gitStatus = this.status?.git?.status;
		const gitSummary = gitStatus
			? [
					gitStatus.modified ? `${gitStatus.modified} mod` : null,
					gitStatus.added ? `${gitStatus.added} add` : null,
					gitStatus.deleted ? `${gitStatus.deleted} del` : null,
					gitStatus.untracked ? `${gitStatus.untracked} untracked` : null,
				]
					.filter(Boolean)
					.join(", ")
			: "n/a";
		const totalCost =
			this.usage && typeof this.usage.totalCost === "number"
				? `$${this.usage.totalCost.toFixed(2)}`
				: "$0.00";
		const isOnline = Boolean(this.status) && this.clientOnline;
		const latency = this.status?.lastLatencyMs || null;
		const taskHealth = (this.status as any)?.backgroundTasks as
			| WorkspaceStatus["backgroundTasks"]
			| undefined;
		const taskRunning = taskHealth?.running ?? 0;
		const taskFailed = taskHealth?.failed ?? 0;
		const showSessionGallery =
			this.messages.length === 0 && this.sessions.length > 0;
		const hasMessages = this.messages.length > 0;
		const renderedMessages = this.messages.map(
			(msg) => html`
				<composer-message
					role=${msg.role}
					content=${msg.content}
					timestamp=${msg.timestamp || ""}
					.thinking=${(msg as any).thinking || ""}
					.tools=${msg.tools || []}
					.compact=${this.compactMode}
					.reducedMotion=${this.reducedMotion}
				></composer-message>
			`,
		);
		const recentSessions = showSessionGallery ? this.sessions.slice(0, 8) : [];
		const sessionLoading = this.loading && this.messages.length === 0;
		const lastUpdated = (this.status as any)?.lastUpdated || null;

		const healthClass = !isOnline
			? "error"
			: latency !== null
				? latency > 1000
					? "warning"
					: "success"
				: "";
		const latencyLabel =
			latency === null
				? "n/a"
				: latency > 1000
					? "slow"
					: latency > 400
						? "ok"
						: "fast";

		return html`
			${
				!this.clientOnline
					? html`<div class="banner offline">Offline detected — messages will pause until connection returns.</div>`
					: ""
			}
			${
				this.lastSendFailed
					? html`<div class="banner retry">
						Last send failed.
						<button class="icon-btn" @click=${this.retryLastSend}>Retry</button>
					</div>`
					: ""
			}
			<div class="sidebar ${this.sidebarOpen ? "" : "collapsed"}">
				<div class="sidebar-header">
					<h2>Sessions</h2>
					<button class="new-session-btn" @click=${this.createNewSession}>
						New Chat
					</button>
					<input
						type="search"
						placeholder="Filter..."
						value=${this.sessionSearch}
						@input=${(e: Event) => {
							const value = (e.target as HTMLInputElement).value.toLowerCase();
							this.sessionSearch = value;
						}}
						style="margin-top:0.4rem; width:100%; padding:0.35rem 0.5rem; background:#0a0e14; border:1px solid #30363d; color:#e6edf3; border-radius:3px; font-family:'SF Mono','Menlo','Monaco',monospace; font-size:0.75rem;"
					/>
				</div>
				<div class="sessions-list">
					${this.sessions.map((session) =>
						this.sessionSearch &&
						!session.title?.toLowerCase().includes(this.sessionSearch) &&
						!session.id?.toLowerCase().includes(this.sessionSearch)
							? ""
							: html`
							<div
								class="session-item ${this.currentSessionId === session.id ? "active" : ""}"
								@click=${() => this.selectSession(session.id)}
							>
								<div class="session-title">${session.title || "Untitled Session"}</div>
							<div class="session-meta">
								${this.formatSessionDate(session.updatedAt)} • ${session.messageCount || 0} msgs
							</div>
							<button
								class="icon-btn"
								title="Delete"
								@click=${(e: Event) => {
									e.stopPropagation();
									this.deleteSession(session.id);
								}}
							>
								${this.renderIcon("close")}
							</button>
							</div>
						`,
					)}
				</div>
			</div>

			<div class="main-content">
		<div class="header">
			<div class="header-left">
				<button class="toggle-sidebar-btn" @click=${this.toggleSidebar} title=${this.sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}>
					${this.sidebarOpen ? this.renderIcon("chevron-left") : this.renderIcon("chevron-right")}
				</button>
				<h1>Composer</h1>
			</div>
			<div class="status-bar">
						<div class="status-item active">
							<span class="status-dot ${isOnline ? "" : "offline"} ${healthClass}"></span>
							<span>${isOnline ? "ONLINE" : "OFFLINE"}</span>
							${
								this.status?.server?.uptime
									? html`<span class="muted">${Math.max(1, Math.floor(this.status.server.uptime / 60))}m</span>`
									: ""
							}
							${
								latency
									? html`<span class="muted" title=${latencyLabel}>${Math.round(latency)}ms</span>`
									: ""
							}
							<button class="icon-btn" title="API health" @click=${this.toggleHealth}>${this.renderIcon("info")}</button>
						</div>
						<div class="status-item">
							<span>CWD</span>
							<span class="pill">${cwd.split("/").pop()}</span>
						</div>
						${
							this.status?.git
								? html`<div class="status-item" title=${gitStatus}>
									<span>GIT</span>
									<span class="pill ${gitStatus === "n/a" || gitStatus === "" ? "" : "warning"}">${gitBranch}</span>
								</div>`
								: ""
						}
						${
							taskHealth
								? html`<div class="status-item" title="Background tasks">
									<span>TASKS</span>
									<span class="pill ${taskFailed > 0 ? "warning" : "success"}">
										${taskRunning} running${taskFailed > 0 ? ` · ${taskFailed} failed` : ""}
									</span>
								</div>`
								: ""
						}
						<div class="status-item">
							<span>MSGS</span>
							<span class="muted">${this.messages.length}</span>
						</div>
						<button class="icon-btn" title="Refresh status" @click=${this.refreshStatus}>${this.renderIcon("refresh")}</button>
						${
							lastUpdated
								? html`<span class="status-item" title="Last API refresh">
										<span>UPDATED</span>
										<span class="muted">${new Date(lastUpdated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
									</span>`
								: ""
						}
			</div>
			<div class="header-right">
				<div class="model-selector" @click=${this.toggleSettings}>
					<span class="model-badge">AI</span>
					<span>${this.currentModel.split("/").pop()?.toUpperCase() || "MODEL"}</span>
						</div>
						<button class="icon-btn" title="Choose Model" @click=${this.openModelSelector}>${this.renderIcon("globe")}</button>
						<button class="icon-btn" title="Settings" @click=${this.toggleSettings}>${this.renderIcon("settings")}</button>
						<button class="icon-btn ${this.compactMode ? "active" : ""}" title="Toggle compact layout (Ctrl/Cmd+M)" @click=${this.toggleCompact}>${this.renderIcon("grid")}</button>
						<button class="icon-btn ${this.reducedMotion ? "active" : ""}" title="Toggle reduced motion" @click=${this.toggleReducedMotion}>${this.renderIcon("reduce")}</button>
					</div>
				</div>

				${this.error ? html`<div class="error">${this.error}</div>` : ""}

				<div class="messages ${this.compactMode ? "compact" : ""}">
						${
							this.messages.length === 0
								? html`
									<div class="empty-state">
										${
											sessionLoading
												? html`<div class="loading">Loading session...</div>`
												: ""
										}
										<div class="workspace-panel">
										<div class="panel-section">
											<h3>Workspace</h3>
											<div class="panel-item active">
												<span>►</span>${cwd}
											</div>
											<div class="panel-item">
												<span>GIT:</span>${gitBranch}
											</div>
											<div class="panel-item">
												<span>FILES:</span>${gitSummary}
											</div>
										</div>
											<div class="panel-section">
												<h3>Model</h3>
												<div class="panel-item active">
													<span>►</span>${this.currentModel}
												</div>
												<div class="panel-item">
												<span>CTX:</span>${this.currentModelTokens ?? "loading…"}
												</div>
												<div class="panel-item">
													<span>MODE:</span>streaming
												</div>
											</div>
										<div class="panel-section">
											<h3>Session</h3>
											<div class="panel-item">
												<span>ID:</span>${this.currentSessionId?.slice(0, 8) || "new"}
											</div>
											<div class="panel-item">
												<span>MSGS:</span>0
											</div>
											<div class="panel-item">
												<span>COST:</span>$0.00
											</div>
										</div>
									</div>
									${
										showSessionGallery
											? html`
											<div class="session-gallery" aria-live="polite">
												<div class="session-gallery-header">
													<h3>Resume a Session</h3>
													<span>Select a recent Composer run to continue.</span>
												</div>
												<div class="session-grid">
													${recentSessions.map(
														(session) => html`
															<button
																type="button"
																class="session-card"
																@click=${() => this.selectSession(session.id)}
															>
																<div class="session-card-title">
																	${session.title || `Session ${session.id?.slice(0, 8) || ""}`}
																</div>
																<div class="session-card-meta">
																	<span>${session.messageCount || 0} msgs</span>
																	<span>•</span>
																	<span>Updated ${this.formatSessionDate(session.updatedAt)}</span>
																</div>
															</button>
													`,
													)}
												</div>
											</div>
										`
											: ""
									}
								</div>
						  `
								: renderedMessages
						}
					${this.loading ? html`<div class="loading">Processing...</div>` : ""}
				</div>

				<div class="input-container">
					<composer-input
						@submit=${this.handleSubmit}
						?disabled=${this.loading}
					></composer-input>
				</div>
			</div>

			${
				this.settingsOpen
					? html`
				<div style="position: absolute; top: 0; right: 0; width: 500px; height: 100%; background: #0a0e14; border-left: 2px solid #21262d; z-index: 100;">
					<composer-settings
						.apiClient=${this.apiClient}
						.currentModel=${this.currentModel}
						@close=${this.toggleSettings}
						@model-select=${this.handleModelSelect}
					></composer-settings>
					</div>
			`
					: ""
			}

			${
				this.showModelSelector
					? html`
						<model-selector
							.open=${this.showModelSelector}
							.apiEndpoint=${this.apiEndpoint}
							.currentModel=${this.currentModel}
							.modelsPrefetch=${this.models}
							@close=${this.closeModelSelector}
							@model-selected=${this.handleModelSelect}
						></model-selector>
				  `
					: ""
			}

			${
				this.showHealth
					? html`
						<div style="position: fixed; top: 64px; right: 12px; width: 260px; background: #0d1117; border: 1px solid #30363d; padding: 0.75rem; z-index: 120; box-shadow: 0 10px 24px rgba(0,0,0,0.4); font-family: 'SF Mono','Menlo','Monaco', monospace; font-size: 0.75rem; color: #e6edf3;">
							<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
								<span style="color:#6e7681; letter-spacing:0.05em;">API HEALTH</span>
								<button class="icon-btn" @click=${this.closeHealth}>${this.renderIcon("close")}</button>
							</div>
							<div style="margin:0.25rem 0;"><span style="color:#6e7681;">Base:</span> ${this.apiClient.baseUrl}</div>
							<div style="margin:0.25rem 0;"><span style="color:#6e7681;">Latency:</span> ${latency ? `${Math.round(latency)}ms` : "n/a"}</div>
							<div style="margin:0.25rem 0;"><span style="color:#6e7681;">Last updated:</span> ${lastUpdated ? new Date(lastUpdated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "n/a"}</div>
							<div style="margin:0.25rem 0;"><span style="color:#6e7681;">Last error:</span> ${this.lastApiError || "none"}</div>
						</div>
				  `
					: ""
			}

			${
				this.toast
					? html`
						<div class="toast ${this.toast.type}">
							${this.toast.message}
						</div>
				  `
					: ""
			}

			${
				this.showShortcuts
					? html`
						<div style="position: fixed; top: 30%; left: 50%; transform: translateX(-50%); width: 420px; background: #0d1117; border: 1px solid #30363d; padding: 1rem; z-index: 140; box-shadow: 0 18px 40px rgba(0,0,0,0.5); font-family: 'SF Mono','Menlo','Monaco', monospace; font-size: 0.78rem; color: #e6edf3;">
							<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
								<span style="letter-spacing:0.08em; color:#8b949e;">Keyboard shortcuts</span>
								<button class="icon-btn" @click=${this.closeShortcuts}>${this.renderIcon("close")}</button>
							</div>
						<div style="display:grid; grid-template-columns: auto 1fr; gap: 0.35rem 0.75rem;">
							<span class="pill">Enter</span><span>Send message</span>
							<span class="pill">Shift+Enter</span><span>New line</span>
							<span class="pill">?</span><span>Toggle this help</span>
							<span class="pill">↻</span><span>Refresh API status</span>
							<span class="pill">⌘/Ctrl + K</span><span>Browser find (fwd to your editor)</span>
							<span class="pill">⌘/Ctrl + M</span><span>Toggle compact layout</span>
													</div>
					</div>
			  `
					: ""
			}
		`;
	}
}
