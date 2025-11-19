/**
 * Main chat interface component
 */

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
	ApiClient,
	type Message,
	type Session,
} from "../services/api-client.js";
import "./composer-message.js";
import "./composer-input.js";
import "./composer-settings.js";

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

		.sidebar-header h2 {
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.7rem;
			font-weight: 600;
			margin: 0 0 0.625rem 0;
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
			padding: 0.625rem 0.75rem;
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
			font-size: 0.8rem;
			font-weight: 500;
			margin-bottom: 0.25rem;
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
			gap: 0.75rem;
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
			gap: 0.75rem;
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.7rem;
			color: #6e7681;
		}

		.status-item {
			display: flex;
			align-items: center;
			gap: 0.35rem;
			padding: 0.25rem 0.5rem;
			background: #161b22;
			border: 1px solid #21262d;
			border-radius: 2px;
		}

		.status-item.active {
			border-color: #58a6ff;
			color: #58a6ff;
		}

		.status-dot {
			width: 6px;
			height: 6px;
			border-radius: 50%;
			background: #3fb950;
			animation: pulse 2s ease-in-out infinite;
		}

		@keyframes pulse {
			0%, 100% { opacity: 1; }
			50% { opacity: 0.4; }
		}

		.header-right {
			display: flex;
			align-items: center;
			gap: 0.5rem;
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
			width: 28px;
			height: 28px;
			padding: 0;
			background: transparent;
			border: 1px solid #30363d;
			border-radius: 2px;
			color: #8b949e;
			cursor: pointer;
			transition: all 0.15s;
			font-size: 0.9rem;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.icon-btn:hover {
			background: #21262d;
			border-color: #58a6ff;
			color: #58a6ff;
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

		.tool-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
			gap: 0.5rem;
			margin-top: 0.5rem;
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

		.tool-badge {
			padding: 0.375rem 0.5rem;
			background: #161b22;
			border: 1px solid #30363d;
			border-radius: 2px;
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.65rem;
			color: #8b949e;
			text-align: center;
			transition: all 0.15s;
		}

		.tool-badge:hover {
			border-color: #58a6ff;
			color: #58a6ff;
			cursor: pointer;
		}

		.command-hint {
			padding: 0.875rem 1rem;
			background: #0d1117;
			border-top: 1px solid #21262d;
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.7rem;
			color: #6e7681;
		}

		.command-hint code {
			color: #58a6ff;
			background: #161b22;
			padding: 0.125rem 0.35rem;
			border-radius: 2px;
			margin: 0 0.25rem;
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
	`;

	@property() apiEndpoint = "http://localhost:8080";
	@property() model = "claude-sonnet-4-5";

	@state() private messages: Message[] = [];
	@state() private loading = false;
	@state() private error: string | null = null;
	@state() private currentModel = "";
	@state() private sidebarOpen = true;
	@state() private sessions: Session[] = [];
	@state() private currentSessionId: string | null = null;
	@state() private settingsOpen = false;

	private apiClient!: ApiClient;

	connectedCallback() {
		super.connectedCallback();
		this.apiClient = new ApiClient(this.apiEndpoint);
		this.loadCurrentModel();
		this.loadSessions();
	}

	private async loadCurrentModel() {
		try {
			const model = await this.apiClient.getCurrentModel();
			this.currentModel = model ? `${model.provider}/${model.id}` : this.model;
		} catch (e) {
			console.error("Failed to load current model:", e);
			this.currentModel = this.model;
		}
	}

	private async loadSessions() {
		try {
			this.sessions = await this.apiClient.getSessions();
		} catch (e) {
			console.error("Failed to load sessions:", e);
		}
	}

	private toggleSidebar() {
		this.sidebarOpen = !this.sidebarOpen;
	}

	private toggleSettings() {
		this.settingsOpen = !this.settingsOpen;
	}

	private handleModelSelect(event: CustomEvent) {
		this.currentModel = event.detail.model;
		// You could also call an API to persist the model selection
	}

	private async createNewSession() {
		this.messages = [];
		this.currentSessionId = null;
		this.error = null;
		this.requestUpdate(); // Force update
		await this.loadSessions();
	}

	private async selectSession(sessionId: string) {
		this.currentSessionId = sessionId;
		try {
			const session = await this.apiClient.getSession(sessionId);
			
			// Transform messages: extract text from content blocks and convert toolCalls to tools
			const transformedMessages = (session.messages || []).map((msg: any) => {
				// If content is already a string, use it as-is
				if (typeof msg.content === 'string') {
					return msg;
				}
				
				// If content is an array of blocks, extract text and tools
				if (Array.isArray(msg.content)) {
					const textBlocks = msg.content.filter((block: any) => block.type === 'text');
					const toolBlocks = msg.content.filter((block: any) => block.type === 'toolCall');
					
					return {
						...msg,
						content: textBlocks.map((b: any) => b.text).join('\n\n'),
						tools: toolBlocks.map((t: any) => ({
							name: t.name,
							status: 'completed',
							args: t.arguments,
							result: null,
						})),
					};
				}
				
				return msg;
			});
			
			// Create a new array reference to trigger Lit's reactivity
			this.messages = [...transformedMessages];
			this.error = null;
			this.requestUpdate(); // Force update
			await this.updateComplete; // Wait for render
			this.scrollToBottom();
		} catch (e) {
			console.error("Failed to load session:", e);
			this.error = e instanceof Error ? e.message : "Failed to load session";
		}
	}

	private async handleSubmit(event: CustomEvent<{ text: string }>) {
		const text = event.detail.text.trim();
		if (!text || this.loading) return;

		// Add user message
		const userMessage: Message = {
			role: "user",
			content: text,
			timestamp: new Date().toISOString(),
		};
		this.messages = [...this.messages, userMessage];

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
		} finally {
			this.loading = false;
		}
	}

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

	render() {
		const cwd = "/Users/jonathan/codingagent"; // In real app, get from API
		const tools = [
			"read",
			"write",
			"edit",
			"bash",
			"search",
			"diff",
			"gh_pr",
			"gh_issue",
		];
		const showSessionGallery =
			this.messages.length === 0 && this.sessions.length > 0;
		const recentSessions = showSessionGallery ? this.sessions.slice(0, 8) : [];

		return html`
			<div class="sidebar ${this.sidebarOpen ? "" : "collapsed"}">
				<div class="sidebar-header">
					<h2>Sessions</h2>
					<button class="new-session-btn" @click=${this.createNewSession}>
						New Chat
					</button>
				</div>
				<div class="sessions-list">
					${this.sessions.map(
						(session) => html`
							<div
								class="session-item ${this.currentSessionId === session.id ? "active" : ""}"
								@click=${() => this.selectSession(session.id)}
							>
								<div class="session-title">${session.title || "Untitled Session"}</div>
								<div class="session-meta">
									${this.formatSessionDate(session.updatedAt)} • ${session.messageCount || 0} msgs
								</div>
							</div>
						`,
					)}
				</div>
			</div>

			<div class="main-content">
				<div class="header">
					<div class="header-left">
						<button class="toggle-sidebar-btn" @click=${this.toggleSidebar}>
							${this.sidebarOpen ? "◄" : "►"}
						</button>
						<h1>Composer</h1>
					</div>
					<div class="status-bar">
						<div class="status-item active">
							<span class="status-dot"></span>
							<span>CONNECTED</span>
						</div>
						<div class="status-item">
							<span>CWD:</span>
							<span style="color: #58a6ff;">${cwd.split("/").pop()}</span>
						</div>
						<div class="status-item">
							<span>MSGS:</span>
							<span style="color: #e6edf3;">${this.messages.length}</span>
						</div>
					</div>
					<div class="header-right">
						<div class="model-selector" @click=${this.toggleSettings}>
							<span class="model-badge">AI</span>
							<span>${this.currentModel.split("/").pop()?.toUpperCase() || "MODEL"}</span>
						</div>
						<button class="icon-btn" title="Settings" @click=${this.toggleSettings}>⚙</button>
					</div>
				</div>

				${this.error ? html`<div class="error">${this.error}</div>` : ""}

				<div class="messages">
					${
						this.messages.length === 0
							? html`
								<div class="empty-state">
									<div class="workspace-panel">
										<div class="panel-section">
											<h3>Workspace</h3>
											<div class="panel-item active">
												<span>►</span>${cwd}
											</div>
											<div class="panel-item">
												<span>GIT:</span>feat/concurrently-web-ui-tui
											</div>
											<div class="panel-item">
												<span>FILES:</span>~34 modified
											</div>
										</div>
										<div class="panel-section">
											<h3>Model</h3>
											<div class="panel-item active">
												<span>►</span>${this.currentModel}
											</div>
											<div class="panel-item">
												<span>CTX:</span>200k tokens
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
										<div class="panel-section">
											<h3>Available Tools</h3>
											<div class="tool-grid">
												${tools.map(
													(tool) => html`
													<div class="tool-badge">${tool}</div>
												`,
												)}
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
									<div class="command-hint">
										Type a message to start coding, or use slash commands:
										<code>/run</code><code>/config</code><code>/help</code>
									</div>
								</div>
						  `
							: this.messages.map(
									(msg) => html`
									<composer-message
										role=${msg.role}
										content=${msg.content}
										timestamp=${msg.timestamp || ""}
										.tools=${msg.tools || []}
									></composer-message>
								`,
								)
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
		`;
	}
}
