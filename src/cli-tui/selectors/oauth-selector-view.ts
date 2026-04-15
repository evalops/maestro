import type { TUI } from "@evalops/tui";
import type { SupportedOAuthProvider } from "../../oauth/index.js";
import type { ModalManager } from "../modal-manager.js";
import { OAuthSelectorComponent } from "./oauth-selector.js";

interface OAuthSelectorViewOptions {
	modalManager: ModalManager;
	ui: TUI;
	mode: "login" | "logout";
	onProviderSelected: (providerId: SupportedOAuthProvider) => Promise<void>;
	onCancel: () => void;
}

export class OAuthSelectorView {
	private selector: OAuthSelectorComponent | null = null;

	constructor(private readonly options: OAuthSelectorViewOptions) {}

	show(): void {
		if (this.selector) {
			return;
		}

		this.selector = new OAuthSelectorComponent(
			this.options.mode,
			async (providerId) => {
				await this.options.onProviderSelected(providerId);
				this.hide();
			},
			() => {
				this.options.onCancel();
				this.hide();
			},
		);

		this.options.modalManager.push(this.selector);
	}

	private hide(): void {
		if (!this.selector) {
			return;
		}
		this.options.modalManager.pop();
		this.selector = null;
	}
}
