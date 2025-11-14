import chalk from "chalk";
import type { ToolRenderArgs, ToolRenderer } from "./types.js";
import { buildCollapsedSummary, replaceTabs, shortenPath } from "../tool-text-utils.js";

export class WriteRenderer implements ToolRenderer {
	render(context: ToolRenderArgs): string {
		const path = shortenPath(context.args?.file_path || context.args?.path || "");
		const fileContent = context.args?.content || "";
		const lines = fileContent ? fileContent.split("\n") : [];
		const totalLines = lines.length;

		let text = `${chalk.hex("#adf7b6")("✸ write")} ${
			path ? chalk.cyan(path) : chalk.dim("...")
		}`;
		if (totalLines > 10) {
			text += ` (${totalLines} lines)`;
		}

		if (context.collapsed) {
			text += `\n${chalk.dim(buildCollapsedSummary(fileContent))}`;
			return text;
		}

		if (fileContent) {
			const maxLines = 10;
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;

			text += `\n\n${displayLines
				.map((line: string) => chalk.dim(replaceTabs(line)))
				.join("\n")}`;
			if (remaining > 0) {
				text += chalk.dim(`\n... (${remaining} more lines)`);
			}
		}

		return text;
	}
}
