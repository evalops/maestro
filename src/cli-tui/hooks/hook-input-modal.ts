import { Container, Spacer, type TUI, Text } from "@evalops/tui";
import { theme } from "../../theme/theme.js";
import { CustomEditor } from "../custom-editor.js";
import type { Modal } from "../modal-manager.js";

export interface HookInputModalOptions {
	ui: TUI;
	title: string;
	description?: string;
	placeholder?: string;
	prefill?: string;
	onSubmit: (value: string) => void;
	onCancel: () => void;
}

export class HookInputModal extends Container implements Modal {
	private readonly editor: CustomEditor;

	constructor(private readonly options: HookInputModalOptions) {
		super();

		this.editor = new CustomEditor();
		this.editor.onSubmit = (text) => {
			this.options.onSubmit(text);
		};
		this.editor.onEscape = () => {
			this.options.onCancel();
		};

		if (options.prefill) {
			this.editor.setText(options.prefill);
		}

		this.addChild(new Text(theme.fg("accent", options.title), 1, 0));
		if (options.description) {
			this.addChild(new Text(theme.fg("muted", options.description), 1, 0));
		}
		if (options.placeholder) {
			this.addChild(new Text(theme.fg("dim", options.placeholder), 1, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(this.editor);
	}

	mount(): void {
		this.options.ui.setFocus(this.editor);
	}

	handleInput(data: string): void {
		this.editor.handleInput(data);
	}
}
