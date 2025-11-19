import type { Container, TUI } from "@evalops/tui";
import { Spacer, Text } from "@evalops/tui";
import { badge, muted } from "../style/theme.js";

interface NotificationViewOptions {
	chatContainer: Container;
	ui: TUI;
}

export class NotificationView {
	constructor(private readonly options: NotificationViewOptions) {}

	showInfo(text: string): void {
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(muted(text), 1, 0));
		this.options.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.options.chatContainer.addChild(new Spacer(1));
		const label = badge("Error", undefined, "danger");
		this.options.chatContainer.addChild(
			new Text(`${label} ${errorMessage}`, 1, 0),
		);
		this.options.ui.requestRender();
	}

	showToast(text: string, tone: "info" | "warn" | "success" = "info"): void {
		const toneLabel =
			tone === "warn"
				? badge("Warning", undefined, "warn")
				: tone === "success"
					? badge("Success", undefined, "success")
					: badge("Info", undefined, "info");
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(`${toneLabel} ${text}`, 1, 0));
		this.options.ui.requestRender();
	}
}
