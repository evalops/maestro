import type { Container, TUI } from "@evalops/tui";
import type { SupportedOAuthProvider } from "../../oauth/index.js";
import type { CustomEditor } from "../custom-editor.js";
import { OAuthSelectorComponent } from "./oauth-selector.js";

interface OAuthSelectorViewOptions {
	editor: CustomEditor;
	editorContainer: Container;
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

		this.options.editorContainer.clear();
		this.options.editorContainer.addChild(this.selector);
		this.options.ui.setFocus(this.selector);
		this.options.ui.requestRender();
	}

	private hide(): void {
		if (!this.selector) {
			return;
		}
		this.options.editorContainer.clear();
		this.options.editorContainer.addChild(this.options.editor);
		this.selector = null;
		this.options.ui.setFocus(this.options.editor);
		this.options.ui.requestRender();
	}
}
