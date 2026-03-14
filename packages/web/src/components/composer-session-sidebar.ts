import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionSummary } from "../services/api-client.js";

type SessionEditField = "tags" | "title";

@customElement("composer-session-sidebar")
export class ComposerSessionSidebar extends LitElement {
	static override styles = css`
		:host {
			width: 260px;
			background: var(--bg-deep, #08090a);
			border-right: 1px solid var(--border-primary, #1e2023);
			display: flex;
			flex-direction: column;
			transition: transform 0.2s ease;
			z-index: 20;
		}

		:host([collapsed]) {
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

		.session-search {
			margin-top: 0.4rem;
			width: 100%;
			padding: 0.35rem 0.5rem;
			background: var(--bg-primary, #0a0e14);
			border: 1px solid var(--border-secondary, #30363d);
			color: var(--text-primary, #e6edf3);
			border-radius: 3px;
			font-family: var(--font-mono, "SF Mono", "Menlo", "Monaco", monospace);
			font-size: 0.75rem;
		}

		.session-search::placeholder {
			color: var(--text-tertiary, #5c5e62);
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
			width: 100%;
			padding: 0.625rem 0.75rem;
			margin-bottom: 1px;
			cursor: pointer;
			transition: all 0.1s ease;
			background: transparent;
			border: none;
			border-left: 2px solid transparent;
			position: relative;
			text-align: left;
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 0.5rem;
		}

		.session-item:hover {
			background: var(--bg-elevated, #161719);
		}

		.session-item.active {
			background: var(--bg-elevated, #161719);
			border-left-color: var(--accent-amber, #d4a012);
		}

		.session-item-body {
			min-width: 0;
			flex: 1;
		}

		.session-actions {
			display: flex;
			flex-direction: column;
			gap: 0.35rem;
			align-items: center;
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

		.session-tags {
			display: flex;
			gap: 0.25rem;
			flex-wrap: wrap;
			margin-top: 0.35rem;
		}

		.session-tag {
			border: 1px solid var(--border-primary, #1e2023);
			border-radius: 999px;
			padding: 0.1rem 0.35rem;
			font-family: var(--font-mono, monospace);
			font-size: 0.56rem;
			color: var(--text-tertiary, #5c5e62);
		}

		.session-tools {
			display: flex;
			gap: 0.5rem;
			flex-wrap: wrap;
			margin-top: 0.4rem;
		}

		.session-link-btn {
			padding: 0;
			border: none;
			background: transparent;
			color: var(--text-tertiary, #5c5e62);
			font-family: var(--font-mono, monospace);
			font-size: 0.58rem;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			cursor: pointer;
		}

		.session-link-btn:hover {
			color: var(--accent-amber, #d4a012);
		}

		.session-editor {
			margin-top: 0.4rem;
			display: flex;
			flex-direction: column;
			gap: 0.35rem;
		}

		.session-editor-input {
			width: 100%;
			padding: 0.35rem 0.5rem;
			background: var(--bg-primary, #0a0e14);
			border: 1px solid var(--border-secondary, #30363d);
			border-radius: 3px;
			color: var(--text-primary, #e6edf3);
			font-family: var(--font-mono, monospace);
			font-size: 0.72rem;
		}

		.session-editor-actions {
			display: flex;
			gap: 0.5rem;
		}

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
			flex-shrink: 0;
		}

		.icon-btn:hover {
			background: var(--bg-elevated, #161719);
			border-color: var(--border-hover, #3a3d42);
			color: var(--text-primary, #e8e9eb);
		}

		.favorite-btn.active {
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

		.empty,
		.loading {
			font-family: var(--font-mono, monospace);
			font-size: 0.7rem;
			color: var(--text-tertiary, #5c5e62);
			padding: 0.5rem 0.25rem;
		}

		@media (max-width: 768px) {
			:host {
				position: absolute;
				height: 100%;
				box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.5));
			}
		}

		@media (max-width: 640px) {
			:host {
				width: min(82vw, 320px);
			}
		}
	`;

	@property({ type: Boolean, reflect: true }) shared = false;
	@property({ type: Boolean, reflect: true }) collapsed = false;
	@property({ attribute: false }) sessions: SessionSummary[] = [];
	@property() currentSessionId: string | null = null;

	@state() private sessionSearch = "";
	@state() private editingSessionId: string | null = null;
	@state() private editingField: SessionEditField | null = null;
	@state() private editValue = "";

	private dispatch(name: string, detail?: Record<string, unknown>) {
		this.dispatchEvent(
			new CustomEvent(name, {
				detail,
				bubbles: true,
				composed: true,
			}),
		);
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

	private get filteredSessions(): SessionSummary[] {
		const query = this.sessionSearch.trim().toLowerCase();
		const filtered = this.sessions.filter((session) => {
			if (!query) return true;
			const title = session.title?.toLowerCase() ?? "";
			const id = session.id?.toLowerCase() ?? "";
			const tags = session.tags?.join(" ").toLowerCase() ?? "";
			return (
				title.includes(query) || id.includes(query) || tags.includes(query)
			);
		});
		return [...filtered].sort(
			(a, b) =>
				Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) ||
				new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
		);
	}

	private beginEdit(
		session: SessionSummary,
		field: SessionEditField,
		event: Event,
	) {
		event.stopPropagation();
		this.editingSessionId = session.id;
		this.editingField = field;
		this.editValue =
			field === "title"
				? (session.title ?? "")
				: (session.tags ?? []).join(", ");
	}

	private cancelEdit(event?: Event) {
		event?.stopPropagation();
		this.editingSessionId = null;
		this.editingField = null;
		this.editValue = "";
	}

	private parseTags(value: string): string[] {
		const seen = new Set<string>();
		const tags: string[] = [];
		for (const part of value.split(",")) {
			const tag = part.trim();
			if (!tag) continue;
			const normalized = tag.toLowerCase();
			if (seen.has(normalized)) continue;
			seen.add(normalized);
			tags.push(tag);
		}
		return tags;
	}

	private submitEdit(session: SessionSummary, event: Event) {
		event.preventDefault();
		event.stopPropagation();
		if (this.editingSessionId !== session.id || !this.editingField) return;

		if (this.editingField === "title") {
			const title = this.editValue.trim();
			if (!title || title === (session.title ?? "")) {
				this.cancelEdit();
				return;
			}
			this.dispatch("update-session", {
				sessionId: session.id,
				updates: { title },
			});
			this.cancelEdit();
			return;
		}

		const tags = this.parseTags(this.editValue);
		const currentTags = session.tags ?? [];
		if (
			tags.length === currentTags.length &&
			tags.every((tag, index) => tag === currentTags[index])
		) {
			this.cancelEdit();
			return;
		}
		this.dispatch("update-session", {
			sessionId: session.id,
			updates: { tags },
		});
		this.cancelEdit();
	}

	private isEditingSession(
		sessionId: string,
		field?: SessionEditField,
	): boolean {
		if (this.editingSessionId !== sessionId) return false;
		return field ? this.editingField === field : true;
	}

	private renderCloseIcon() {
		return html`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
			<path d="M18 6 6 18M6 6l12 12"></path>
		</svg>`;
	}

	private renderFavoriteIcon(favorite: boolean) {
		return html`${favorite ? "★" : "☆"}`;
	}

	override render() {
		if (this.shared) {
			return html`
				<div class="sidebar-header">
					<h2>Shared</h2>
					<button
						class="new-session-btn"
						@click=${() => this.dispatch("exit-shared")}
					>
						Exit
					</button>
				</div>
				<div class="sessions-list">
					<div class="loading">Read-only shared session</div>
				</div>
			`;
		}

		const sessions = this.filteredSessions;

		return html`
			<div class="sidebar-header">
				<h2>Sessions</h2>
				<button
					class="new-session-btn"
					@click=${() => this.dispatch("new-session")}
				>
					New Chat
				</button>
				<input
					type="search"
					placeholder="Filter..."
					.value=${this.sessionSearch}
					@input=${(event: Event) => {
						this.sessionSearch = (
							event.target as HTMLInputElement
						).value.toLowerCase();
					}}
					class="session-search"
				/>
			</div>
			<div class="sessions-list">
				${
					sessions.length === 0
						? html`<div class="empty">${this.sessions.length === 0 ? "No sessions yet" : "No sessions found"}</div>`
						: sessions.map(
								(session) => html`
								<div
									class="session-item ${
										this.currentSessionId === session.id ? "active" : ""
									}"
									role="button"
									tabindex="0"
									@click=${() =>
										this.dispatch("select-session", {
											sessionId: session.id,
										})}
									@keydown=${(event: KeyboardEvent) => {
										if (event.key !== "Enter" && event.key !== " ") return;
										event.preventDefault();
										this.dispatch("select-session", {
											sessionId: session.id,
										});
									}}
								>
									<div class="session-item-body">
										<div class="session-title">
											${session.title || "Untitled Session"}
										</div>
										<div class="session-meta">
											${this.formatSessionDate(session.updatedAt)} • ${session.messageCount || 0} msgs
										</div>
										${
											session.tags?.length
												? html`<div class="session-tags">
													${session.tags.map(
														(tag) =>
															html`<span class="session-tag">#${tag}</span>`,
													)}
												</div>`
												: ""
										}
										${
											this.isEditingSession(session.id)
												? html`<form
													class="session-editor"
													@click=${(event: Event) => event.stopPropagation()}
													@keydown=${(event: Event) => event.stopPropagation()}
													@submit=${(event: Event) => this.submitEdit(session, event)}
												>
													<input
														class="session-editor-input"
														type="text"
														placeholder=${
															this.isEditingSession(session.id, "title")
																? "Rename session"
																: "tag-a, tag-b"
														}
														.value=${this.editValue}
														@input=${(event: Event) => {
															this.editValue = (
																event.target as HTMLInputElement
															).value;
														}}
													/>
													<div class="session-editor-actions">
														<button type="submit" class="session-link-btn">Save</button>
														<button
															type="button"
															class="session-link-btn"
															@click=${(event: Event) => this.cancelEdit(event)}
														>
															Cancel
														</button>
													</div>
												</form>`
												: html`<div class="session-tools">
													<button
														type="button"
														class="session-link-btn"
														title="Rename session"
														@click=${(event: Event) =>
															this.beginEdit(session, "title", event)}
													>
														rename
													</button>
													<button
														type="button"
														class="session-link-btn"
														title="Edit tags"
														@click=${(event: Event) =>
															this.beginEdit(session, "tags", event)}
													>
														tags
													</button>
												</div>`
										}
									</div>
									<div class="session-actions">
										<button
											type="button"
											class="icon-btn favorite-btn ${session.favorite ? "active" : ""}"
											title=${session.favorite ? "Remove favorite" : "Favorite"}
											@click=${(event: Event) => {
												event.stopPropagation();
												this.dispatch("update-session", {
													sessionId: session.id,
													updates: { favorite: !session.favorite },
												});
											}}
										>
											${this.renderFavoriteIcon(Boolean(session.favorite))}
										</button>
										<button
											type="button"
											class="icon-btn"
											title="Delete"
											@click=${(event: Event) => {
												event.stopPropagation();
												this.dispatch("delete-session", {
													sessionId: session.id,
												});
											}}
										>
											${this.renderCloseIcon()}
										</button>
									</div>
								</div>
							`,
							)
				}
			</div>
		`;
	}
}
