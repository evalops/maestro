import { type Container, Spacer, type TUI, Text } from "@evalops/tui";
import chalk from "chalk";

import type { RegisteredModel } from "../models/registry.js";
import type { UpdateCheckResult } from "../update/check.js";
import { formatLink } from "./utils/links.js";

export type StartupAnnouncementsOptions = {
	container: Container;
	ui: TUI;
	updateNotice?: UpdateCheckResult | null;
	startupChangelog?: string | null;
	startupChangelogSummary?: string | null;
	modelScope: RegisteredModel[];
	renderSuggestion?: string;
	onLayoutChange?: () => void;
};

export function renderStartupAnnouncements({
	container,
	ui,
	updateNotice,
	startupChangelog,
	startupChangelogSummary,
	modelScope,
	renderSuggestion = "/review src/cli-tui/tui-renderer.ts — summarize rendering flow",
	onLayoutChange,
}: StartupAnnouncementsOptions): void {
	container.clear();
	let announced = false;

	if (updateNotice) {
		const latest = updateNotice.latestVersion ?? "";
		const current = updateNotice.currentVersion;
		const notes = updateNotice.notes;
		const source = updateNotice.sourceUrl;
		const headline = chalk.hex("#f59e0b")(
			`Update available: v${latest || "unknown"}`,
		);
		const currentLine = chalk.dim(`Current version: v${current}`);
		const installLine = `${chalk.dim("Update with")} ${chalk.cyan(
			"npm install -g @evalops/maestro",
		)}`;
		const noteLine = notes ? chalk.dim(notes) : null;
		const sourceLine = source
			? chalk.dim(`Source: ${formatLink(source, "changelog")}`)
			: null;
		const message = [headline, currentLine, installLine, noteLine, sourceLine]
			.filter(Boolean)
			.join("\n");
		container.addChild(new Spacer(1));
		container.addChild(new Text(message, 1, 0));
		announced = true;
	}

	if (startupChangelog) {
		const header = chalk.bold.cyan("What's new");
		container.addChild(new Spacer(1));
		container.addChild(new Text(`${header}\n${startupChangelog}`, 1, 0));
		announced = true;
	} else if (startupChangelogSummary) {
		const line = `${chalk.bold.cyan("What's new")}: ${startupChangelogSummary} ${chalk.dim("(see CHANGELOG.md)")}`;
		container.addChild(new Spacer(1));
		container.addChild(new Text(line.trim(), 1, 0));
		const hintLine = chalk.dim("Hints: /changelog /model /thinking");
		container.addChild(new Text(hintLine, 1, 0));
		announced = true;
	} else if (!announced) {
		const example = chalk.dim(`Try: ${chalk.cyan(renderSuggestion)}`);
		container.addChild(new Spacer(1));
		container.addChild(new Text(example, 1, 0));
		announced = true;
	}

	if (modelScope.length > 0) {
		const names = modelScope.map((model) => model.name ?? model.id);
		const header = chalk.bold("Model scope");
		const scopeLines = [
			`${header}: ${names.join(", ")}`,
			chalk.dim("Press Ctrl+P to cycle scoped models."),
		];
		container.addChild(new Spacer(1));
		container.addChild(new Text(scopeLines.join("\n"), 1, 0));
		announced = true;
	}

	if (announced) {
		onLayoutChange?.();
		ui.requestRender();
	} else {
		container.clear();
		onLayoutChange?.();
	}
}
