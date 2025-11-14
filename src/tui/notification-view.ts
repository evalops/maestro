import chalk from "chalk";
import type { Container, TUI } from "../tui-lib/index.js";
import { Spacer, Text } from "../tui-lib/index.js";

interface NotificationViewOptions {
	chatContainer: Container;
	ui: TUI;
}

export class NotificationView {
	constructor(private readonly options: NotificationViewOptions) {}

	showInfo(text: string): void {
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(chalk.dim(text), 1, 0));
		this.options.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(
			new Text(chalk.red(`Error: ${errorMessage}`), 1, 0),
		);
		this.options.ui.requestRender();
	}

	showToast(text: string, tone: "info" | "warn" | "success" = "info"): void {
		const color =
			tone === "warn"
				? chalk.hex("#f97316")
				: tone === "success"
					? chalk.hex("#10b981")
					: chalk.hex("#38bdf8");
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(color(`ℹ ${text}`), 1, 0));
		this.options.ui.requestRender();
	}
}
