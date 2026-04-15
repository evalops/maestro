import type { Container, TUI } from "@evalops/tui";
import { Spacer, Text } from "@evalops/tui";
import chalk from "chalk";
import { getGlobalInstallCommand } from "../package-metadata.js";
import { type UpdateCheckResult, checkForUpdate } from "../update/check.js";

interface UpdateViewOptions {
	currentVersion: string;
	chatContainer: Container;
	ui: TUI;
	showError: (message: string) => void;
	runUpdateCheck?: (version: string) => Promise<UpdateCheckResult>;
}

export class UpdateView {
	constructor(private readonly options: UpdateViewOptions) {}

	async handleUpdateCommand(): Promise<void> {
		const runCheck =
			this.options.runUpdateCheck ??
			((version: string) => checkForUpdate(version));
		let result: UpdateCheckResult;
		try {
			result = await runCheck(this.options.currentVersion);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.options.showError(`Update check failed: ${message}`);
			return;
		}
		if (result.error) {
			this.options.showError(`Update check failed: ${result.error}`);
			return;
		}
		const {
			latestVersion,
			isUpdateAvailable,
			notes,
			currentVersion,
			sourceUrl,
		} = result;
		const header = chalk.bold("Maestro update");
		let summary: string;
		let instructions: string;
		if (isUpdateAvailable && latestVersion) {
			summary = chalk.hex("#22c55e")(
				`v${latestVersion} available (current v${currentVersion})`,
			);
			instructions = `${chalk.dim("Update with")} ${chalk.cyan(
				getGlobalInstallCommand("npm"),
			)}`;
		} else {
			summary = chalk.hex("#38bdf8")(
				`You're on the latest version (v${currentVersion}).`,
			);
			instructions = chalk.dim("No update needed.");
		}
		const noteSection = notes ? `\n\n${chalk.dim(notes)}` : "";
		const sourceLine = chalk.dim(`Update source: ${sourceUrl}`);
		const body = `${header}\n${summary}\n${instructions}${noteSection}\n\n${sourceLine}`;
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(body, 1, 0));
		this.options.ui.requestRender();
	}
}
