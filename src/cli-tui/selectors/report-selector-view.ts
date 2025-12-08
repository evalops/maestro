import type { TUI } from "@evalops/tui";
import type { ModalManager } from "../modal-manager.js";
import { ReportSelectorComponent, type ReportType } from "./report-selector.js";

interface ReportSelectorViewOptions {
	modalManager: ModalManager;
	ui: TUI;
	onSelect: (type: ReportType) => void;
}

export class ReportSelectorView {
	private selector: ReportSelectorComponent | null = null;

	constructor(private readonly options: ReportSelectorViewOptions) {}

	show(): void {
		if (this.selector) {
			return;
		}
		this.selector = new ReportSelectorComponent(
			(type) => {
				this.hide();
				this.options.onSelect(type);
				this.options.ui.requestRender();
			},
			() => {
				this.hide();
				this.options.ui.requestRender();
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

export type { ReportType };
