/**
 * Main chat interface component
 */

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
	ApiClient,
	type ComposerToolCall,
	type Message,
	type Model,
	type Session,
	type SessionSummary,
	type UsageSummary,
	type WorkspaceStatus,
} from "../services/api-client.js";
import { dataStore } from "../services/data-store.js";
import "./command-drawer.js";
import { WEB_SLASH_COMMANDS } from "./slash-commands.js";
import "./composer-message.js";
import "./composer-input.js";
import "./composer-settings.js";
import "./model-selector.js";
import "./admin-settings.js";

const STATUS_CACHE_KEY = "composer_status_cache";
const MODELS_CACHE_KEY = "composer_models_cache";
const USAGE_CACHE_KEY = "composer_usage_cache";
const MODEL_OVERRIDE_KEY = "composer_model_override";

interface ExtendedToolCall extends ComposerToolCall {
	startTime?: number;
	endTime?: number;
}

@customElement("composer-chat")
export class ComposerChat extends LitElement {
	static styles = css`
		:host {
			display: flex !important;
			height: 100% !important;
			width: 100% !important;
			background: var(--bg-primary, #0c0d0f);
			color: var(--text-primary, #e8e9eb);
			overflow: hidden;
			font-family: var(--font-mono, "JetBrains Mono", monospace);
		}

		/* Sidebar - Control Room Panel */
		.sidebar {
			width: 260px;
			background: var(--bg-deep, #08090a);
			border-right: 1px solid var(--border-primary, #1e2023);
			display: flex;
			flex-direction: column;
			transition: transform 0.2s ease;
			z-index: 20;
		}

		.sidebar.collapsed {
			transform: translateX(-100%);
		}

		.sidebar-header {
			padding: 1rem 0.75rem;
			display: flex;
			flex-direction: column;
			gap: 0.75rem;
			border-bottom: 1px solid var(--border-primary, #1e2023);
		}

		.sidebar-header h2 {
			font-family: var(--font-mono, monospace);
			font-size: 0.6rem;
			font-weight: 600;
			margin: 0;
			color: var(--text-tertiary, #5c5e62);
			text-transform: uppercase;
			letter-spacing: 0.1em;
		}

		.new-session-btn {
			width: 100%;
			padding: 0.5rem 0.75rem;
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
			color: var(--accent-amber, #d4a012);
			border: none;
			font-family: var(--font-mono, monospace);
			font-size: 0.7rem;
			font-weight: 600;
			cursor: pointer;
			transition: all 0.15s ease;
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 0.5rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.new-session-btn:hover {
			background: var(--accent-amber, #d4a012);
			color: var(--bg-deep, #08090a);
		}

		.new-session-btn:active {
			transform: scale(0.98);
		}

		.sessions-list {
			flex: 1;
			overflow-y: auto;
			padding: 0.5rem;
		}

		.session-item {
			padding: 0.625rem 0.75rem;
			margin-bottom: 1px;
			cursor: pointer;
			transition: all 0.1s ease;
			background: transparent;
			border-left: 2px solid transparent;
			position: relative;
		}

		.session-item:hover {
			background: var(--bg-elevated, #161719);
		}

		.session-item.active {
			background: var(--bg-elevated, #161719);
			border-left-color: var(--accent-amber, #d4a012);
		}

		.session-title {
			font-family: var(--font-mono, monospace);
			font-size: 0.75rem;
			font-weight: 500;
			margin-bottom: 0.2rem;
			color: var(--text-primary, #e8e9eb);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.session-item.active .session-title {
			color: var(--accent-amber, #d4a012);
		}

		.session-meta {
			font-family: var(--font-mono, monospace);
			font-size: 0.6rem;
			color: var(--text-tertiary, #5c5e62);
		}

		/* Main Content */
		.main-content {
			flex: 1;
			display: flex;
			flex-direction: column;
			position: relative;
			min-width: 0;
			background: var(--bg-primary, #0c0d0f);
		}

		.header {
			display: grid;
			grid-template-columns: auto 1fr auto;
			align-items: center;
			gap: 1rem;
			padding: 0.625rem 1.25rem;
			background: var(--bg-deep, #08090a);
			border-bottom: 1px solid var(--border-primary, #1e2023);
			min-height: 48px;
			z-index: 10;
		}

		.header-left {
			display: flex;
			align-items: center;
			gap: 0.75rem;
		}

		.toggle-sidebar-btn {
			width: 28px;
			height: 28px;
			padding: 0;
			background: transparent;
			border: 1px solid var(--border-primary, #1e2023);
			color: var(--text-tertiary, #5c5e62);
			cursor: pointer;
			transition: all 0.15s ease;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.toggle-sidebar-btn:hover {
			background: var(--bg-elevated, #161719);
			color: var(--text-primary, #e8e9eb);
			border-color: var(--border-hover, #3a3d42);
		}

		.header h1 {
			font-family: var(--font-display, "DM Sans", sans-serif);
			font-size: 0.9rem;
			font-weight: 600;
			margin: 0;
			color: var(--text-primary, #e8e9eb);
			letter-spacing: -0.01em;
		}

		.status-bar {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			flex-wrap: nowrap;
			white-space: nowrap;
			overflow-x: auto;
			min-width: 0;
			font-family: var(--font-mono, monospace);
			font-size: 0.6rem;
			color: var(--text-tertiary, #5c5e62);
		}

		.status-item {
			display: flex;
			align-items: center;
			gap: 0.35rem;
			padding: 0.2rem 0.5rem;
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-primary, #1e2023);
			font-size: 0.6rem;
			font-weight: 500;
			transition: all 0.15s ease;
		}

		.status-item:hover {
			border-color: var(--border-hover, #3a3d42);
		}

		.status-item.active {
			border-color: var(--accent-amber, #d4a012);
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
			color: var(--accent-amber, #d4a012);
		}

		.header-right {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			flex-wrap: nowrap;
			white-space: nowrap;
		}

		.pill {
			display: inline-flex;
			align-items: center;
			gap: 0.25rem;
			padding: 0.15rem 0.4rem;
			background: var(--bg-elevated, #161719);
			color: var(--text-secondary, #8b8d91);
			font-weight: 600;
			font-size: 0.6rem;
			text-transform: uppercase;
			letter-spacing: 0.03em;
		}

		.pill.warning {
			background: var(--accent-yellow-dim, rgba(234, 179, 8, 0.12));
			color: var(--accent-yellow, #eab308);
		}

		.pill.success {
			background: var(--accent-green-dim, rgba(34, 197, 94, 0.12));
			color: var(--accent-green, #22c55e);
		}

		.status-dot {
			width: 5px;
			height: 5px;
			border-radius: 50%;
			background: var(--accent-green, #22c55e);
			box-shadow: 0 0 6px var(--accent-green, #22c55e);
		}

		.status-dot.offline {
			background: var(--accent-red, #ef4444);
			box-shadow: none;
		}

		/* Messages Area */
		.messages {
			flex: 1;
			overflow-y: auto;
			padding: 1.5rem 2rem;
			display: flex;
			flex-direction: column;
			background: var(--bg-primary, #0c0d0f);
			scroll-behavior: smooth;
		}

		.messages.compact {
			padding: 1rem;
		}

		.input-container {
			padding: 1rem 1.5rem 1.5rem;
			background: var(--bg-deep, #08090a);
			border-top: 1px solid var(--border-primary, #1e2023);
			position: sticky;
			bottom: 0;
			z-index: 15;
		}

		/* Model Selector */
		.model-selector {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			padding: 0.25rem 0.6rem;
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-primary, #1e2023);
			font-family: var(--font-mono, monospace);
			font-size: 0.65rem;
			color: var(--text-secondary, #8b8d91);
			font-weight: 500;
			cursor: pointer;
			transition: all 0.15s ease;
		}

		.model-selector:hover {
			background: var(--bg-surface, #1a1b1e);
			border-color: var(--border-hover, #3a3d42);
			color: var(--text-primary, #e8e9eb);
		}

		.model-badge {
			width: 5px;
			height: 5px;
			border-radius: 50%;
			background: var(--accent-amber, #d4a012);
		}

		/* Icon Buttons */
		.icon-btn {
			width: 26px;
			height: 26px;
			padding: 0;
			background: transparent;
			border: 1px solid var(--border-primary, #1e2023);
			color: var(--text-tertiary, #5c5e62);
			cursor: pointer;
			transition: all 0.15s ease;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.icon-btn:hover {
			background: var(--bg-elevated, #161719);
			border-color: var(--border-hover, #3a3d42);
			color: var(--text-primary, #e8e9eb);
		}

		.icon-btn.active {
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
			border-color: var(--accent-amber, #d4a012);
			color: var(--accent-amber, #d4a012);
		}

		.icon {
			width: 14px;
			height: 14px;
			stroke: currentColor;
			fill: none;
			stroke-width: 1.5;
			stroke-linecap: round;
			stroke-linejoin: round;
			pointer-events: none;
		}

		/* Toast */
		.toast {
			position: fixed;
			bottom: 20px;
			right: 20px;
			padding: 0.6rem 1rem;
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-primary, #1e2023);
			color: var(--text-primary, #e8e9eb);
			font-family: var(--font-mono, monospace);
			font-size: 0.75rem;
			box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.5));
			z-index: 300;
			display: flex;
			align-items: center;
			gap: 0.75rem;
			animation: slideIn 0.2s ease;
		}

		@keyframes slideIn {
			from { opacity: 0; transform: translateX(10px); }
			to { opacity: 1; transform: translateX(0); }
		}

		.toast.success { border-left: 2px solid var(--accent-green, #22c55e); }
		.toast.error { border-left: 2px solid var(--accent-red, #ef4444); }
		.toast.info { border-left: 2px solid var(--accent-amber, #d4a012); }

		/* Empty State */
		.empty-state {
			flex: 1;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			padding: 2rem;
			background: var(--bg-primary, #0c0d0f);
		}

		.workspace-panel {
			display: grid;
			grid-template-columns: repeat(3, 1fr);
			gap: 1rem;
			background: transparent;
			border: none;
			margin: 2rem 0;
			width: 100%;
			max-width: 800px;
		}

		.panel-section {
			background: var(--bg-elevated, #161719);
			padding: 1rem;
			border: 1px solid var(--border-primary, #1e2023);
		}

		.panel-section h3 {
			font-family: var(--font-mono, monospace);
			font-size: 0.6rem;
			font-weight: 600;
			color: var(--text-tertiary, #5c5e62);
			text-transform: uppercase;
			letter-spacing: 0.1em;
			margin: 0 0 0.75rem 0;
		}

		.panel-item {
			font-family: var(--font-mono, monospace);
			font-size: 0.75rem;
			color: var(--text-primary, #e8e9eb);
			margin: 0.4rem 0;
			display: flex;
			align-items: center;
		}

		.panel-item span {
			color: var(--text-tertiary, #5c5e62);
			margin-right: 0.5rem;
			min-width: 2.5rem;
		}

		.session-gallery {
			margin-top: 1.5rem;
			width: 100%;
			max-width: 800px;
			background: transparent;
			border: none;
			box-shadow: none;
			padding: 0;
		}

		.session-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
			gap: 0.75rem;
		}

		.session-card {
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-primary, #1e2023);
			padding: 1rem;
			text-align: left;
			cursor: pointer;
			transition: all 0.15s ease;
			color: var(--text-primary, #e8e9eb);
		}

		.session-card:hover {
			border-color: var(--accent-amber, #d4a012);
			background: var(--bg-surface, #1a1b1e);
		}

		.session-card-title {
			font-family: var(--font-mono, monospace);
			font-size: 0.8rem;
			font-weight: 500;
			margin-bottom: 0.35rem;
		}

		/* Responsive */
		@media (max-width: 768px) {
			.sidebar {
				position: absolute;
				height: 100%;
				box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.5));
			}
			.workspace-panel {
				grid-template-columns: 1fr;
			}
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
	@state() private adminSettingsOpen = false;
	@state() private status: WorkspaceStatus | null = null;
	@state() private commandPrefs: { favorites: string[]; recents: string[] } = {
		favorites: [],
		recents: [],
	};
	@state() private commandDrawerOpen = false;
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
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
			e.preventDefault();
			this.commandDrawerOpen = true;
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

	private closeCommandDrawer() {
		this.commandDrawerOpen = false;
	}

	private handleCommandSelect(name: string) {
		const input = this.shadowRoot?.querySelector("composer-input") as
			| any
			| null;
		if (input?.setValue) {
			input.setValue(`/${name} `);
		}
		const recents = [
			name,
			...this.commandPrefs.recents.filter((n) => n !== name),
		].slice(0, 20);
		void this.saveCommandPrefs({
			favorites: this.commandPrefs.favorites,
			recents,
		});
		this.commandDrawerOpen = false;
	}

	private handleToggleFavorite(name: string) {
		const favorites = this.commandPrefs.favorites.includes(name)
			? this.commandPrefs.favorites.filter((n) => n !== name)
			: [...this.commandPrefs.favorites, name];
		void this.saveCommandPrefs({
			favorites,
			recents: this.commandPrefs.recents,
		});
	}

	private async loadCommandPrefs() {
		try {
			const prefs = await this.apiClient.getCommandPrefs();
			this.commandPrefs = prefs;
		} catch (e) {
			console.warn("Failed to load command prefs", e);
		}
	}

	private async saveCommandPrefs(prefs: {
		favorites: string[];
		recents: string[];
	}) {
		this.commandPrefs = prefs;
		try {
			await this.apiClient.saveCommandPrefs(prefs);
		} catch (e) {
			console.warn("Failed to save command prefs", e);
		}
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
		this.loadCommandPrefs();
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
			refresh:
				"M4.93 4.93A10 10 0 0 1 19.07 5M20 9v-4h-4M19.07 19.07A10 10 0 0 1 4.93 19M4 15v4h4",
			globe:
				"M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0c3 0 5-4 5-9s-2-9-5-9-5 4-5 9 2 9 5 9Zm0 0c2.5 0 4.5-4 4.5-9S14.5 3 12 3 7.5 7 7.5 12 9.5 21 12 21Zm0-9h9M3 12h9",
			settings:
				"M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.63a1 1 0 0 0 0-1.74l-1.17-.68a1 1 0 0 1-.46-.86l.05-1.35a1 1 0 0 0-1.17-1.01l-1.35.23a1 1 0 0 1-.9-.26L13.2 6a1 1 0 0 0-1.4 0l-.9.9a1 1 0 0 1-.9.26l-1.35-.23a1 1 0 0 0-1.17 1.01l.05 1.35a1 1 0 0 1-.46.86l-1.17.68a1 1 0 0 0 0 1.74l1.17.68a1 1 0 0 1 .46.86l-.05 1.35a1 1 0 0 0 1.17 1.01l1.35-.23a1 1 0 0 1 .9.26l.9.9a1 1 0 0 0 1.4 0l.9-.9a1 1 0 0 1 .9-.26l1.35.23a1 1 0 0 0 1.17-1.01l-.05-1.35a1 1 0 0 1 .46-.86Z",
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

	private toggleAdminSettings() {
		this.adminSettingsOpen = !this.adminSettingsOpen;
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
								const extendedTool: ExtendedToolCall = {
									toolCallId: toolCall.id,
									name: toolCall.name,
									status: "pending",
									args: toolCall.arguments,
								};
								assistantMessage.tools.push(extendedTool);
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
							const tool = assistantMessage.tools[
								toolInfo.index
							] as ExtendedToolCall;
							tool.status = "running";
							tool.startTime = Date.now();
							this.messages = [...this.messages];
						}
						break;
					}

					case "tool_execution_end": {
						// Update tool with result
						const completedTool = activeTools.get(agentEvent.toolCallId);
						if (completedTool && assistantMessage.tools) {
							const tool = assistantMessage.tools[
								completedTool.index
							] as ExtendedToolCall;
							tool.status = agentEvent.isError ? "error" : "completed";
							tool.result = agentEvent.result;
							tool.endTime = Date.now();
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
				? this.usage.totalCost > 0
					? `$${this.usage.totalCost.toFixed(2)}`
					: null
				: null;
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
								? html`<div class="status-item" title=${gitSummary}>
									<span>GIT</span>
									<span class="pill ${this.status.git.status.modified || this.status.git.status.added || this.status.git.status.deleted ? "warning" : "success"}">${gitBranch}</span>
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
				<div class="model-selector" @click=${this.openModelSelector}>
					<span class="model-badge">AI</span>
					<span>${this.currentModel.split("/").pop()?.toUpperCase() || "MODEL"}</span>
						</div>
						<button class="icon-btn" title="Choose Model" @click=${this.openModelSelector}>${this.renderIcon("globe")}</button>
						<button class="icon-btn" title="Settings" @click=${this.toggleSettings}>${this.renderIcon("settings")}</button>
						<button class="icon-btn" title="Admin Settings" @click=${this.toggleAdminSettings}>🛡️</button>
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
											${
												totalCost
													? html`<div class="panel-item">
														<span>COST:</span>${totalCost}
													</div>`
													: ""
											}
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
				this.adminSettingsOpen
					? html`
				<div style="position: absolute; top: 0; right: 0; width: 800px; height: 100%; background: var(--bg-primary, #09090b); border-left: 2px solid var(--border-primary, #27272a); z-index: 110;">
					<admin-settings
						@close=${this.toggleAdminSettings}
					></admin-settings>
				</div>
			`
					: ""
			}

			<command-drawer
				?open=${this.commandDrawerOpen}
				.commands=${WEB_SLASH_COMMANDS}
				.favorites=${this.commandPrefs.favorites}
				.recents=${this.commandPrefs.recents}
				@select-command=${(e: CustomEvent<string>) =>
					this.handleCommandSelect(e.detail)}
				@toggle-favorite=${(e: CustomEvent<string>) =>
					this.handleToggleFavorite(e.detail)}
				@close=${this.closeCommandDrawer}
			></command-drawer>

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
