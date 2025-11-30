import type { TUI } from "@evalops/tui";
import type { ModalManager } from "../modal-manager.js";
import { ThemeSelectorComponent } from "./theme-selector.js";

interface ThemeSelectorViewOptions {
	currentTheme: string | (() => string);
	modalManager: ModalManager;
	ui: TUI;
	showInfoMessage: (text: string) => void;
	onThemeChange?: () => void;
}

export class ThemeSelectorView {
	private selector: ThemeSelectorComponent | null = null;

	constructor(private readonly options: ThemeSelectorViewOptions) {}

	private getCurrentTheme(): string {
		return typeof this.options.currentTheme === "function"
			? this.options.currentTheme()
			: this.options.currentTheme;
	}

	show(): void {
		if (this.selector) {
			return;
		}
		this.selector = new ThemeSelectorComponent(
			this.getCurrentTheme(),
			(themeName) => {
				this.options.showInfoMessage(`Theme: ${themeName}`);
				this.options.onThemeChange?.();
				this.hide();
				this.options.ui.requestRender();
			},
			() => {
				// Cancelled - theme already restored by component
				this.options.onThemeChange?.();
				this.hide();
				this.options.ui.requestRender();
			},
			(_themeName) => {
				// Live preview - just trigger re-render
				this.options.onThemeChange?.();
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
