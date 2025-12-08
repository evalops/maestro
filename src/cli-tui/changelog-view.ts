import type { Container, TUI } from "@evalops/tui";
import { Markdown, Spacer, Text } from "@evalops/tui";
import chalk from "chalk";
import { getMarkdownTheme } from "../theme/theme.js";
import { getChangelogPath, parseChangelog } from "../update/changelog.js";

interface ChangelogViewOptions {
	chatContainer: Container;
	ui: TUI;
	showError: (message: string) => void;
}

export class ChangelogView {
	constructor(private readonly options: ChangelogViewOptions) {}

	handleChangelogCommand(): void {
		try {
			const changelogPath = getChangelogPath();
			const allEntries = parseChangelog(changelogPath);

			// Show all entries in reverse order (oldest first, newest last)
			const changelogMarkdown =
				allEntries.length > 0
					? [...allEntries]
							.reverse()
							.map((e) => e.content)
							.join("\n\n")
					: "No changelog entries found.";

			// Display in chat
			this.options.chatContainer.addChild(new Spacer(1));
			this.options.chatContainer.addChild(
				new Text(chalk.bold.cyan("📋 What's New"), 1, 0),
			);
			this.options.chatContainer.addChild(new Spacer(1));
			this.options.chatContainer.addChild(
				new Markdown(
					changelogMarkdown,
					undefined,
					undefined,
					undefined,
					1,
					0,
					getMarkdownTheme(),
				),
			);
			this.options.chatContainer.addChild(new Spacer(1));
			this.options.ui.requestRender();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.options.showError(`Failed to load changelog: ${message}`);
		}
	}
}
