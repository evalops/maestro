import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionSummary } from "../services/api-client.js";

type SessionEditField = "tags" | "title";

@customElement("composer-session-sidebar")
export class ComposerSessionSidebar extends LitElement {
	static override styles = css`
		:host {
			width: 272px;
			background: var(--bg-deep, #161718);
			border-right: 1px solid var(--border-subtle, #1f2022);
			display: flex;
			flex-direction: column;
			transition: transform 0.2s ease;
			z-index: 20;
			padding: 0.5rem 0.5rem 0.75rem;
		}

		:host([collapsed]) {
			transform: translateX(-100%);
		}

		.sidebar-header {
			padding: 0.5rem 0.5rem 0.75rem;
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
			border-bottom: none;
		}

		.sidebar-header h2 {
			font-family: var(--font-sans, "Inter", sans-serif);
			font-size: 0.7rem;
			font-weight: 500;
			margin: 0.5rem 0 0.25rem;
			padding: 0 0.4rem;
			color: var(--text-tertiary, #8e8e8e);
			letter-spacing: 0.01em;
			text-transform: none;
		}

		.session-search {
			width: 100%;
			padding: 0.5rem 0.7rem;
			background: var(--bg-elevated, #232427);
			border: 1px solid transparent;
			color: var(--text-primary, #ececec);
			border-radius: var(--radius-md, 10px);
			font-family: var(--font-sans, "Inter", sans-serif);
			font-size: 0.78rem;
			transition: border-color 0.15s ease, background 0.15s ease;
		}

		.session-search:focus-visible {
			border-color: var(--border-secondary, #3a3d42);
			background: var(--bg-surface, #26282b);
		}

		.session-search::placeholder {
			color: var(--text-tertiary, #8e8e8e);
		}

		.new-session-btn {
			width: 100%;
			padding: 0.55rem 0.7rem;
			background: transparent;
			color: var(--text-primary, #ececec);
			border: none;
			border-radius: var(--radius-md, 10px);
			font-family: var(--font-sans, "Inter", sans-serif);
			font-size: 0.82rem;
			font-weight: 500;
			cursor: pointer;
			transition: background 0.12s ease;
			display: flex;
			align-items: center;
			justify-content: flex-start;
			gap: 0.6rem;
			text-transform: none;
			letter-spacing: 0;
		}

		.new-session-btn::before {
			content: "+";
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 18px;
			height: 18px;
			font-weight: 400;
			font-size: 1rem;
			color: var(--text-secondary, #b4b4b4);
		}

		.new-session-btn:hover {
			background: var(--bg-elevated, #232427);
			color: var(--text-primary, #ececec);
		}

		.new-session-btn:active {
			transform: none;
		}

		.sessions-list {
			flex: 1;
			overflow-y: auto;
			padding: 0.25rem 0.25rem 0.5rem;
		}

		.session-item {
			width: 100%;
			padding: 0.55rem 0.7rem;
			margin-bottom: 2px;
			cursor: pointer;
			transition: background 0.12s ease;
			background: transparent;
			border: none;
			border-left: none;
			border-radius: var(--radius-md, 10px);
			position: relative;
			text-align: left;
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 0.5rem;
		}

		.session-item:hover {
			background: var(--bg-elevated, #232427);
		}

		.session-item.active {
			background: var(--bg-surface, #26282b);
			border-left-color: transparent;
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
			font-family: var(--font-sans, "Inter", sans-serif);
			font-size: 0.82rem;
			font-weight: 500;
			margin-bottom: 0.15rem;
			color: var(--text-primary, #ececec);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			letter-spacing: -0.005em;
		}

		.session-item.active .session-title {
			color: var(--text-primary, #ececec);
		}

		.session-meta {
			font-family: var(--font-sans, "Inter", sans-serif);
			font-size: 0.7rem;
			color: var(--text-tertiary, #8e8e8e);
		}

		.session-resume {
			margin-top: 0.35rem;
			font-family: var(--font-sans, "Inter", sans-serif);
			font-size: 0.7rem;
			line-height: 1.45;
			color: var(--text-secondary, #b4b4b4);
		}

		.session-tags {
			display: flex;
			gap: 0.25rem;
			flex-wrap: wrap;
			margin-top: 0.4rem;
		}

		.session-tag {
			border: 1px solid var(--border-secondary, #3a3d42);
			border-radius: 999px;
			padding: 0.1rem 0.45rem;
			font-family: var(--font-sans, "Inter", sans-serif);
			font-size: 0.6rem;
			color: var(--text-tertiary, #8e8e8e);
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
			color: var(--text-tertiary, #8e8e8e);
			font-family: var(--font-sans, "Inter", sans-serif);
			font-size: 0.65rem;
			text-transform: none;
			letter-spacing: 0;
			cursor: pointer;
		}

		.session-link-btn:hover {
			color: var(--text-primary, #ececec);
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
			font-family: var(--font-sans, 'Inter', sans-serif);
			font-size: 0.72rem;
		}

		.session-editor-actions {
			display: flex;
			gap: 0.5rem;
		}

		.icon-btn {
			width: 24px;
			height: 24px;
			padding: 0;
			background: transparent;
			border: none;
			border-radius: var(--radius-sm, 6px);
			color: var(--text-tertiary, #8e8e8e);
			cursor: pointer;
			transition: background 0.12s ease, color 0.12s ease;
			display: flex;
			align-items: center;
			justify-content: center;
			flex-shrink: 0;
			font-size: 0.85rem;
		}

		.icon-btn:hover {
			background: var(--bg-panel, #2c2e31);
			color: var(--text-primary, #ececec);
		}

		.favorite-btn.active {
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
			font-family: var(--font-sans, "Inter", sans-serif);
			font-size: 0.78rem;
			color: var(--text-tertiary, #8e8e8e);
			padding: 0.6rem 0.7rem;
		}

		.section-label {
			font-family: var(--font-sans, "Inter", sans-serif);
			font-size: 0.7rem;
			font-weight: 500;
			color: var(--text-tertiary, #8e8e8e);
			padding: 0.5rem 0.7rem 0.35rem;
			letter-spacing: 0.005em;
		}

		.sidebar-footer {
			border-top: 1px solid var(--border-subtle, #1f2022);
			padding: 0.5rem 0.25rem 0.25rem;
			margin-top: 0.25rem;
		}

		.footer-link {
			width: 100%;
			padding: 0.55rem 0.7rem;
			background: transparent;
			color: var(--text-secondary, #b4b4b4);
			border: none;
			border-radius: var(--radius-md, 10px);
			font-family: var(--font-sans, "Inter", sans-serif);
			font-size: 0.82rem;
			font-weight: 500;
			cursor: pointer;
			transition: background 0.12s ease, color 0.12s ease;
			display: flex;
			align-items: center;
			gap: 0.6rem;
			text-align: left;
		}

		.footer-link::before {
			content: "⚙";
			font-size: 0.95rem;
			color: var(--text-tertiary, #8e8e8e);
		}

		.footer-link:hover {
			background: var(--bg-elevated, #232427);
			color: var(--text-primary, #ececec);
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

	private formatResumeSummary(summary: string | undefined): string | null {
		if (typeof summary !== "string") {
			return null;
		}
		const normalized = summary.trim();
		if (!normalized) {
			return null;
		}
		if (normalized.length <= 140) {
			return normalized;
		}
		return `${normalized.slice(0, 139).trimEnd()}…`;
	}

	private get filteredSessions(): SessionSummary[] {
		const query = this.sessionSearch.trim().toLowerCase();
		const filtered = this.sessions.filter((session) => {
			if (!query) return true;
			const title = session.title?.toLowerCase() ?? "";
			const id = session.id?.toLowerCase() ?? "";
			const resumeSummary = session.resumeSummary?.toLowerCase() ?? "";
			const tags = session.tags?.join(" ").toLowerCase() ?? "";
			return (
				title.includes(query) ||
				id.includes(query) ||
				resumeSummary.includes(query) ||
				tags.includes(query)
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
				<button
					class="new-session-btn"
					@click=${() => this.dispatch("new-session")}
				>
					New chat
				</button>
				<input
					type="search"
					placeholder="Search sessions"
					.value=${this.sessionSearch}
					@input=${(event: Event) => {
						this.sessionSearch = (
							event.target as HTMLInputElement
						).value.toLowerCase();
					}}
					class="session-search"
				/>
				<h2>Sessions</h2>
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
											this.formatResumeSummary(session.resumeSummary)
												? html`<div class="session-resume">
													${this.formatResumeSummary(session.resumeSummary)}
												</div>`
												: ""
										}
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
			<div class="sidebar-footer">
				<button
					type="button"
					class="footer-link"
					@click=${() => this.dispatch("open-settings")}
				>
					Settings
				</button>
			</div>
		`;
	}
}
