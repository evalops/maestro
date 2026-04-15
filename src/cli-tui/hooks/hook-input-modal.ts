import { Container, Spacer, type TUI, Text } from "@evalops/tui";
import { theme } from "../../theme/theme.js";
import { CustomEditor } from "../custom-editor.js";
import { getTuiKeybindingLabel } from "../keybindings.js";
import type { Modal } from "../modal-manager.js";
import { openExternalEditor } from "../utils/external-editor.js";

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
	private readonly statusLine: Text;
	private readonly hasExternalEditor: boolean;

	constructor(private readonly options: HookInputModalOptions) {
		super();

		this.editor = new CustomEditor();
		this.hasExternalEditor = Boolean(process.env.VISUAL || process.env.EDITOR);
		this.statusLine = new Text("", 1, 0);
		this.editor.onSubmit = (text) => {
			this.options.onSubmit(text);
		};
		this.editor.onEscape = () => {
			this.options.onCancel();
		};
		this.editor.onCtrlG = () => {
			if (!this.hasExternalEditor) {
				this.setStatus(
					"No editor configured. Set $VISUAL or $EDITOR environment variable.",
				);
				return;
			}
			const result = openExternalEditor(this.options.ui, this.editor.getText());
			if (result.error) {
				this.setStatus(result.error);
				return;
			}
			if (typeof result.updatedText === "string") {
				this.editor.setText(result.updatedText);
				this.setStatus("");
				this.options.ui.requestRender();
			}
		};

		if (options.prefill) {
			this.editor.setText(options.prefill);
		}

		this.addChild(new Text(theme.fg("accent", options.title), 1, 0));
		if (options.description) {
			this.addChild(new Text(theme.fg("muted", options.description), 1, 0));
		}
		if (this.hasExternalEditor) {
			this.addChild(
				new Text(
					theme.fg(
						"dim",
						`${getTuiKeybindingLabel("external-editor")} opens external editor`,
					),
					1,
					0,
				),
			);
		}
		if (options.placeholder) {
			this.addChild(new Text(theme.fg("dim", options.placeholder), 1, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(this.editor);
		this.addChild(this.statusLine);
	}

	mount(): void {
		this.options.ui.setFocus(this.editor);
	}

	handleInput(data: string): void {
		this.editor.handleInput(data);
	}

	private setStatus(message: string): void {
		this.statusLine.setText(message ? theme.fg("muted", message) : "");
		this.options.ui.requestRender();
	}
}
