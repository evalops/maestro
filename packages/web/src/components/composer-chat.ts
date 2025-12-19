/**
 * Main chat interface component
 */

import { LitElement, type PropertyValues, css, html } from "lit";
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
import type { Artifact } from "../services/artifacts.js";
import {
	applyArtifactsCommand,
	coerceArtifactsArgs,
	createEmptyArtifactsState,
	reconstructArtifactsFromMessages,
} from "../services/artifacts.js";
import { dataStore } from "../services/data-store.js";
import "./command-drawer.js";
import { WEB_SLASH_COMMANDS } from "./slash-commands.js";
import "./composer-message.js";
import "./composer-input.js";
import type { ComposerInput } from "./composer-input.js";
import "./composer-settings.js";
import "./model-selector.js";
import "./admin-settings.js";
import "./composer-artifacts-panel.js";
import "./composer-attachment-viewer.js";
import { ArtifactsRuntimeProvider } from "./sandbox/artifacts-runtime-provider.js";
import { AttachmentsRuntimeProvider } from "./sandbox/attachments-runtime-provider.js";
import { getSandboxConsoleSnapshot } from "./sandbox/console-runtime-provider.js";
import { getSandboxDownloadsSnapshot } from "./sandbox/file-download-runtime-provider.js";
import { FileDownloadRuntimeProvider } from "./sandbox/file-download-runtime-provider.js";
import { JavascriptReplRuntimeProvider } from "./sandbox/javascript-repl-runtime-provider.js";

const STATUS_CACHE_KEY = "composer_status_cache";
const MODELS_CACHE_KEY = "composer_models_cache";
const USAGE_CACHE_KEY = "composer_usage_cache";
const MODEL_OVERRIDE_KEY = "composer_model_override";

interface ExtendedToolCall extends ComposerToolCall {
	startTime?: number;
	endTime?: number;
}

interface ActiveToolInfo {
	name: string;
	args: unknown;
	index: number;
}

/** Extended message type with thinking support for streaming */
interface MessageWithThinking extends Message {
	thinking?: string;
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

		.history-truncation {
			font-family: var(--font-mono, monospace);
			font-size: 0.7rem;
			color: var(--text-tertiary, #5c5e62);
			border: 1px solid var(--border-primary, #1e2023);
			background: var(--bg-elevated, #161719);
			padding: 0.5rem 0.75rem;
			margin-bottom: 0.75rem;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 0.75rem;
		}

		.history-btn {
			border: 1px solid var(--border-primary, #1e2023);
			background: transparent;
			color: var(--text-tertiary, #5c5e62);
			height: 26px;
			padding: 0 0.6rem;
			cursor: pointer;
			font-family: var(--font-mono, monospace);
			font-size: 0.65rem;
			letter-spacing: 0.06em;
			text-transform: uppercase;
		}

		.history-btn:hover {
			background: var(--bg-surface, #1a1b1e);
			color: var(--text-primary, #e8e9eb);
			border-color: var(--accent-amber, #d4a012);
		}

		.history-btn:disabled {
			opacity: 0.6;
			cursor: not-allowed;
		}

		.jump-latest {
			position: sticky;
			bottom: 0.75rem;
			align-self: center;
			border: 1px solid var(--border-primary, #1e2023);
			background: var(--accent-blue-dim, rgba(59, 130, 246, 0.12));
			color: var(--text-primary, #e8e9eb);
			font-family: var(--font-mono, monospace);
			font-size: 0.7rem;
			padding: 0.5rem 0.8rem;
			cursor: pointer;
			letter-spacing: 0.02em;
			backdrop-filter: blur(8px);
			z-index: 5;
		}

		.jump-latest:hover {
			border-color: var(--accent-blue, #3b82f6);
			background: var(--accent-blue-dim, rgba(59, 130, 246, 0.18));
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

		.icon-btn:disabled {
			opacity: 0.4;
			cursor: not-allowed;
		}

		.icon-btn:disabled:hover {
			background: transparent;
			border-color: var(--border-primary, #1e2023);
			color: var(--text-tertiary, #5c5e62);
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

		/* Modal */
		.modal-overlay {
			position: fixed;
			inset: 0;
			background: rgba(0, 0, 0, 0.7);
			z-index: 260;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 1.25rem;
		}

		.modal-dialog {
			width: min(520px, 100%);
			background: var(--bg-deep, #08090a);
			border: 1px solid var(--border-primary, #1e2023);
			box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
			padding: 0.9rem;
			font-family: var(--font-mono, monospace);
		}

		.modal-title {
			font-size: 0.75rem;
			font-weight: 700;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--text-secondary, #8b8d91);
			margin-bottom: 0.75rem;
		}

		.modal-row {
			display: flex;
			gap: 0.5rem;
			align-items: center;
			margin-bottom: 0.6rem;
		}

		.modal-row label {
			font-size: 0.7rem;
			color: var(--text-tertiary, #5c5e62);
			min-width: 130px;
		}

		.modal-row input[type="number"],
		.modal-row input[type="text"] {
			flex: 1;
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-primary, #1e2023);
			color: var(--text-primary, #e8e9eb);
			padding: 0.35rem 0.5rem;
			font-family: inherit;
			font-size: 0.75rem;
		}

		.modal-row select {
			flex: 1;
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-primary, #1e2023);
			color: var(--text-primary, #e8e9eb);
			padding: 0.35rem 0.5rem;
			font-family: inherit;
			font-size: 0.75rem;
		}

		.modal-help {
			font-size: 0.7rem;
			color: var(--text-tertiary, #5c5e62);
			line-height: 1.35;
			margin: 0.5rem 0 0.75rem 0;
		}

		.modal-actions {
			display: flex;
			justify-content: flex-end;
			gap: 0.5rem;
		}

		.modal-btn {
			border: 1px solid var(--border-primary, #1e2023);
			background: transparent;
			color: var(--text-tertiary, #5c5e62);
			height: 30px;
			padding: 0 0.75rem;
			cursor: pointer;
			font-family: inherit;
			font-size: 0.7rem;
			letter-spacing: 0.06em;
			text-transform: uppercase;
		}

		.modal-btn.primary {
			border-color: var(--accent-amber, #d4a012);
			color: var(--accent-amber, #d4a012);
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
		}

		.modal-btn:hover:not(:disabled) {
			background: var(--bg-elevated, #161719);
			color: var(--text-primary, #e8e9eb);
		}

		.modal-btn:disabled {
			opacity: 0.4;
			cursor: not-allowed;
		}

		.modal-error {
			font-size: 0.75rem;
			color: var(--accent-red, #ef4444);
			margin: 0.5rem 0;
		}

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
	@state() private shareToken: string | null = null;
	@state() private renderLimit = 200;
	@state() private renderEndIndex = 0;
	@state() private unseenMessages = 0;
	@state() private loadingEarlier = false;
	@state() private settingsOpen = false;
	@state() private adminSettingsOpen = false;
	@state() private artifactsOpen = false;
	@state() private activeArtifact: string | null = null;
	@state() private artifactsState = createEmptyArtifactsState();
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
	@state() private shareDialogOpen = false;
	@state() private shareDialogLoading = false;
	@state() private shareDialogError: string | null = null;
	@state() private shareExpiresHours = 24;
	@state() private shareMaxAccesses: number | null = 100;
	@state() private shareResult: {
		webShareUrl: string;
		expiresAt: string;
		maxAccesses: number | null;
	} | null = null;
	@state() private exportDialogOpen = false;
	@state() private exportDialogLoading = false;
	@state() private exportDialogError: string | null = null;
	@state() private exportFormat: "json" | "markdown" | "text" = "json";
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
	@state() private attachmentViewerOpen = false;
	@state() private attachmentViewerAttachment:
		| Message["attachments"][number]
		| null = null;
	@property({ type: Boolean, reflect: true, attribute: "reduced-motion" })
	private reducedMotion = false;
	@property({ type: Boolean }) private compactMode = false;

	private static COMPACT_KEY = "composer_compact_mode";
	private static REDUCED_MOTION_KEY = "composer_reduced_motion";

	private apiClient!: ApiClient;
	private attachmentContentCache = new Map<string, string>();
	private unsubscribeStore?: () => void;
	private autoScroll = true;
	private lastMessagesLength = 0;
	private messagesScrollRaf: number | null = null;
	private historyObserver: IntersectionObserver | null = null;
	private observedHistoryEl: Element | null = null;
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

	private getMessagesScroller(): HTMLElement | null {
		return (
			(this.shadowRoot?.querySelector(".messages") as HTMLElement | null) ??
			null
		);
	}

	private getRenderEnd(): number {
		const total = this.messages.length;
		if (this.renderEndIndex > 0 && this.renderEndIndex <= total)
			return this.renderEndIndex;
		return total;
	}

	private getRenderWindow(): { start: number; end: number; total: number } {
		const total = this.messages.length;
		const end = this.getRenderEnd();
		const windowSize = Math.max(1, this.renderLimit);
		const start = Math.max(0, end - windowSize);
		return { start, end, total };
	}

	private syncRenderWindowToBottom() {
		this.autoScroll = true;
		this.unseenMessages = 0;
		this.renderEndIndex = this.messages.length;
		this.lastMessagesLength = this.messages.length;
	}

	private ensureHistoryObserver() {
		if (typeof window === "undefined") return;
		if (!("IntersectionObserver" in window)) return;
		if (this.historyObserver) return;

		const scroller = this.getMessagesScroller();
		if (!scroller) return;

		this.historyObserver = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					void this.maybeAutoLoadEarlier();
				}
			},
			{ root: scroller, threshold: 0.01 },
		);
	}

	private refreshHistoryObserverTarget() {
		if (!this.historyObserver) return;
		const next = this.shadowRoot?.querySelector("[data-history-truncation]");
		if (next === this.observedHistoryEl) return;

		if (this.observedHistoryEl) {
			try {
				this.historyObserver.unobserve(this.observedHistoryEl);
			} catch {
				// ignore
			}
		}

		this.observedHistoryEl = next;
		if (next) {
			this.historyObserver.observe(next);
		}
	}

	private handleMessagesScroll = () => {
		if (this.messagesScrollRaf !== null) return;
		const raf = window.requestAnimationFrame
			? window.requestAnimationFrame.bind(window)
			: (cb: FrameRequestCallback) =>
					window.setTimeout(() => cb(Date.now()), 16);
		this.messagesScrollRaf = raf(() => {
			this.messagesScrollRaf = null;
			const scroller = this.getMessagesScroller();
			if (!scroller) return;

			const remaining =
				scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
			const nearBottom = remaining < 64;

			if (nearBottom) {
				if (!this.autoScroll) {
					this.autoScroll = true;
					if (this.unseenMessages !== 0) this.unseenMessages = 0;
					const total = this.messages.length;
					if (this.renderEndIndex !== total) this.renderEndIndex = total;
					this.scrollToBottom({ force: true });
				} else if (this.unseenMessages !== 0) {
					this.unseenMessages = 0;
				}
			} else if (this.autoScroll) {
				this.autoScroll = false;
			}

			if (scroller.scrollTop < 80) {
				void this.maybeAutoLoadEarlier();
			}
		});
	};

	private async maybeAutoLoadEarlier() {
		const scroller = this.getMessagesScroller();
		if (!scroller) return;
		if (this.loadingEarlier) return;
		if (scroller.scrollTop > 120) return;

		const { start } = this.getRenderWindow();
		if (start <= 0) return;

		await this.loadEarlierMessages();
	}

	private jumpToLatest = () => {
		this.syncRenderWindowToBottom();
		this.scrollToBottom({ force: true });
	};

	private async loadEarlierMessages() {
		if (this.loadingEarlier) return;
		const { start, end } = this.getRenderWindow();
		if (start <= 0) return;

		this.loadingEarlier = true;
		const messagesEl = this.shadowRoot?.querySelector(
			".messages",
		) as HTMLElement | null;
		const prevScrollHeight = messagesEl?.scrollHeight ?? 0;
		const prevScrollTop = messagesEl?.scrollTop ?? 0;

		try {
			this.renderLimit = Math.min(end, this.renderLimit + 200);
			await this.updateComplete;

			if (!messagesEl) return;
			const nextScrollHeight = messagesEl.scrollHeight;
			const delta = Math.max(0, nextScrollHeight - prevScrollHeight);
			messagesEl.scrollTop = prevScrollTop + delta;
		} finally {
			this.loadingEarlier = false;
		}
	}

	private handleOpenAttachment = (
		e: CustomEvent<{ attachment?: Message["attachments"][number] }>,
	) => {
		const attachment = e.detail?.attachment ?? null;
		if (!attachment) return;
		this.attachmentViewerAttachment = attachment;
		this.attachmentViewerOpen = true;
	};

	private closeAttachmentViewer = () => {
		this.attachmentViewerOpen = false;
		this.attachmentViewerAttachment = null;
	};

	private handleAttachmentUpdated = (
		e: CustomEvent<{ attachmentId?: unknown; extractedText?: unknown }>,
	) => {
		const attachmentId = e.detail?.attachmentId;
		const extractedText = e.detail?.extractedText;
		if (typeof attachmentId !== "string" || attachmentId.length === 0) return;
		if (typeof extractedText !== "string" || extractedText.length === 0) return;

		this.messages = this.messages.map((msg) => {
			const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
			if (atts.length === 0) return msg;
			const nextAtts = atts.map((a) =>
				a?.id === attachmentId ? { ...a, extractedText } : a,
			);
			return { ...msg, attachments: nextAtts };
		});

		if (this.attachmentViewerAttachment?.id === attachmentId) {
			this.attachmentViewerAttachment = {
				...this.attachmentViewerAttachment,
				extractedText,
			};
		}
	};

	private getShareTokenFromLocation(): string | null {
		if (typeof window === "undefined") return null;
		try {
			const url = new URL(window.location.href);
			const match = /^\/share\/([^/]+)\/?$/.exec(url.pathname || "/");
			if (match?.[1]) return match[1];
			return (
				url.searchParams.get("share") ||
				url.searchParams.get("shareToken") ||
				url.searchParams.get("token")
			);
		} catch {
			return null;
		}
	}

	private async loadSharedSession(shareToken: string) {
		this.loading = true;
		this.error = null;
		try {
			const session = await this.apiClient.getSharedSession(shareToken);
			if (!session || !session.id) {
				throw new Error("Invalid shared session response");
			}
			this.currentSessionId = session.id;
			this.messages = Array.isArray(session.messages)
				? this.normalizeMessages(session.messages)
				: [];
			this.renderLimit = 200;
			this.syncRenderWindowToBottom();
			this.sessions = [];
			this.attachmentContentCache.clear();
			this.artifactsState = reconstructArtifactsFromMessages(this.messages);
			this.activeArtifact = null;
			this.artifactsOpen = false;
			this.error = null;
			this.requestUpdate();
			await this.updateComplete;
			this.scrollToBottom({ force: true });
		} catch (e) {
			console.error("Failed to load shared session:", e);
			this.error =
				e instanceof Error ? e.message : "Failed to load shared session";
			this.showToast(this.error, "error");
		} finally {
			this.loading = false;
		}
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
		const input = this.shadowRoot?.querySelector(
			"composer-input",
		) as ComposerInput | null;
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
		const shareToken = this.getShareTokenFromLocation();
		if (shareToken) {
			this.shareToken = shareToken;
			this.sidebarOpen = false;
			void this.loadSharedSession(shareToken);
		} else {
			this.loadCurrentModel();
			this.loadSessions();
			dataStore.ensureStatus(this.apiClient);
			dataStore.ensureModels(this.apiClient);
			dataStore.ensureUsage(this.apiClient);
			this.loadCommandPrefs();
		}
		this.hydrateDisplayPrefs();
		window.addEventListener("online", this.handleOnline);
		window.addEventListener("offline", this.handleOffline);
		window.addEventListener("keydown", this.handleKeydown);
		this.addEventListener(
			"open-attachment",
			this.handleOpenAttachment as EventListener,
		);
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		if (this.unsubscribeStore) this.unsubscribeStore();
		window.removeEventListener("online", this.handleOnline);
		window.removeEventListener("offline", this.handleOffline);
		window.removeEventListener("keydown", this.handleKeydown);
		this.removeEventListener(
			"open-attachment",
			this.handleOpenAttachment as EventListener,
		);
		const scroller = this.getMessagesScroller();
		scroller?.removeEventListener("scroll", this.handleMessagesScroll);
		if (this.messagesScrollRaf !== null) {
			if (window.cancelAnimationFrame) {
				window.cancelAnimationFrame(this.messagesScrollRaf);
			} else {
				window.clearTimeout(this.messagesScrollRaf);
			}
			this.messagesScrollRaf = null;
		}
		if (this.historyObserver) {
			try {
				this.historyObserver.disconnect();
			} catch {
				// ignore
			}
			this.historyObserver = null;
			this.observedHistoryEl = null;
		}
	}

	protected firstUpdated(): void {
		const scroller = this.getMessagesScroller();
		scroller?.addEventListener("scroll", this.handleMessagesScroll, {
			passive: true,
		});
		this.ensureHistoryObserver();
		this.refreshHistoryObserverTarget();

		if (this.renderEndIndex === 0) {
			this.renderEndIndex = this.messages.length;
		}
		this.lastMessagesLength = this.messages.length;
	}

	protected updated(changed: PropertyValues): void {
		super.updated(changed);
		this.ensureHistoryObserver();
		this.refreshHistoryObserverTarget();

		const total = this.messages.length;
		if (this.renderEndIndex > total) {
			this.renderEndIndex = total;
		}
		if (this.renderEndIndex === 0 && total > 0) {
			this.renderEndIndex = total;
		}

		if (changed.has("messages")) {
			const prev = changed.get("messages") as Message[] | undefined;
			const prevLen = Array.isArray(prev)
				? prev.length
				: this.lastMessagesLength;
			const nextLen = total;
			const delta = nextLen - prevLen;
			this.lastMessagesLength = nextLen;

			if (delta > 0) {
				if (this.autoScroll) {
					if (this.renderEndIndex !== nextLen) this.renderEndIndex = nextLen;
					if (this.unseenMessages !== 0) this.unseenMessages = 0;
				} else {
					this.unseenMessages += delta;
				}
			} else if (nextLen === 0) {
				this.unseenMessages = 0;
			}
		}

		if (this.autoScroll && this.renderEndIndex !== total) {
			this.renderEndIndex = total;
		}
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

	private coerceMessageContent(content: Message["content"]): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.filter((block) => block?.type === "text")
			.map((block) => (block?.type === "text" ? block.text : ""))
			.join("");
	}

	private normalizeMessage(message: Message): Message {
		if (typeof message.content === "string") return message;
		return {
			...message,
			content: this.coerceMessageContent(message.content),
		};
	}

	private normalizeMessages(messages: Message[]): Message[] {
		return messages.map((message) => this.normalizeMessage(message));
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
			| "share"
			| "settings"
			| "grid"
			| "file"
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
			share:
				"M18 8a3 3 0 1 0-2.83-4H15a3 3 0 0 0 0 6Zm-12 4a3 3 0 1 0 2.83 4H9a3 3 0 0 0 0-6Zm12 0a3 3 0 1 0 2.83 4H21a3 3 0 0 0 0-6Zm-4.59-1.51L8.59 15.5M15.41 8.5 8.59 11.5",
			settings:
				"M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.63a1 1 0 0 0 0-1.74l-1.17-.68a1 1 0 0 1-.46-.86l.05-1.35a1 1 0 0 0-1.17-1.01l-1.35.23a1 1 0 0 1-.9-.26L13.2 6a1 1 0 0 0-1.4 0l-.9.9a1 1 0 0 1-.9.26l-1.35-.23a1 1 0 0 0-1.17 1.01l.05 1.35a1 1 0 0 1-.46.86l-1.17.68a1 1 0 0 0 0 1.74l1.17.68a1 1 0 0 1 .46.86l-.05 1.35a1 1 0 0 0 1.17 1.01l1.35-.23a1 1 0 0 1 .9.26l.9.9a1 1 0 0 0 1.4 0l.9-.9a1 1 0 0 1 .9-.26l1.35.23a1 1 0 0 0 1.17-1.01l-.05-1.35a1 1 0 0 1 .46-.86Z",
			grid: "M4 4h7v7H4Zm9 0h7v7h-7ZM4 13h7v7H4Zm9 7v-7h7v7Z",
			file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
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

	private openShareDialog = async () => {
		if (this.shareToken) return;
		if (!this.currentSessionId) {
			this.showToast("Create or select a session first", "info", 1800);
			return;
		}
		this.shareDialogOpen = true;
		this.shareDialogError = null;
		this.shareResult = null;
	};

	private closeShareDialog = () => {
		this.shareDialogOpen = false;
		this.shareDialogLoading = false;
		this.shareDialogError = null;
		this.shareResult = null;
	};

	private createShareLink = async () => {
		if (!this.currentSessionId) return;
		this.shareDialogLoading = true;
		this.shareDialogError = null;
		try {
			const res = await this.apiClient.shareSession(this.currentSessionId, {
				expiresInHours: Math.min(168, Math.max(1, this.shareExpiresHours)),
				maxAccesses: this.shareMaxAccesses,
			});
			const webUrl = res.webShareUrl
				? new URL(res.webShareUrl, window.location.origin).toString()
				: new URL(
						`/share/${res.shareToken}`,
						window.location.origin,
					).toString();
			this.shareResult = {
				webShareUrl: webUrl,
				expiresAt: res.expiresAt,
				maxAccesses: res.maxAccesses,
			};
		} catch (e) {
			this.shareDialogError =
				e instanceof Error ? e.message : "Failed to create share link";
		} finally {
			this.shareDialogLoading = false;
		}
	};

	private copyShareLink = async () => {
		if (!this.shareResult) return;
		try {
			await navigator.clipboard.writeText(this.shareResult.webShareUrl);
			this.showToast("Share link copied", "success", 1500);
		} catch {
			this.showToast("Copy failed", "error", 1500);
		}
	};

	private openExportDialog = async () => {
		if (this.shareToken) return;
		if (!this.currentSessionId) {
			this.showToast("Create or select a session first", "info", 1800);
			return;
		}
		this.exportDialogOpen = true;
		this.exportDialogError = null;
		this.exportFormat = "json";
	};

	private closeExportDialog = () => {
		this.exportDialogOpen = false;
		this.exportDialogLoading = false;
		this.exportDialogError = null;
	};

	private exportSession = async () => {
		const sessionId = this.currentSessionId;
		if (!sessionId) return;
		this.exportDialogLoading = true;
		this.exportDialogError = null;
		try {
			const res = await this.apiClient.exportSession(sessionId, {
				format: this.exportFormat,
			});
			if (!res.ok) {
				throw new Error(`Export failed (${res.status} ${res.statusText})`);
			}
			const blob = await res.blob();
			const ext =
				this.exportFormat === "markdown"
					? "md"
					: this.exportFormat === "text"
						? "txt"
						: "json";
			const filename = `session-${sessionId}.${ext}`;
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			a.rel = "noopener";
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
			this.showToast("Export downloaded", "success", 1500);
			this.closeExportDialog();
		} catch (e) {
			this.exportDialogError = e instanceof Error ? e.message : "Export failed";
		} finally {
			this.exportDialogLoading = false;
		}
	};

	private toggleArtifactsPanel() {
		if (this.shareToken) {
			this.showToast("Shared sessions are read-only", "info", 1800);
			return;
		}
		this.artifactsOpen = !this.artifactsOpen;
	}

	private closeArtifactsPanel() {
		this.artifactsOpen = false;
	}

	private setActiveArtifact(filename: string) {
		if (this.shareToken) {
			this.showToast("Shared sessions are read-only", "info", 1800);
			return;
		}
		this.activeArtifact = filename;
		this.artifactsOpen = true;
	}

	private handleOpenArtifact = (e: Event) => {
		const evt = e as CustomEvent<{ filename?: unknown }>;
		const filename = evt.detail?.filename;
		if (typeof filename !== "string" || filename.trim().length === 0) return;
		e.stopPropagation();
		this.setActiveArtifact(filename);
	};

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
			this.messages = Array.isArray(session.messages)
				? this.normalizeMessages(session.messages)
				: [];
			this.renderLimit = 200;
			this.syncRenderWindowToBottom();
			this.attachmentContentCache.clear();
			this.artifactsState = createEmptyArtifactsState();
			this.activeArtifact = null;
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
				? this.normalizeMessages(session.messages)
				: [];
			this.renderLimit = 200;
			this.syncRenderWindowToBottom();
			this.attachmentContentCache.clear();
			this.artifactsState = reconstructArtifactsFromMessages(this.messages);
			this.activeArtifact = null;
			this.error = null;
			this.requestUpdate(); // Force update
			await this.updateComplete; // Wait for render
			this.scrollToBottom({ force: true });
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
				this.syncRenderWindowToBottom();
				this.renderLimit = 200;
				this.attachmentContentCache.clear();
			}
			await this.loadSessions();
			this.showToast("Session deleted", "success");
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Failed to delete session";
			this.showToast(msg, "error");
		}
	}

	private async ensureExtractedTextForAttachments(
		attachments: NonNullable<Message["attachments"]>,
	): Promise<NonNullable<Message["attachments"]>> {
		const out: NonNullable<Message["attachments"]> = [];
		for (const att of attachments) {
			if (!att || typeof att !== "object") continue;

			if (
				att.type !== "document" ||
				typeof att.extractedText === "string" ||
				typeof att.content !== "string" ||
				att.content.length === 0
			) {
				out.push(att);
				continue;
			}

			try {
				const res = await this.apiClient.extractAttachmentText({
					fileName: att.fileName,
					mimeType: att.mimeType,
					contentBase64: att.content,
				});
				out.push({
					...att,
					extractedText: res.extractedText || undefined,
				});
			} catch (e) {
				console.warn("Attachment extraction failed", e);
				out.push(att);
			}
		}
		return out;
	}

	private async hydrateAttachmentForRequest(
		att: NonNullable<Message["attachments"]>[number],
		sessionId: string,
	): Promise<NonNullable<Message["attachments"]>[number]> {
		if (!att?.id) return att;

		if (typeof att.content === "string" && att.content.length > 0) {
			if (!this.attachmentContentCache.has(att.id)) {
				this.attachmentContentCache.set(att.id, att.content);
			}
			return att;
		}

		if (!att.contentOmitted) return att;

		const cached = this.attachmentContentCache.get(att.id);
		if (cached) {
			return { ...att, content: cached, contentOmitted: undefined };
		}

		try {
			const base64 = await this.apiClient.getSessionAttachmentContentBase64(
				sessionId,
				att.id,
			);
			this.attachmentContentCache.set(att.id, base64);
			return { ...att, content: base64, contentOmitted: undefined };
		} catch (e) {
			console.warn("Failed to hydrate attachment content", e);
			return att;
		}
	}

	private async buildMessagesForChatRequest(
		messages: Message[],
	): Promise<Message[]> {
		const sessionId = this.currentSessionId;
		if (!sessionId) return messages;

		const out: Message[] = [];
		for (const msg of messages) {
			const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
			if (msg.role !== "user" || atts.length === 0) {
				out.push(msg);
				continue;
			}

			const hydrated = await Promise.all(
				atts.map((a) => this.hydrateAttachmentForRequest(a, sessionId)),
			);
			out.push({ ...msg, attachments: hydrated });
		}
		return out;
	}

	private async handleSubmit(
		event: CustomEvent<{
			text: string;
			retry?: boolean;
			attachments?: Message["attachments"];
		}>,
	) {
		const text = event.detail.text.trim();
		const attachments =
			Array.isArray(event.detail.attachments) && event.detail.attachments.length
				? event.detail.attachments
				: undefined;
		if ((!text && !attachments) || this.loading || !this.clientOnline) {
			return;
		}
		if (this.shareToken) {
			this.showToast("Shared sessions are read-only", "info", 1800);
			return;
		}
		this.lastSendFailed = null;
		this.lastApiError = null;

		const enrichedAttachments = attachments
			? await this.ensureExtractedTextForAttachments(attachments)
			: undefined;

		// Add user message unless reusing the existing one for a retry
		if (!event.detail.retry) {
			const userMessage: Message = {
				role: "user",
				content: text,
				attachments: enrichedAttachments,
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

		// Ensure the user sees the newly appended messages immediately, and keep the
		// rendered window anchored to the bottom while streaming.
		this.autoScroll = true;
		this.unseenMessages = 0;
		this.renderEndIndex = this.messages.length;
		this.lastMessagesLength = this.messages.length;
		this.scrollToBottom({ force: true });

		// Track active tool calls
		const activeTools = new Map<string, ActiveToolInfo>();
		const thinkingBlocks = new Map<number, string>();
		let currentThinkingIndex: number | null = null;

		try {
			const requestMessages = await this.buildMessagesForChatRequest(
				this.messages.slice(0, -1), // Exclude placeholder
			);

			// Stream response with FULL events
			const stream = this.apiClient.chatWithEvents({
				model: this.currentModel,
				messages: requestMessages,
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
							if (msgEvent.type === "text_delta") {
								if (typeof assistantMessage.content !== "string") {
									assistantMessage.content = this.coerceMessageContent(
										assistantMessage.content,
									);
								}
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
							else if (msgEvent.type === "toolcall_start") {
								const partial = Array.isArray(msgEvent.partial.content)
									? msgEvent.partial.content[msgEvent.contentIndex]
									: undefined;
								if (partial?.type === "toolCall" && partial.id) {
									const args = partial.arguments ?? {};
									const name = partial.name || "tool";
									if (!assistantMessage.tools) assistantMessage.tools = [];
									const existingIndex = assistantMessage.tools.findIndex(
										(t) => t.toolCallId === partial.id,
									);
									const entry: ExtendedToolCall = {
										toolCallId: partial.id,
										name,
										status: "pending",
										args,
										startTime: Date.now(),
									};
									if (existingIndex >= 0) {
										assistantMessage.tools[existingIndex] = {
											...assistantMessage.tools[existingIndex],
											...entry,
										};
									} else {
										assistantMessage.tools.push(entry);
									}
									activeTools.set(partial.id, {
										name,
										args,
										index:
											existingIndex >= 0
												? existingIndex
												: assistantMessage.tools.length - 1,
									});
									this.messages = [...this.messages];
								}
							} else if (msgEvent.type === "toolcall_delta") {
								const partial = Array.isArray(msgEvent.partial.content)
									? msgEvent.partial.content[msgEvent.contentIndex]
									: undefined;
								if (partial?.type === "toolCall" && partial.id) {
									const args = partial.arguments ?? {};
									if (!assistantMessage.tools) assistantMessage.tools = [];
									const existingIndex = assistantMessage.tools.findIndex(
										(t) => t.toolCallId === partial.id,
									);
									if (existingIndex >= 0) {
										assistantMessage.tools[existingIndex] = {
											...assistantMessage.tools[existingIndex],
											args,
											status: "pending",
										};
									} else {
										assistantMessage.tools.push({
											toolCallId: partial.id,
											name: partial.name || "tool",
											status: "pending",
											args,
										});
									}
									activeTools.set(partial.id, {
										name: partial.name || "tool",
										args,
										index:
											existingIndex >= 0
												? existingIndex
												: assistantMessage.tools.length - 1,
									});
									this.messages = [...this.messages];
								}
							} else if (msgEvent.type === "toolcall_end") {
								const toolCall = msgEvent.toolCall;
								if (!assistantMessage.tools) assistantMessage.tools = [];
								const existingIndex = assistantMessage.tools.findIndex(
									(t) => t.toolCallId === toolCall.id,
								);
								const extendedTool: ExtendedToolCall = {
									toolCallId: toolCall.id,
									name: toolCall.name,
									status: "pending",
									args: toolCall.arguments,
								};
								if (existingIndex >= 0) {
									assistantMessage.tools[existingIndex] = {
										...assistantMessage.tools[existingIndex],
										...extendedTool,
									};
								} else {
									assistantMessage.tools.push(extendedTool);
								}
								activeTools.set(toolCall.id, {
									name: toolCall.name,
									args: toolCall.arguments,
									index:
										existingIndex >= 0
											? existingIndex
											: assistantMessage.tools.length - 1,
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

					case "client_tool_request": {
						if (agentEvent.toolName === "artifacts") {
							const args = coerceArtifactsArgs(agentEvent.args);
							if (args.command === "logs" && args.filename) {
								const sandboxId = `artifact:${args.filename}`;
								const snap = getSandboxConsoleSnapshot(sandboxId);
								const logs = snap?.logs ?? [];
								const error = snap?.lastError ?? null;
								const text = (() => {
									if (logs.length === 0 && !error) {
										return `No logs captured for ${args.filename}. Open the artifact preview to generate logs.`;
									}
									const lines: string[] = [`Logs for ${args.filename}`, ""];
									for (const l of logs) {
										lines.push(`[${l.level}] ${l.text}`);
									}
									if (error) {
										lines.push("", "Last error:", error.message);
										if (error.stack) lines.push(error.stack);
									}
									return lines.filter(Boolean).join("\n");
								})();
								await this.apiClient.sendClientToolResult({
									toolCallId: agentEvent.toolCallId,
									content: [{ type: "text", text }],
									isError: false,
								});
								break;
							}
							const result = applyArtifactsCommand(this.artifactsState, args);
							this.artifactsState = result.state;
							if (!result.isError && args.filename) {
								this.setActiveArtifact(args.filename);
							}
							await this.apiClient.sendClientToolResult({
								toolCallId: agentEvent.toolCallId,
								content: [{ type: "text", text: result.output }],
								isError: result.isError,
							});
						} else if (agentEvent.toolName === "javascript_repl") {
							const res = await this.runJavascriptRepl(agentEvent.args);
							await this.apiClient.sendClientToolResult({
								toolCallId: agentEvent.toolCallId,
								content: [{ type: "text", text: res.text }],
								isError: res.isError,
							});
						} else {
							await this.apiClient.sendClientToolResult({
								toolCallId: agentEvent.toolCallId,
								content: [
									{
										type: "text",
										text: `Unsupported client tool: ${agentEvent.toolName}`,
									},
								],
								isError: true,
							});
						}
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

				if (this.autoScroll) this.scrollToBottom();
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

	private async runJavascriptRepl(args: unknown): Promise<{
		isError: boolean;
		text: string;
	}> {
		const obj = (
			args && typeof args === "object" ? (args as Record<string, unknown>) : {}
		) as Record<string, unknown>;
		const code = typeof obj.code === "string" ? obj.code : "";
		const timeoutMs =
			typeof obj.timeoutMs === "number" && Number.isFinite(obj.timeoutMs)
				? obj.timeoutMs
				: 10_000;

		if (!code.trim()) {
			return { isError: true, text: "Error: javascript_repl requires code" };
		}

		const sandboxId = `repl:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

		let settled = false;
		let returnValue: string | null = null;
		let error: { message: string; stack?: string } | null = null;

		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});

		const consumer = {
			handleMessage: async (message: unknown) => {
				if (settled || !message || typeof message !== "object") return;
				const m = message as Record<string, unknown>;
				if (m.type === "execution-complete") {
					settled = true;
					returnValue =
						typeof m.returnValue === "string"
							? m.returnValue
							: String(m.returnValue ?? "");
					resolveDone();
				}
				if (m.type === "execution-error") {
					settled = true;
					const err = m.error;
					if (err && typeof err === "object") {
						const rec = err as Record<string, unknown>;
						error = {
							message:
								typeof rec.message === "string"
									? rec.message
									: "Execution error",
							stack: typeof rec.stack === "string" ? rec.stack : undefined,
						};
					} else {
						error = { message: "Execution error" };
					}
					resolveDone();
				}
			},
		};

		const el = document.createElement(
			"composer-sandboxed-iframe",
		) as unknown as HTMLElement & {
			sandboxId: string;
			htmlContent: string;
			providers: unknown[];
			consumers: unknown[];
		};

		el.style.position = "fixed";
		el.style.left = "-99999px";
		el.style.top = "-99999px";
		el.style.width = "1px";
		el.style.height = "1px";
		el.style.opacity = "0";
		el.style.pointerEvents = "none";

		el.sandboxId = sandboxId;
		el.htmlContent = "<!doctype html><html><body></body></html>";

		const artifactsProvider = new ArtifactsRuntimeProvider(
			() => this.getArtifactsList(),
			{
				createOrUpdate: async (filename, content) => {
					const exists = this.artifactsState.byFilename.has(filename);
					const cmd = exists ? "rewrite" : "create";
					const res = applyArtifactsCommand(this.artifactsState, {
						command: cmd,
						filename,
						content,
					});
					this.artifactsState = res.state;
					if (!res.isError) {
						this.setActiveArtifact(filename);
					}
				},
				delete: async (filename) => {
					const res = applyArtifactsCommand(this.artifactsState, {
						command: "delete",
						filename,
					});
					this.artifactsState = res.state;
					if (this.activeArtifact === filename) {
						this.activeArtifact = null;
					}
				},
			},
		);

		const attachmentsForSandbox = await (async () => {
			const list = this.getAllAttachments();
			const sessionId = this.currentSessionId;
			if (!sessionId) return list;
			return await Promise.all(
				list.map((a) =>
					this.hydrateAttachmentForRequest(
						a as NonNullable<Message["attachments"]>[number],
						sessionId,
					),
				),
			);
		})();

		el.providers = [
			artifactsProvider,
			new AttachmentsRuntimeProvider(
				attachmentsForSandbox
					.filter((a) => typeof a.content === "string" && a.content.length > 0)
					.map((a) => ({
						id: a.id,
						fileName: a.fileName,
						mimeType: a.mimeType,
						size: a.size,
						content: a.content as string,
						extractedText: a.extractedText,
					})),
			),
			new FileDownloadRuntimeProvider(),
			new JavascriptReplRuntimeProvider(code, { timeoutMs }),
		];
		el.consumers = [consumer];

		document.body.appendChild(el);

		const hardTimeout = window.setTimeout(() => {
			if (settled) return;
			settled = true;
			error = { message: "Execution timed out" };
			resolveDone();
		}, timeoutMs + 200);

		try {
			await done;
		} finally {
			window.clearTimeout(hardTimeout);
			try {
				el.remove();
			} catch {
				// ignore
			}
		}

		const snap = getSandboxConsoleSnapshot(sandboxId);
		const logs = snap?.logs ?? [];
		const lastError = snap?.lastError ?? null;
		const downloads = getSandboxDownloadsSnapshot(sandboxId)?.files ?? [];

		const lines: string[] = [];
		if (error) {
			lines.push(`Error: ${error.message}`);
			if (error.stack) lines.push(error.stack);
		} else if (returnValue !== null) {
			lines.push("Return value:");
			lines.push(returnValue);
		} else {
			lines.push("No return value.");
		}

		if (logs.length > 0) {
			lines.push("", "Console:");
			for (const l of logs) {
				lines.push(`[${l.level}] ${l.text}`);
			}
		}

		if (!error && lastError) {
			lines.push("", "Last error:");
			lines.push(lastError.message);
			if (lastError.stack) lines.push(lastError.stack);
		}

		if (downloads.length > 0) {
			lines.push("", "Downloads:");
			for (const f of downloads) {
				lines.push(`- ${f.fileName} (${f.mimeType})`);
			}
		}

		return { isError: Boolean(error), text: lines.filter(Boolean).join("\n") };
	}

	private retryLastSend = () => {
		if (!this.lastSendFailed) return;
		this.handleSubmit(
			new CustomEvent("submit", {
				detail: { text: this.lastSendFailed, retry: true },
			}),
		);
	};

	private scrollToBottom(options?: { force?: boolean }) {
		if (!options?.force && !this.autoScroll) return;
		this.updateComplete.then(() => {
			const messagesEl = this.getMessagesScroller();
			if (!messagesEl) return;
			messagesEl.scrollTop = messagesEl.scrollHeight;
		});
	}

	private getArtifactsList(): Artifact[] {
		return Array.from(this.artifactsState.byFilename.values()).sort((a, b) =>
			a.filename.localeCompare(b.filename),
		);
	}

	private getAllAttachments(): NonNullable<Message["attachments"]> {
		const byId = new Map<string, Message["attachments"][number]>();

		for (const msg of this.messages) {
			if (msg.role !== "user") continue;
			const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
			for (const a of attachments) {
				if (!a || typeof a !== "object") continue;
				const id = typeof a.id === "string" ? a.id : "";
				if (!id) continue;

				const existing = byId.get(id);
				if (!existing) {
					byId.set(id, a);
					continue;
				}

				byId.set(id, {
					...existing,
					...a,
					content: a.content ?? existing.content,
					preview: a.preview ?? existing.preview,
					extractedText: a.extractedText ?? existing.extractedText,
				});
			}
		}

		return Array.from(byId.values()).map((a) => {
			if (typeof a.content === "string" && a.content.length > 0) return a;
			if (!a.contentOmitted) return a;
			const cached = this.attachmentContentCache.get(a.id);
			return cached ? { ...a, content: cached, contentOmitted: undefined } : a;
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
		const taskHealth = this.status?.backgroundTasks;
		const taskRunning = taskHealth?.running ?? 0;
		const taskFailed = taskHealth?.failed ?? 0;
		const isShared = Boolean(this.shareToken);
		const showSessionGallery =
			!isShared && this.messages.length === 0 && this.sessions.length > 0;
		const hasMessages = this.messages.length > 0;
		const {
			start: windowStart,
			end: windowEnd,
			total: totalMessages,
		} = this.getRenderWindow();
		const visibleMessages = this.messages.slice(windowStart, windowEnd);
		const hiddenOldCount = windowStart;
		const hiddenNewCount = totalMessages - windowEnd;
		const renderedMessages = visibleMessages.map(
			(msg) => html`
				<composer-message
					role=${msg.role}
					content=${msg.content}
					timestamp=${msg.timestamp || ""}
					.attachments=${msg.attachments || []}
					.thinking=${(msg as MessageWithThinking).thinking || ""}
					.tools=${msg.tools || []}
					.compact=${this.compactMode}
					.reducedMotion=${this.reducedMotion}
				></composer-message>
			`,
		);
		const recentSessions = showSessionGallery ? this.sessions.slice(0, 8) : [];
		const sessionLoading = this.loading && this.messages.length === 0;
		const lastUpdated = this.status?.lastUpdated ?? null;

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
			<composer-attachment-viewer
				.open=${this.attachmentViewerOpen}
				.attachment=${this.attachmentViewerAttachment}
				.apiEndpoint=${this.apiClient?.baseUrl || this.apiEndpoint}
				.sessionId=${isShared ? null : this.currentSessionId}
				.shareToken=${this.shareToken}
				@attachment-updated=${this.handleAttachmentUpdated}
				@close=${this.closeAttachmentViewer}
			></composer-attachment-viewer>
			${
				isShared
					? html`<div class="banner info">
							Shared session — read-only.
							<button
								class="icon-btn"
								@click=${async () => {
									try {
										await navigator.clipboard.writeText(window.location.href);
										this.showToast("Link copied", "success", 1500);
									} catch {
										this.showToast("Copy failed", "error", 1500);
									}
								}}
							>
								Copy link
							</button>
						</div>`
					: ""
			}
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
			${
				isShared
					? html`<div class="sidebar ${this.sidebarOpen ? "" : "collapsed"}">
							<div class="sidebar-header">
								<h2>Shared</h2>
								<button
									class="new-session-btn"
									@click=${() => {
										window.location.href = "/";
									}}
								>
									Exit
								</button>
							</div>
							<div class="sessions-list">
								<div class="loading">Read-only shared session</div>
							</div>
						</div>`
					: html`<div class="sidebar ${this.sidebarOpen ? "" : "collapsed"}">
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
										const value = (
											e.target as HTMLInputElement
										).value.toLowerCase();
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
						</div>`
			}

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
						<button
							class="icon-btn"
							title=${isShared ? "Shared sessions are read-only" : "Share session"}
							@click=${this.openShareDialog}
							?disabled=${isShared || !this.currentSessionId}
						>
							${this.renderIcon("share")}
						</button>
						<button
							class="icon-btn"
							title=${isShared ? "Shared sessions are read-only" : "Export session"}
							@click=${this.openExportDialog}
							?disabled=${isShared || !this.currentSessionId}
						>
							⤓
						</button>
						<button class="icon-btn" title="Settings" @click=${this.toggleSettings}>${this.renderIcon("settings")}</button>
						<button class="icon-btn" title="Admin Settings" @click=${this.toggleAdminSettings}>🛡️</button>
						<button
							class="icon-btn ${this.artifactsOpen ? "active" : ""}"
							title=${isShared ? "Shared sessions are read-only" : "Artifacts"}
							@click=${this.toggleArtifactsPanel}
							?disabled=${isShared}
						>
							${this.renderIcon("file")}
						</button>
						<button class="icon-btn ${this.compactMode ? "active" : ""}" title="Toggle compact layout (Ctrl/Cmd+M)" @click=${this.toggleCompact}>${this.renderIcon("grid")}</button>
						<button class="icon-btn ${this.reducedMotion ? "active" : ""}" title="Toggle reduced motion" @click=${this.toggleReducedMotion}>${this.renderIcon("reduce")}</button>
					</div>
				</div>

				${this.error ? html`<div class="error">${this.error}</div>` : ""}

				<div
					class="messages ${this.compactMode ? "compact" : ""}"
					@open-artifact=${this.handleOpenArtifact}
				>
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
								: html`
										${
											hiddenOldCount > 0
												? html`
														<div class="history-truncation" data-history-truncation>
															Showing ${renderedMessages.length} of ${totalMessages}${
																hiddenNewCount > 0
																	? ` (+${hiddenNewCount} newer hidden)`
																	: ""
															}.
															<button
																class="history-btn"
																@click=${this.loadEarlierMessages}
																?disabled=${this.loadingEarlier}
															>
																${this.loadingEarlier ? "Loading..." : "Load earlier"}
															</button>
														</div>
													`
												: ""
										}
										${renderedMessages}
										${
											this.unseenMessages > 0
												? html`
													<button class="jump-latest" @click=${this.jumpToLatest}>
														${this.unseenMessages} new message${this.unseenMessages === 1 ? "" : "s"} — Jump to latest
													</button>
												`
												: ""
										}
									`
						}
					${this.loading ? html`<div class="loading">Processing...</div>` : ""}
				</div>

				<div class="input-container">
					<composer-input
						@submit=${this.handleSubmit}
						?disabled=${this.loading || isShared}
					></composer-input>
				</div>

				${
					this.artifactsOpen && !isShared
						? html`
							<composer-artifacts-panel
								.artifacts=${this.getArtifactsList()}
								.activeFilename=${this.activeArtifact}
								.sessionId=${this.currentSessionId}
								.apiBaseUrl=${this.apiClient.baseUrl}
								.attachments=${this.getAllAttachments()}
								@close=${this.closeArtifactsPanel}
								@select-artifact=${(e: CustomEvent<{ filename: string }>) =>
									this.setActiveArtifact(e.detail.filename)}
							></composer-artifacts-panel>
					  `
						: ""
				}
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
				this.shareDialogOpen
					? html`
						<div class="modal-overlay" @click=${this.closeShareDialog}>
							<div class="modal-dialog" @click=${(e: Event) => e.stopPropagation()}>
								<div class="modal-title">Share session</div>
								<div class="modal-row">
									<label for="share-exp">Expires (hours)</label>
									<input
										id="share-exp"
										type="number"
										min="1"
										max="168"
										.value=${String(this.shareExpiresHours)}
										@input=${(e: Event) => {
											const raw = (e.target as HTMLInputElement).value;
											const n = Number.parseInt(raw, 10);
											this.shareExpiresHours = Number.isFinite(n) ? n : 24;
										}}
									/>
								</div>
								<div class="modal-row">
									<label for="share-max">Max opens</label>
									<input
										id="share-max"
										type="number"
										min="1"
										.value=${this.shareMaxAccesses === null ? "" : String(this.shareMaxAccesses)}
										placeholder="Unlimited"
										@input=${(e: Event) => {
											const raw = (e.target as HTMLInputElement).value.trim();
											if (!raw) {
												this.shareMaxAccesses = null;
												return;
											}
											const n = Number.parseInt(raw, 10);
											this.shareMaxAccesses = Number.isFinite(n) ? n : 100;
										}}
									/>
								</div>

								${
									this.shareResult
										? html`
											<div class="modal-row">
												<label>Link</label>
												<input type="text" readonly .value=${this.shareResult.webShareUrl} />
											</div>
											<div class="modal-help">
												Expires at ${new Date(this.shareResult.expiresAt).toLocaleString()}${
													this.shareResult.maxAccesses === null
														? " • unlimited opens"
														: ` • max ${this.shareResult.maxAccesses} opens`
												}
											</div>
										`
										: html`<div class="modal-help">
												Generates a read-only link for viewing this session in the web UI.
											</div>`
								}

								${this.shareDialogError ? html`<div class="modal-error">${this.shareDialogError}</div>` : ""}

								<div class="modal-actions">
									<button class="modal-btn" @click=${this.closeShareDialog}>Close</button>
									${
										this.shareResult
											? html`
												<button
													class="modal-btn primary"
													@click=${this.copyShareLink}
													?disabled=${this.shareDialogLoading}
												>
													Copy
												</button>
											`
											: html`
												<button
													class="modal-btn primary"
													@click=${this.createShareLink}
													?disabled=${this.shareDialogLoading}
												>
													${this.shareDialogLoading ? "Creating..." : "Create link"}
												</button>
											`
									}
								</div>
							</div>
						</div>
				  `
					: ""
			}

			${
				this.exportDialogOpen
					? html`
						<div class="modal-overlay" @click=${this.closeExportDialog}>
							<div class="modal-dialog" @click=${(e: Event) => e.stopPropagation()}>
								<div class="modal-title">Export session</div>
								<div class="modal-row">
									<label for="export-format">Format</label>
									<select
										id="export-format"
										.value=${this.exportFormat}
										@change=${(e: Event) => {
											const v = (e.target as HTMLSelectElement).value;
											this.exportFormat =
												v === "markdown" || v === "text" ? v : "json";
										}}
									>
										<option value="json">JSON</option>
										<option value="markdown">Markdown</option>
										<option value="text">Text</option>
									</select>
								</div>

								<div class="modal-help">
									Downloads the full session including attachment content.
								</div>

								${this.exportDialogError ? html`<div class="modal-error">${this.exportDialogError}</div>` : ""}

								<div class="modal-actions">
									<button class="modal-btn" @click=${this.closeExportDialog}>Close</button>
									<button
										class="modal-btn primary"
										@click=${this.exportSession}
										?disabled=${this.exportDialogLoading}
									>
										${this.exportDialogLoading ? "Exporting..." : "Download"}
									</button>
								</div>
							</div>
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
