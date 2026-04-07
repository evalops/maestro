import type { Container, TUI } from "@evalops/tui";
import type { ModalManager } from "../modal-manager.js";
import type {
	SessionDataProvider,
	SessionItem,
} from "./session-data-provider.js";
import { SessionSwitcherComponent } from "./session-switcher.js";

interface SessionSwitcherViewOptions {
	sessionDataProvider: SessionDataProvider;
	modalManager: ModalManager;
	ui: TUI;
	showInfoMessage: (text: string) => void;
	loadSession: (session: SessionItem) => boolean;
	summarizeSession: (session: SessionItem) => Promise<void>;
}

export class SessionSwitcherView {
	private switcher: SessionSwitcherComponent | null = null;

	constructor(private readonly options: SessionSwitcherViewOptions) {}

	show(): void {
		if (this.switcher) {
			return;
		}
		this.switcher = new SessionSwitcherComponent({
			dataProvider: this.options.sessionDataProvider,
			onSelect: (session) => {
				const loaded = this.options.loadSession(session);
				if (loaded) {
					this.hide();
				}
			},
			onCancel: () => {
				this.hide();
			},
			onToggleFavorite: (session, favorite) => {
				this.options.sessionDataProvider.toggleFavorite(session.path, favorite);
				const label = favorite ? "Favorited" : "Unfavorited";
				this.options.showInfoMessage(`${label} ${session.summary}`);
			},
			onSummarize: async (session) => {
				await this.options.summarizeSession(session);
				this.switcher?.refresh(true);
				this.options.ui.requestRender();
			},
		});
		this.options.modalManager.push(this.switcher);
	}

	private hide(): void {
		if (!this.switcher) {
			return;
		}
		this.options.modalManager.pop();
		this.switcher = null;
	}
}
