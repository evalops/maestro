import type { Container, TUI } from "@evalops/tui";
import { Spacer, Text } from "@evalops/tui";
import { badge, muted } from "../style/theme.js";
import type { FooterComponent } from "./footer.js";

interface NotificationViewOptions {
	chatContainer: Container;
	ui: TUI;
	footer: FooterComponent;
}

export class NotificationView {
	constructor(private readonly options: NotificationViewOptions) {}

	showInfo(text: string): void {
		// Info messages still go to chat (non-intrusive status updates)
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(muted(text), 1, 0));
		this.options.ui.requestRender();
	}

	showError(errorMessage: string): void {
		// Errors go to footer toast for visibility
		this.options.footer.setToast(errorMessage, "danger");
		this.options.ui.requestRender();
	}

	showToast(
		text: string,
		tone: "info" | "warn" | "success" = "info",
		_shortcut?: string,
	): void {
		// Toasts go to footer for persistent visibility (until timeout)
		// Map 'info' tone to 'info' or 'success' depending on context if needed,
		// but FooterComponent supports 'info' | 'warn' | 'success' | 'danger'.
		// The shortcut arg is ignored as footer doesn't display it explicitly yet,
		// or we could append it.
		const message = _shortcut ? `${text} (${_shortcut})` : text;
		this.options.footer.setToast(message, tone === "info" ? "info" : tone);
		this.options.ui.requestRender();
	}
}
