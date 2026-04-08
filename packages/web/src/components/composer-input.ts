/**
 * Message input component
 */

import type { ComposerAttachment } from "@evalops/contracts";
import { LitElement, type PropertyValues, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ApiClient, type McpServerStatus } from "../services/api-client.js";
import {
	WEB_SLASH_COMMANDS,
	type WebSlashCommand,
	isWebSlashCommandSupported,
} from "./slash-commands.js";

type SpeechRecognitionConstructor = new () => SpeechRecognition;

interface SpeechRecognitionEvent extends Event {
	resultIndex: number;
	results: SpeechRecognitionResultList;
}

interface SpeechRecognition extends EventTarget {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((event: SpeechRecognitionEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
	onend: ((event: Event) => void) | null;
	start(): void;
	stop(): void;
}

type MentionStatus = {
	kind: "loading" | "error";
	message: string;
};

interface McpToolItem {
	id: string;
	server: string;
	tool: string;
	label: string;
	description?: string;
	badge: string;
}

function sanitizeMcpName(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function buildMcpToolName(server: string, tool: string): string {
	return `mcp__${sanitizeMcpName(server)}__${tool}`;
}

function getMcpBadge(
	server: Pick<McpServerStatus, "scope" | "transport" | "remoteTrust">,
): string {
	if (server.scope) {
		return server.scope;
	}
	if (server.remoteTrust === "official") {
		return "official";
	}
	return server.transport === "stdio" ? "stdio" : "remote";
}

declare global {
	interface Window {
		SpeechRecognition?: SpeechRecognitionConstructor;
		webkitSpeechRecognition?: SpeechRecognitionConstructor;
	}
}

@customElement("composer-input")
export class ComposerInput extends LitElement {
	static override styles = css`
		:host {
			display: block;
		}

		.input-container {
			position: relative;
		}

		.input-wrapper {
			display: flex;
			gap: 0.75rem;
			align-items: flex-end;
			position: relative;
			background: var(--bg-primary, #0c0d0f);
			border: 1px solid var(--border-primary, #1e2023);
			padding: 0.75rem;
		}

		.input-wrapper:focus-within {
			border-color: var(--accent-amber, #d4a012);
			box-shadow: 0 0 0 1px var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
		}

		.input-wrapper.recording {
			border-color: var(--accent-red, #ef4444);
			box-shadow: 0 0 0 1px rgba(239, 68, 68, 0.25);
		}

		textarea {
			flex: 1;
			min-height: 24px;
			max-height: 200px;
			padding: 0;
			border: none;
			background: transparent;
			color: var(--text-primary, #e8e9eb);
			font-family: var(--font-mono, "JetBrains Mono", monospace);
			font-size: 0.85rem;
			resize: none;
			outline: none;
			line-height: 1.6;
		}

		textarea:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		textarea::placeholder {
			color: var(--text-tertiary, #5c5e62);
		}

		.char-count {
			position: absolute;
			bottom: 0.75rem;
			right: 6rem;
			font-family: var(--font-mono, monospace);
			font-size: 0.6rem;
			color: var(--text-tertiary, #5c5e62);
			pointer-events: none;
			opacity: 0;
			transition: opacity 0.15s ease;
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.input-wrapper:focus-within .char-count {
			opacity: 1;
		}

		.char-count.warning {
			color: var(--accent-yellow, #eab308);
		}

		.char-count.error {
			color: var(--accent-red, #ef4444);
		}

		button {
			padding: 0.5rem 1rem;
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
			color: var(--accent-amber, #d4a012);
			border: none;
			font-family: var(--font-mono, monospace);
			font-size: 0.65rem;
			font-weight: 600;
			cursor: pointer;
			transition: all 0.15s ease;
			white-space: nowrap;
			text-transform: uppercase;
			letter-spacing: 0.08em;
		}

		button:hover:not(:disabled) {
			background: var(--accent-amber, #d4a012);
			color: var(--bg-deep, #08090a);
		}

		button:disabled {
			opacity: 0.3;
			cursor: not-allowed;
		}

		.hint {
			font-family: var(--font-mono, monospace);
			font-size: 0.6rem;
			color: var(--text-tertiary, #5c5e62);
			margin-top: 0.75rem;
			display: flex;
			align-items: center;
			gap: 0.75rem;
		}

		.hint kbd {
			padding: 0.15rem 0.4rem;
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-primary, #1e2023);
			font-family: inherit;
			font-size: 0.6rem;
			font-weight: 600;
			color: var(--text-secondary, #8b8d91);
		}

		.actions {
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}

		.attach-button {
			width: 34px;
			height: 34px;
			padding: 0;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			background: transparent;
			border: 1px solid var(--border-primary, #1e2023);
			color: var(--text-tertiary, #5c5e62);
			cursor: pointer;
			transition: all 0.15s ease;
		}

		.attach-button:hover:not(:disabled) {
			background: var(--bg-elevated, #161719);
			color: var(--text-primary, #e8e9eb);
		}

		.voice-button {
			width: 34px;
			height: 34px;
			padding: 0;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			background: transparent;
			border: 1px solid var(--border-primary, #1e2023);
			color: var(--text-tertiary, #5c5e62);
			cursor: pointer;
			transition: all 0.15s ease;
		}

		.voice-button:hover:not(:disabled) {
			background: var(--bg-elevated, #161719);
			color: var(--text-primary, #e8e9eb);
		}

		.voice-button.active {
			border-color: var(--accent-red, #ef4444);
			color: var(--accent-red, #ef4444);
			background: rgba(239, 68, 68, 0.08);
		}

		.mcp-button {
			width: 34px;
			height: 34px;
			padding: 0;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			background: transparent;
			border: 1px solid var(--border-primary, #1e2023);
			color: var(--text-tertiary, #5c5e62);
			cursor: pointer;
			transition: all 0.15s ease;
			font-size: 0.52rem;
			letter-spacing: 0.04em;
		}

		.mcp-button:hover:not(:disabled),
		.mcp-button.active {
			background: var(--bg-elevated, #161719);
			color: var(--text-primary, #e8e9eb);
		}

		.attachments {
			display: flex;
			flex-wrap: wrap;
			gap: 0.5rem;
			margin-top: 0.75rem;
		}

		.attachment-tile {
			position: relative;
			width: 48px;
			height: 48px;
			border: 1px solid var(--border-primary, #1e2023);
			background: var(--bg-elevated, #161719);
			overflow: hidden;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			color: var(--text-secondary, #8b8d91);
			font-family: var(--font-mono, monospace);
			font-size: 0.6rem;
		}

		.attachment-tile img {
			width: 100%;
			height: 100%;
			object-fit: cover;
			display: block;
		}

		.attachment-remove {
			position: absolute;
			top: -8px;
			right: -8px;
			width: 20px;
			height: 20px;
			border-radius: 999px;
			border: 1px solid var(--border-primary, #1e2023);
			background: var(--bg-deep, #08090a);
			color: var(--text-tertiary, #5c5e62);
			cursor: pointer;
			display: inline-flex;
			align-items: center;
			justify-content: center;
		}

		.attachment-remove:hover {
			background: var(--bg-elevated, #161719);
			color: var(--text-primary, #e8e9eb);
		}

		.suggestions {
			position: absolute;
			bottom: 100%;
			left: 0;
			right: 0;
			background: var(--bg-secondary, #161b22);
			border: 1px solid var(--border-primary, #1e2023);
			border-bottom: none;
			max-height: 200px;
			overflow-y: auto;
			z-index: 100;
			margin-bottom: 0.5rem;
			border-radius: 4px;
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
			display: flex;
			flex-direction: column;
		}

		.suggestion-item {
			padding: 0.5rem 0.75rem;
			cursor: pointer;
			color: var(--text-primary, #e8e9eb);
			font-family: var(--font-mono, monospace);
			font-size: 0.8rem;
			border-bottom: 1px solid var(--border-dim, rgba(30, 32, 35, 0.5));
		}

		.suggestion-item:last-child {
			border-bottom: none;
		}

		.suggestion-item:hover, .suggestion-item.selected {
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
			color: var(--accent-amber, #d4a012);
		}

		.suggestion-meta {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 0.75rem;
		}

		.suggestion-main {
			display: flex;
			flex-direction: column;
			gap: 0.2rem;
			min-width: 0;
		}

		.suggestion-label {
			font-weight: 600;
		}

		.suggestion-subtitle {
			font-size: 0.68rem;
			color: var(--text-tertiary, #6b7280);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.suggestion-badge {
			border: 1px solid var(--border-primary, #1e2023);
			background: var(--bg-elevated, #161719);
			color: var(--text-secondary, #9ca3af);
			padding: 0.12rem 0.42rem;
			font-size: 0.62rem;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			flex-shrink: 0;
		}

		.suggestion-description {
			margin-top: 0.28rem;
			font-size: 0.72rem;
			color: var(--text-secondary, #9ca3af);
			line-height: 1.45;
		}

		.suggestion-empty {
			padding: 0.75rem;
			color: var(--text-secondary, #9ca3af);
			font-family: var(--font-mono, monospace);
			font-size: 0.75rem;
		}

		.mention-status {
			position: absolute;
			bottom: 100%;
			left: 0;
			right: 0;
			margin-bottom: 0.5rem;
			padding: 0.55rem 0.75rem;
			background: var(--bg-secondary, #161b22);
			border: 1px solid var(--border-primary, #1e2023);
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
			color: var(--text-secondary, #9ca3af);
			font-family: var(--font-mono, monospace);
			font-size: 0.75rem;
			z-index: 95;
		}

		.mention-status.error {
			border-color: rgba(239, 68, 68, 0.4);
			color: var(--accent-red, #ef4444);
		}

		.slash-hint {
			position: absolute;
			bottom: 100%;
			left: 0;
			right: 0;
			margin-bottom: 0.35rem;
			padding: 0.5rem 0.75rem;
			border: 1px solid var(--border-primary, #1e2023);
			background: var(--bg-secondary, #161b22);
			box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
			border-radius: 4px;
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 0.75rem;
			font-family: var(--font-mono, monospace);
			color: var(--text-primary, #e8e9eb);
			z-index: 90;
		}

		.slash-hint .meta {
			display: flex;
			flex-direction: column;
			gap: 0.2rem;
			min-width: 0;
		}

		.slash-hint .name {
			font-weight: 700;
			font-size: 0.85rem;
		}

		.slash-hint .desc {
			color: var(--text-secondary, #9ca3af);
			font-size: 0.75rem;
		}

		.slash-hint .usage {
			color: var(--text-tertiary, #6b7280);
			font-size: 0.72rem;
		}

		.slash-hint .tags {
			display: flex;
			gap: 0.35rem;
			flex-wrap: wrap;
			font-size: 0.62rem;
			color: var(--accent-amber, #d4a012);
		}

		.slash-hint .controls {
			display: inline-flex;
			align-items: center;
			gap: 0.35rem;
			font-size: 0.65rem;
			color: var(--text-tertiary, #6b7280);
			white-space: nowrap;
		}

		.slash-hint kbd {
			padding: 0.15rem 0.4rem;
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-primary, #1e2023);
			font-family: inherit;
			font-size: 0.62rem;
			font-weight: 600;
			color: var(--text-secondary, #8b8d91);
		}

		.prompt-suggestion {
			margin-bottom: 0.35rem;
			padding: 0.6rem 0.75rem;
			border: 1px solid var(--border-primary, #1e2023);
			background: var(--bg-secondary, #161b22);
			box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
			border-radius: 4px;
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 0.75rem;
			font-family: var(--font-mono, monospace);
		}

		.prompt-suggestion-copy {
			display: flex;
			flex-direction: column;
			gap: 0.25rem;
			min-width: 0;
		}

		.prompt-suggestion-label {
			font-size: 0.62rem;
			text-transform: uppercase;
			letter-spacing: 0.12em;
			color: var(--text-tertiary, #6b7280);
		}

		.prompt-suggestion-text {
			font-size: 0.78rem;
			line-height: 1.5;
			color: var(--text-primary, #e8e9eb);
		}

		.prompt-suggestion-actions {
			display: inline-flex;
			align-items: center;
			gap: 0.35rem;
			flex-shrink: 0;
		}

		.prompt-suggestion-actions button {
			padding: 0.38rem 0.65rem;
			font-size: 0.6rem;
		}

		.prompt-suggestion-dismiss {
			background: transparent;
			border: 1px solid var(--border-primary, #1e2023);
			color: var(--text-tertiary, #6b7280);
		}

		@media (max-width: 768px) {
			textarea {
				font-size: 16px;
			}

			button {
				padding: 0.5rem 0.875rem;
			}

			.hint {
				font-size: 0.55rem;
			}
		}
	`;

	@property({ type: Boolean }) disabled = false;
	@property({ type: Boolean }) showHint = true;
	@property({ attribute: false }) apiClient: ApiClient | null = null;
	@property({ attribute: false }) slashCommands: WebSlashCommand[] =
		WEB_SLASH_COMMANDS;
	@property({ type: String }) promptSuggestion: string | null = null;
	@property({ type: Boolean }) promptSuggestionLoading = false;
	@state() private value = "";
	@state() private showSuggestions = false;
	@state() private suggestionIndex = 0;
	@state() private filteredFiles: string[] = [];
	@state() private slashHint: WebSlashCommand | null = null;
	@state() private slashMatches: WebSlashCommand[] = [];
	@state() private slashIndex = 0;
	@state() private mentionStatus: MentionStatus | null = null;
	@state() private attachments: ComposerAttachment[] = [];
	@state() private voiceSupported = false;
	@state() private voiceActive = false;
	@state() private mcpTools: McpToolItem[] = [];
	@state() private filteredMcpTools: McpToolItem[] = [];
	@state() private mcpLoading = false;
	@state() private mcpError: string | null = null;
	@state() private toolPickerOpen = false;
	@state() private dismissedPromptSuggestion: string | null = null;

	private maxLength = 10000;
	private allFiles: string[] = [];
	private filesLoaded = false;
	private filesPromise: Promise<string[]> | null = null;
	private mcpLoaded = false;
	private mcpPromise: Promise<McpToolItem[]> | null = null;
	private localApiClient: ApiClient | null = null;
	private mentionMatch: { start: number; end: number; query: string } | null =
		null;
	private checkMentionCounter = 0;
	private slashDebounce?: number;
	private speechRecognizer: SpeechRecognition | null = null;
	private voiceBaseValue = "";

	override connectedCallback(): void {
		super.connectedCallback();
		this.voiceSupported = Boolean(this.getSpeechRecognitionCtor());
	}

	override disconnectedCallback(): void {
		this.stopVoiceRecognition();
		super.disconnectedCallback();
	}

	protected override willUpdate(changed: PropertyValues<this>): void {
		if (changed.has("promptSuggestion")) {
			this.dismissedPromptSuggestion = null;
		}
	}

	private getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
		if (typeof window === "undefined") return null;
		return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
	}

	private async handleInput(e: Event) {
		const target = e.target as HTMLTextAreaElement;
		this.value = target.value;

		// Auto-grow textarea
		target.style.height = "auto";
		target.style.height = `${Math.min(target.scrollHeight, 240)}px`;

		// Check for mention without blocking the input path.
		void this.checkMention(target);
		this.updateSlashHint(target.value);
	}

	private async loadAllFiles(): Promise<string[]> {
		if (this.filesLoaded) {
			return this.allFiles;
		}

		if (!this.filesPromise) {
			this.filesPromise = this.getApiClient()
				.getFiles({ throwOnError: true })
				.then((files) => {
					this.allFiles = files;
					this.filesLoaded = true;
					return files;
				})
				.catch((error) => {
					this.filesPromise = Promise.reject(error);
					return this.filesPromise;
				})
				.finally(() => {
					if (this.filesLoaded) {
						this.filesPromise = null;
					}
				});
		}

		return this.filesPromise;
	}

	private prefetchFiles() {
		if (this.filesLoaded || this.filesPromise) {
			return;
		}
		void this.loadAllFiles().catch(() => {});
	}

	private handleTextareaFocus() {
		this.prefetchFiles();
	}

	private async loadMcpTools(): Promise<McpToolItem[]> {
		if (this.mcpLoaded) {
			return this.mcpTools;
		}

		if (!this.mcpPromise) {
			this.mcpLoading = true;
			this.mcpError = null;
			const client = this.getApiClient() as ApiClient & {
				getMcpStatus?: () => Promise<{ servers?: McpServerStatus[] }>;
			};
			if (typeof client.getMcpStatus !== "function") {
				this.mcpLoading = false;
				this.mcpError = "MCP status unavailable.";
				throw new Error("MCP status unavailable");
			}

			this.mcpPromise = client
				.getMcpStatus()
				.then((status) => {
					const tools: McpToolItem[] = [];
					const seen = new Set<string>();
					for (const server of status.servers ?? []) {
						if (!server.connected || !Array.isArray(server.tools)) continue;
						for (const tool of server.tools) {
							if (!tool?.name) continue;
							const id = buildMcpToolName(server.name, tool.name);
							if (seen.has(id)) continue;
							seen.add(id);
							tools.push({
								id,
								server: server.name,
								tool: tool.name,
								label: `${server.name}/${tool.name}`,
								description: tool.description,
								badge: getMcpBadge(server),
							});
						}
					}
					this.mcpTools = tools;
					this.filteredMcpTools = tools;
					this.mcpLoaded = true;
					return tools;
				})
				.catch((error) => {
					const message =
						error instanceof Error && error.message
							? error.message
							: "Failed to load MCP tools.";
					this.mcpError = message;
					this.filteredMcpTools = [];
					throw error;
				})
				.finally(() => {
					this.mcpLoading = false;
					this.mcpPromise = null;
				});
		}

		return this.mcpPromise;
	}

	private async openMcpPicker() {
		this.toolPickerOpen = true;
		this.showSuggestions = false;
		this.mentionStatus = null;
		this.suggestionIndex = 0;
		this.filteredMcpTools = this.mcpTools;

		try {
			await this.loadMcpTools();
		} catch {
			// mcpError already set in loadMcpTools
		}
	}

	private closeMcpPicker() {
		this.toolPickerOpen = false;
	}

	private async checkMention(textarea: HTMLTextAreaElement) {
		const requestId = ++this.checkMentionCounter;
		const cursor = textarea.selectionStart;
		const textBeforeCursor = this.value.slice(0, cursor);

		// Regex to find @mention at end of string
		const match = /@([a-zA-Z0-9_\-\.\/]*)$/.exec(textBeforeCursor);

		if (match) {
			const query = (match[1] ?? "").toLowerCase();
			this.mentionMatch = {
				start: match.index,
				end: cursor,
				query: match[1] ?? "",
			};
			this.closeMcpPicker();

			if (!this.filesLoaded) {
				this.showSuggestions = false;
				this.filteredFiles = [];
				this.mentionStatus = {
					kind: "loading",
					message: "Loading files…",
				};
				try {
					await this.loadAllFiles();
				} catch {
					if (requestId !== this.checkMentionCounter) return;
					this.mentionStatus = {
						kind: "error",
						message: "Couldn't load files. Try again.",
					};
					return;
				}
				if (requestId !== this.checkMentionCounter) return;
			}

			this.mentionStatus = null;

			// Handle empty query - return first files without ranking
			if (!query) {
				this.filteredFiles = this.allFiles.slice(0, 10);
			} else {
				// Rank matches: basename > prefix > substring
				const scored = this.allFiles
					.map((f) => {
						const lower = f.toLowerCase();
						const basename = lower.split("/").pop() ?? lower;
						let score = 0;
						if (basename.startsWith(query))
							score = 3; // basename prefix
						else if (lower.startsWith(query))
							score = 2; // full path prefix
						else if (lower.includes(query)) score = 1; // substring
						return { file: f, score };
					})
					.filter(({ score }) => score > 0)
					.sort((a, b) => b.score - a.score);

				this.filteredFiles = scored.map(({ file }) => file).slice(0, 10);
			}

			if (this.filteredFiles.length > 0) {
				this.showSuggestions = true;
				this.suggestionIndex = 0;
				return;
			}
		}

		this.showSuggestions = false;
		this.mentionMatch = null;
		this.mentionStatus = null;
	}

	private getApiClient(): ApiClient {
		if (this.apiClient) return this.apiClient;
		this.localApiClient ??= new ApiClient();
		return this.localApiClient;
	}

	private updateSlashHint(text: string) {
		// Debounce to avoid flicker
		if (this.slashDebounce) {
			clearTimeout(this.slashDebounce);
		}
		this.slashDebounce = window.setTimeout(() => {
			const trimmed = text.trim();
			if (!trimmed.startsWith("/")) {
				this.slashHint = null;
				this.slashMatches = [];
				this.slashIndex = 0;
				return;
			}
			const [token] = trimmed.split(/\s+/);
			const query = (token ?? "/").slice(1).toLowerCase();
			type ScoredCommand = { cmd: WebSlashCommand; score: number };
			const scored: ScoredCommand[] = this.slashCommands
				.filter(isWebSlashCommandSupported)
				.map((cmd) => ({
					cmd,
					score: this.scoreCommand(cmd, query),
				}))
				.filter((s) => s.score > 0 || !query)
				.sort(
					(a, b) => b.score - a.score || a.cmd.name.localeCompare(b.cmd.name),
				);
			this.slashMatches = scored.map((s) => s.cmd);
			this.slashIndex = 0;
			this.slashHint = this.slashMatches[0] ?? null;
		}, 20);
	}

	private cycleSlash(reverse: boolean) {
		if (this.slashMatches.length === 0) {
			this.updateSlashHint(this.value);
			return;
		}
		if (reverse) {
			this.slashIndex =
				(this.slashIndex - 1 + this.slashMatches.length) %
				this.slashMatches.length;
		} else {
			this.slashIndex = (this.slashIndex + 1) % this.slashMatches.length;
		}
		this.slashHint = this.slashMatches[this.slashIndex] ?? null;

		// Replace current token with selected command
		const parts = this.value.split(/\s+/);
		const firstPart = parts[0];
		if (parts.length > 0 && firstPart !== undefined) {
			parts[0] = `/${this.slashHint?.name ?? firstPart.slice(1)}`;
			this.value = parts.join(" ");
			this.requestUpdate();
		}
	}

	private scoreCommand(cmd: WebSlashCommand, query: string): number {
		let score = 0;
		const q = query.trim();
		const name = cmd.name.toLowerCase();
		if (!q) return 1;
		if (name === q) score += 100;
		if (name.startsWith(q)) score += 70;
		if (name.includes(q)) score += 20;
		if (cmd.tags?.some((t) => t.includes(q))) score += 10;
		return score;
	}

	private handleKeyDown(e: KeyboardEvent) {
		if (this.mentionStatus && e.key === "Escape") {
			e.preventDefault();
			this.mentionStatus = null;
			return;
		}

		// Slash cycling (Tab / Shift+Tab) if not showing file suggestions
		if (
			!this.showSuggestions &&
			!this.toolPickerOpen &&
			this.value.trim().startsWith("/")
		) {
			if (e.key === "Tab") {
				e.preventDefault();
				this.cycleSlash(e.shiftKey);
				return;
			}
		}

		if (this.showSuggestions) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				this.suggestionIndex =
					(this.suggestionIndex + 1) % this.filteredFiles.length;
				this.scrollSelectedIntoView();
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				this.suggestionIndex =
					(this.suggestionIndex - 1 + this.filteredFiles.length) %
					this.filteredFiles.length;
				this.scrollSelectedIntoView();
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				const selectedFile = this.filteredFiles[this.suggestionIndex];
				if (selectedFile !== undefined) {
					this.selectSuggestion(selectedFile);
				}
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				this.showSuggestions = false;
				return;
			}
		}

		if (this.toolPickerOpen) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				if (this.filteredMcpTools.length > 0) {
					this.suggestionIndex =
						(this.suggestionIndex + 1) % this.filteredMcpTools.length;
					this.scrollSelectedIntoView();
				}
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				if (this.filteredMcpTools.length > 0) {
					this.suggestionIndex =
						(this.suggestionIndex - 1 + this.filteredMcpTools.length) %
						this.filteredMcpTools.length;
					this.scrollSelectedIntoView();
				}
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				const selectedTool = this.filteredMcpTools[this.suggestionIndex];
				if (selectedTool) {
					this.selectMcpSuggestion(selectedTool);
				} else {
					this.closeMcpPicker();
				}
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				this.closeMcpPicker();
				return;
			}
		}

		// Submit on Enter (without Shift)
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			this.submit();
		}
	}

	private notifyVoiceError(message: string) {
		this.dispatchEvent(
			new CustomEvent("voice-error", {
				detail: { message },
				bubbles: true,
				composed: true,
			}),
		);
	}

	private stopVoiceRecognition() {
		if (this.speechRecognizer) {
			try {
				this.speechRecognizer.stop();
			} catch {
				// ignore stop errors
			}
		}
		this.speechRecognizer = null;
		this.voiceActive = false;
	}

	private startVoiceRecognition() {
		if (this.disabled) return;
		const ctor = this.getSpeechRecognitionCtor();
		if (!ctor) {
			this.notifyVoiceError("Voice input not supported in this browser.");
			this.voiceSupported = false;
			return;
		}

		const recognizer = new ctor();
		this.speechRecognizer = recognizer;
		this.voiceActive = true;

		const base = this.value;
		const spacer = base && !base.endsWith(" ") ? " " : "";
		this.voiceBaseValue = base + spacer;
		let finalTranscript = "";

		recognizer.continuous = false;
		recognizer.interimResults = true;
		recognizer.lang =
			typeof navigator !== "undefined" && navigator.language
				? navigator.language
				: "en-US";

		recognizer.onresult = (event) => {
			let interim = "";
			for (let i = event.resultIndex; i < event.results.length; i += 1) {
				const result = event.results[i];
				const transcript = result?.[0]?.transcript ?? "";
				if (result?.isFinal) {
					finalTranscript += transcript;
				} else {
					interim += transcript;
				}
			}

			const next = `${this.voiceBaseValue}${finalTranscript}${
				interim ? ` ${interim}` : ""
			}`.trimStart();
			this.value = next;
			this.syncTextareaValue(next);
		};

		recognizer.onerror = (_event: Event) => {
			this.voiceActive = false;
			this.speechRecognizer = null;
			this.notifyVoiceError(
				"Voice input failed. Check microphone permissions.",
			);
		};

		recognizer.onend = () => {
			this.voiceActive = false;
			this.speechRecognizer = null;
			const next = `${this.voiceBaseValue}${finalTranscript}`.trimStart();
			this.value = next;
			this.syncTextareaValue(next);
		};

		try {
			recognizer.start();
		} catch (error) {
			this.voiceActive = false;
			this.speechRecognizer = null;
			const message =
				error instanceof Error && error.message
					? error.message
					: "Unable to start voice input.";
			this.notifyVoiceError(message);
		}
	}

	private toggleVoice() {
		if (this.voiceActive) {
			this.stopVoiceRecognition();
			return;
		}
		this.startVoiceRecognition();
	}

	private scrollSelectedIntoView() {
		const list = this.shadowRoot?.querySelector(
			".suggestions",
		) as HTMLElement | null;
		const item =
			(list?.children?.[this.suggestionIndex] as HTMLElement) ?? null;
		if (item && list) {
			if (item.offsetTop < list.scrollTop) {
				list.scrollTop = item.offsetTop;
			} else if (
				item.offsetTop + item.offsetHeight >
				list.scrollTop + list.offsetHeight
			) {
				list.scrollTop = item.offsetTop + item.offsetHeight - list.offsetHeight;
			}
		}
	}

	private selectSuggestion(file: string) {
		if (!this.mentionMatch) return;

		const before = this.value.slice(0, this.mentionMatch.start);
		const after = this.value.slice(this.mentionMatch.end);

		// Insert full path, avoid double space if after already starts with space
		const spacer = after.startsWith(" ") ? "" : " ";
		const newValue = `${before}@${file}${spacer}${after}`;
		this.value = newValue;

		this.showSuggestions = false;
		this.mentionMatch = null;

		// Focus, sync DOM value, recalculate height, and set cursor
		const cursorOffset = spacer ? 2 : 1; // @ + optional space
		requestAnimationFrame(() => {
			const textarea = this.shadowRoot?.querySelector("textarea");
			if (textarea) {
				textarea.value = newValue;
				textarea.style.height = "auto";
				textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
				textarea.focus();
				const newCursorPos = before.length + file.length + cursorOffset;
				textarea.setSelectionRange(newCursorPos, newCursorPos);
			}
		});
	}

	private selectMcpSuggestion(tool: McpToolItem) {
		const textarea = this.getTextarea();
		const start = textarea?.selectionStart ?? this.value.length;
		const end = textarea?.selectionEnd ?? start;
		const before = this.value.slice(0, start);
		const after = this.value.slice(end);
		const insertion = `@${tool.id} `;
		const newValue = `${before}${insertion}${after}`;
		this.value = newValue;
		this.closeMcpPicker();

		requestAnimationFrame(() => {
			const nextTextarea = this.getTextarea();
			if (!nextTextarea) return;
			nextTextarea.value = newValue;
			nextTextarea.style.height = "auto";
			nextTextarea.style.height = `${Math.min(nextTextarea.scrollHeight, 240)}px`;
			nextTextarea.focus();
			const cursorPos = before.length + insertion.length;
			nextTextarea.setSelectionRange(cursorPos, cursorPos);
		});
	}

	private async fileToBase64(file: File): Promise<string> {
		const dataUrl = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onerror = () => reject(new Error("Failed to read file"));
			reader.onload = () => resolve(String(reader.result || ""));
			reader.readAsDataURL(file);
		});
		const comma = dataUrl.indexOf(",");
		return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
	}

	private async imageToPreviewBase64(file: File): Promise<string | undefined> {
		try {
			const blobUrl = URL.createObjectURL(file);
			try {
				const img = await new Promise<HTMLImageElement>((resolve, reject) => {
					const el = new Image();
					el.onload = () => resolve(el);
					el.onerror = () => reject(new Error("Failed to load image"));
					el.src = blobUrl;
				});

				const maxDim = 128;
				const scale = Math.min(
					1,
					maxDim /
						Math.max(img.naturalWidth || maxDim, img.naturalHeight || maxDim),
				);
				const w = Math.max(1, Math.round((img.naturalWidth || maxDim) * scale));
				const h = Math.max(
					1,
					Math.round((img.naturalHeight || maxDim) * scale),
				);

				const canvas = document.createElement("canvas");
				canvas.width = w;
				canvas.height = h;
				const ctx = canvas.getContext("2d");
				if (!ctx) return undefined;
				ctx.drawImage(img, 0, 0, w, h);

				const previewUrl = canvas.toDataURL("image/png", 0.9);
				const comma = previewUrl.indexOf(",");
				return comma >= 0 ? previewUrl.slice(comma + 1) : previewUrl;
			} finally {
				URL.revokeObjectURL(blobUrl);
			}
		} catch {
			return undefined;
		}
	}

	private isTextLike(file: File): boolean {
		const type = (file.type || "").toLowerCase();
		if (type.startsWith("text/")) return true;
		if (
			type.includes("json") ||
			type.includes("xml") ||
			type.includes("yaml") ||
			type.includes("csv")
		) {
			return true;
		}
		const name = file.name.toLowerCase();
		return (
			name.endsWith(".txt") ||
			name.endsWith(".md") ||
			name.endsWith(".markdown") ||
			name.endsWith(".json") ||
			name.endsWith(".yaml") ||
			name.endsWith(".yml") ||
			name.endsWith(".csv") ||
			name.endsWith(".ts") ||
			name.endsWith(".tsx") ||
			name.endsWith(".js") ||
			name.endsWith(".jsx")
		);
	}

	private async addFiles(files: FileList | File[]) {
		const list = Array.from(files || []);
		if (list.length === 0) return;

		const MAX_BYTES = 8 * 1024 * 1024;
		const next: ComposerAttachment[] = [...this.attachments];

		for (const file of list) {
			if (!file) continue;
			if (file.size > MAX_BYTES) continue;

			const id =
				typeof crypto !== "undefined" && "randomUUID" in crypto
					? crypto.randomUUID()
					: `att_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
			const mimeType = file.type?.trim() || "application/octet-stream";
			const type: ComposerAttachment["type"] = mimeType.startsWith("image/")
				? "image"
				: "document";

			const content = await this.fileToBase64(file);
			const preview =
				type === "image" ? await this.imageToPreviewBase64(file) : undefined;

			let extractedText: string | undefined;
			if (type === "document" && this.isTextLike(file)) {
				try {
					const text = await file.text();
					extractedText = text.length > 200_000 ? text.slice(0, 200_000) : text;
				} catch {
					extractedText = undefined;
				}
			}

			next.push({
				id,
				type,
				fileName: file.name || "attachment",
				mimeType,
				size: file.size,
				content,
				preview,
				extractedText,
			});
		}

		this.attachments = next;
	}

	private handleAttachClick() {
		const input = this.shadowRoot?.querySelector(
			"input[type=file]",
		) as HTMLInputElement | null;
		input?.click();
	}

	private handleFileChange(e: Event) {
		const input = e.target as HTMLInputElement | null;
		if (!input?.files) return;
		void this.addFiles(input.files);
		input.value = "";
	}

	private removeAttachment(id: string) {
		this.attachments = this.attachments.filter((a) => a.id !== id);
	}

	private openAttachment(attachment: ComposerAttachment) {
		this.dispatchEvent(
			new CustomEvent("open-attachment", {
				bubbles: true,
				composed: true,
				detail: { attachment },
			}),
		);
	}

	private getTextarea(): HTMLTextAreaElement | null {
		return this.shadowRoot?.querySelector("textarea") ?? null;
	}

	private submit() {
		const text = this.value.trim();
		if ((!text && this.attachments.length === 0) || this.disabled) return;

		this.dispatchEvent(
			new CustomEvent("submit", {
				detail: { text, attachments: this.attachments },
				bubbles: true,
				composed: true,
			}),
		);

		// Clear input
		this.value = "";
		this.attachments = [];
		this.showSuggestions = false;
		this.closeMcpPicker();
		this.mentionStatus = null;
		const textarea = this.getTextarea();
		if (textarea) {
			textarea.value = "";
			textarea.style.height = "auto";
		}
	}

	private syncTextareaValue(text: string) {
		const textarea = this.getTextarea();
		if (!textarea) return;
		textarea.value = text;
		textarea.style.height = "auto";
		textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
	}

	public focusInput() {
		this.getTextarea()?.focus();
	}

	public setValue(text: string) {
		this.value = text;
		this.syncTextareaValue(text);
		this.focusInput();
	}

	private getCharCountClass(): string {
		const len = this.value.length;
		if (len > this.maxLength * 0.9) return "error";
		if (len > this.maxLength * 0.75) return "warning";
		return "";
	}

	override render() {
		const charCount = this.value.length;
		const showCount = charCount > this.maxLength * 0.5;
		const promptSuggestion = this.promptSuggestion?.trim() || null;
		const showPromptSuggestion =
			!this.disabled &&
			!this.value.trim() &&
			(this.promptSuggestionLoading ||
				(promptSuggestion &&
					promptSuggestion !== this.dismissedPromptSuggestion));

		return html`
			<div class="input-container">
				${
					showPromptSuggestion
						? html`
							<div class="prompt-suggestion">
								<div class="prompt-suggestion-copy">
									<div class="prompt-suggestion-label">Suggested Next Prompt</div>
									<div class="prompt-suggestion-text">
										${
											this.promptSuggestionLoading && !promptSuggestion
												? "Generating a likely follow-up..."
												: promptSuggestion
										}
									</div>
								</div>
								${
									promptSuggestion
										? html`
											<div class="prompt-suggestion-actions">
												<button
													type="button"
													@click=${() => {
														this.setValue(promptSuggestion);
													}}
												>
													Use
												</button>
												<button
													type="button"
													class="prompt-suggestion-dismiss"
													@click=${() => {
														this.dismissedPromptSuggestion = promptSuggestion;
													}}
												>
													Dismiss
												</button>
											</div>
										`
										: null
								}
							</div>
					  `
						: null
				}
				${
					this.slashHint
						? html`
							<div class="slash-hint">
								<div class="meta">
									<div class="name">/${this.slashHint.name}</div>
									<div class="desc">${this.slashHint.description}</div>
									<div class="usage">${this.slashHint.usage}</div>
									${
										this.slashHint.tags?.length
											? html`<div class="tags">
												${this.slashHint.tags.map(
													(tag) => html`<span>#${tag}</span>`,
												)}
										  </div>`
											: null
									}
								</div>
								<div class="controls">
									<kbd>Tab</kbd><span>cycle</span>
								</div>
							</div>
					  `
						: null
				}
				${
					this.mentionStatus && !this.showSuggestions && !this.toolPickerOpen
						? html`
							<div class="mention-status ${this.mentionStatus.kind === "error" ? "error" : ""}">
								${this.mentionStatus.message}
							</div>
						`
						: null
				}
				${
					this.toolPickerOpen
						? html`
								<div class="suggestions">
									${
										this.mcpLoading
											? html`<div class="suggestion-empty">Loading MCP tools...</div>`
											: this.mcpError
												? html`<div class="suggestion-empty">${this.mcpError}</div>`
												: this.filteredMcpTools.length === 0
													? html`<div class="suggestion-empty">
															No MCP tools available. Configure servers in
															<code>.maestro/mcp.json</code>.
													  </div>`
													: this.filteredMcpTools.map(
															(tool, i) => html`
																<div
																	class="suggestion-item ${i === this.suggestionIndex ? "selected" : ""}"
																	@mousedown=${(event: Event) => event.preventDefault()}
																	@click=${() => this.selectMcpSuggestion(tool)}
																>
																	<div class="suggestion-meta">
																		<div class="suggestion-main">
																			<div class="suggestion-label">${tool.label}</div>
																			<div class="suggestion-subtitle">@${tool.id}</div>
																		</div>
																		<div class="suggestion-badge">${tool.badge}</div>
																	</div>
																	${
																		tool.description
																			? html`<div class="suggestion-description">
																					${tool.description}
																			  </div>`
																			: null
																	}
																</div>
															`,
														)
									}
								</div>
						  `
						: this.showSuggestions
							? html`
									<div class="suggestions">
										${this.filteredFiles.map(
											(file, i) => html`
												<div
													class="suggestion-item ${i === this.suggestionIndex ? "selected" : ""}"
													@click=${() => this.selectSuggestion(file)}
												>
													${file}
												</div>
											`,
										)}
									</div>
							  `
							: ""
				}
				<div class="input-wrapper ${this.voiceActive ? "recording" : ""}">
					<textarea
						.value=${this.value}
						@input=${this.handleInput}
						@focus=${this.handleTextareaFocus}
						@keydown=${this.handleKeyDown}
						?disabled=${this.disabled}
						placeholder="> Type a message, use /commands, mention files with @, or insert MCP tools"
						maxlength=${this.maxLength}
						rows="1"
					></textarea>
					${
						showCount
							? html`<div class="char-count ${this.getCharCountClass()}">
								${charCount}/${this.maxLength}
						  </div>`
							: ""
					}
					<div class="actions">
						<input
							type="file"
							style="display:none"
							multiple
							@change=${this.handleFileChange}
						/>
						<button
							class="attach-button"
							?disabled=${this.disabled}
							@click=${this.handleAttachClick}
							title="Attach files"
						>
							＋
						</button>
						<button
							class="voice-button ${this.voiceActive ? "active" : ""}"
							?disabled=${this.disabled || !this.voiceSupported}
							@click=${this.toggleVoice}
							title=${this.voiceSupported ? (this.voiceActive ? "Stop voice input" : "Voice input") : "Voice input not supported"}
							aria-pressed=${this.voiceActive ? "true" : "false"}
						>
							${this.voiceActive ? "REC" : "MIC"}
						</button>
						<button
							class="mcp-button ${this.toolPickerOpen ? "active" : ""}"
							?disabled=${this.disabled}
							@click=${() => {
								if (this.toolPickerOpen) {
									this.closeMcpPicker();
								} else {
									void this.openMcpPicker();
								}
							}}
							title=${
								this.mcpLoading
									? "Loading MCP tools"
									: this.mcpError
										? "MCP tools unavailable"
										: "Insert MCP tool"
							}
						>
							MCP
						</button>
						<button
							@click=${this.submit}
							?disabled=${this.disabled || (!this.value.trim() && this.attachments.length === 0)}
						>
							SEND
						</button>
					</div>
				</div>
				${
					this.attachments.length
						? html`<div class="attachments">
								${this.attachments.map((a) => {
									const isImage = a.type === "image";
									const preview = a.preview || a.content || "";
									return html`<div
										class="attachment-tile"
										title=${a.fileName}
										@click=${() => this.openAttachment(a)}
									>
										${
											isImage && preview
												? html`<img
														alt=${a.fileName}
														src=${`data:${a.mimeType};base64,${preview}`}
													/>`
												: html`<span>
														${(a.fileName || "?").slice(0, 2).toUpperCase()}
													</span>`
										}
										<button
											class="attachment-remove"
											@click=${(e: Event) => {
												e.preventDefault();
												e.stopPropagation();
												this.removeAttachment(a.id);
											}}
											title="Remove"
										>
											×
										</button>
									</div>`;
								})}
						  </div>`
						: ""
				}
			</div>
			${
				this.showHint
					? html`<div class="hint">
							<kbd>↵</kbd> send • <kbd>⇧</kbd> + <kbd>↵</kbd> newline • <kbd>@</kbd> mention file • <kbd>MCP</kbd> tools
					  </div>`
					: null
			}
		`;
	}
}
