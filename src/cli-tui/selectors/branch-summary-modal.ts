import {
	Container,
	ControlCodes,
	Loader,
	type TUI,
	isCtrlC,
} from "@evalops/tui";
import type { Modal } from "../modal-manager.js";

interface BranchSummaryModalOptions {
	ui: TUI;
	message?: string;
	hint?: string;
	onCancel: () => void;
}

export class BranchSummaryModal extends Container implements Modal {
	private readonly loader: Loader;

	constructor(private readonly options: BranchSummaryModalOptions) {
		super();
		this.loader = new Loader(
			options.ui,
			options.message ?? "Summarizing branch...",
			{ mode: "default" },
		);
		this.loader.setHint(options.hint ?? "Press Esc to cancel");
		this.addChild(this.loader);
	}

	mount(): void {
		this.options.ui.setFocus(this);
	}

	handleInput(data: string): void {
		if (
			isCtrlC(data) ||
			data === "\x1b" ||
			data.charCodeAt(0) === ControlCodes.ESCAPE
		) {
			this.options.onCancel();
		}
	}

	dispose(): void {
		this.loader.stop();
	}
}
