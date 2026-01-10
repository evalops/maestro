import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { WebSlashCommand } from "./slash-commands.js";

@customElement("command-drawer")
export class CommandDrawer extends LitElement {
	static override styles = css`
		:host {
			position: fixed;
			inset: 0;
			display: none;
			z-index: 4000;
		}
		:host([open]) {
			display: block;
		}
		.backdrop {
			position: absolute;
			inset: 0;
			background: rgba(0, 0, 0, 0.45);
		}
		.panel {
			position: absolute;
			left: 50%;
			top: 15%;
			transform: translateX(-50%);
			width: min(720px, 94vw);
			background: var(--bg-secondary, #121417);
			border: 1px solid var(--border-primary, #1e2023);
			border-radius: 10px;
			box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
			padding: 14px 16px 10px;
			color: var(--text-primary, #e8e9eb);
			font-family: var(--font-mono, "JetBrains Mono", monospace);
		}
		.header {
			display: flex;
			align-items: center;
			gap: 10px;
			margin-bottom: 12px;
		}
		input {
			flex: 1;
			background: var(--bg-primary, #0c0d0f);
			border: 1px solid var(--border-primary, #1e2023);
			color: inherit;
			padding: 10px 12px;
			border-radius: 6px;
			outline: none;
		}
		input:focus {
			border-color: var(--accent-amber, #d4a012);
		}
		.list {
			max-height: 360px;
			overflow-y: auto;
		}
		.row {
			padding: 10px 8px;
			border-radius: 6px;
			display: flex;
			justify-content: space-between;
			align-items: center;
			cursor: pointer;
		}
		.row:hover,
		.row.selected {
			background: rgba(212, 160, 18, 0.12);
			color: var(--accent-amber, #d4a012);
		}
		.meta {
			display: flex;
			flex-direction: column;
			gap: 4px;
		}
		.usage {
			color: var(--text-tertiary, #6b7280);
			font-size: 0.78rem;
		}
		.desc {
			color: var(--text-secondary, #9ca3af);
			font-size: 0.82rem;
		}
		.badges {
			display: flex;
			gap: 6px;
			flex-wrap: wrap;
		}
		.badge {
			font-size: 0.65rem;
			padding: 2px 6px;
			border: 1px solid var(--border-primary, #1e2023);
			border-radius: 4px;
		}
		.fav {
			color: var(--accent-amber, #d4a012);
		}
	`;

	@property({ type: Boolean, reflect: true }) open = false;
	@property({ type: Array }) commands: WebSlashCommand[] = [];
	@property({ type: Array }) favorites: string[] = [];
	@property({ type: Array }) recents: string[] = [];
	@state() private query = "";
	@state() private selected = 0;

	private get scored() {
		const lower = this.query.toLowerCase();
		return this.commands
			.map((cmd) => ({
				cmd,
				score: this.score(cmd, lower),
			}))
			.filter((s) => s.score > 0 || !lower)
			.sort(
				(a, b) => b.score - a.score || a.cmd.name.localeCompare(b.cmd.name),
			);
	}

	private score(cmd: WebSlashCommand, q: string): number {
		let s = 0;
		const name = cmd.name.toLowerCase();
		if (!q) s += 1;
		if (name === q) s += 100;
		if (name.startsWith(q)) s += 70;
		if (name.includes(q)) s += 15;
		if (cmd.tags?.some((t) => t.includes(q))) s += 10;
		if (this.favorites.includes(cmd.name)) s += 25;
		if (this.recents.includes(cmd.name)) s += 5;
		return s;
	}

	private select(index: number) {
		const item = this.scored[index];
		if (!item) return;
		this.dispatchEvent(
			new CustomEvent("select-command", {
				detail: item.cmd.name,
				bubbles: true,
				composed: true,
			}),
		);
	}

	private toggleFavorite(name: string) {
		this.dispatchEvent(
			new CustomEvent("toggle-favorite", {
				detail: name,
				bubbles: true,
				composed: true,
			}),
		);
	}

	private onKey(e: KeyboardEvent) {
		if (e.key === "Escape") {
			this.dispatchEvent(
				new CustomEvent("close", { bubbles: true, composed: true }),
			);
			return;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			this.selected = (this.selected + 1) % Math.max(this.scored.length, 1);
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			this.selected =
				(this.selected - 1 + Math.max(this.scored.length, 1)) %
				Math.max(this.scored.length, 1);
		}
		if (e.key === "Enter") {
			e.preventDefault();
			this.select(this.selected);
		}
	}

	override render() {
		const rows = this.scored;
		return html`<div class="backdrop" @click=${() =>
			this.dispatchEvent(
				new CustomEvent("close", { bubbles: true, composed: true }),
			)}></div>
			<div class="panel" @keydown=${this.onKey} tabindex="0">
				<div class="header">
					<input
						type="text"
						placeholder="Search commands or type /"
						.value=${this.query}
						@input=${(e: InputEvent) => {
							const target = e.target as HTMLInputElement;
							this.query = target.value;
							this.selected = 0;
						}}
					/>
					<div class="badge">Ctrl/Cmd+K</div>
				</div>
				<div class="list">
					${rows.map(
						({ cmd }, i) => html`<div
							class="row ${i === this.selected ? "selected" : ""}"
							@click=${() => this.select(i)}
						>
							<div class="meta">
								<div class="desc">/${cmd.name}</div>
								<div class="usage">${cmd.usage}</div>
								<div class="desc">${cmd.description}</div>
								<div class="badges">
									${
										this.favorites.includes(cmd.name)
											? html`<span
												class="badge fav"
												@click=${(e: Event) => {
													e.stopPropagation();
													this.toggleFavorite(cmd.name);
												}}
											>
												★ favorite
											</span>`
											: html`<span
												class="badge"
												@click=${(e: Event) => {
													e.stopPropagation();
													this.toggleFavorite(cmd.name);
												}}
											>
												☆ favorite
											</span>`
									}
									${cmd.tags?.map(
										(tag) => html`<span class="badge">#${tag}</span>`,
									)}
								</div>
							</div>
						</div>`,
					)}
					${
						rows.length === 0
							? html`<div class="row">No commands found</div>`
							: null
					}
				</div>
			</div>`;
	}
}
