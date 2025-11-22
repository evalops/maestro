import type { Container, TUI } from "@evalops/tui";
import { Spacer, Text } from "@evalops/tui";
import { badge, muted } from "../style/theme.js";
import type { StatusRailComponent } from "./status-rail.js";

interface NotificationViewOptions {
	chatContainer: Container;
	ui: TUI;
	statusRail?: StatusRailComponent;
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
		// Errors go to status rail for visibility
		if (this.options.statusRail) {
			this.options.statusRail.addToast(errorMessage, "danger");
			this.options.ui.requestRender();
		} else {
			// Fallback to chat if status rail not available
			this.options.chatContainer.addChild(new Spacer(1));
			const label = badge("Error", undefined, "danger");
			this.options.chatContainer.addChild(
				new Text(`${label} ${errorMessage}`, 1, 0),
			);
			this.options.ui.requestRender();
		}
	}

	showToast(
		text: string,
		tone: "info" | "warn" | "success" = "info",
		shortcut?: string,
	): void {
		// Toasts go to status rail for persistent visibility
		if (this.options.statusRail) {
			this.options.statusRail.addToast(text, tone, shortcut);
			this.options.ui.requestRender();
		} else {
			// Fallback to chat if status rail not available
			const toneLabel =
				tone === "warn"
					? badge("Warning", undefined, "warn")
					: tone === "success"
						? badge("Success", undefined, "success")
						: badge("Info", undefined, "info");
			this.options.chatContainer.addChild(new Spacer(1));
			this.options.chatContainer.addChild(
				new Text(`${toneLabel} ${text}`, 1, 0),
			);
			this.options.ui.requestRender();
		}
	}
}
