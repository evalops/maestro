import chalk from "chalk";
import {
	buildCollapsedSummary,
	formatDetailSections,
	formatSection,
	replaceTabs,
	shortenPath,
	summarizeLines,
} from "../tool-text-utils.js";
import type { ToolRenderArgs, ToolRenderer } from "./types.js";

export class WriteRenderer implements ToolRenderer {
	render(context: ToolRenderArgs): string {
		const args = context.result
			? context.args
			: (context.partialArgs ?? context.args);
		const path = shortenPath(args?.file_path || args?.path || "");
		const fileContent = args?.content || "";
		const lines = fileContent ? fileContent.split("\n") : [];
		const totalLines = lines.length;

		let text = `${chalk.hex("#adf7b6")("✸ write")} ${
			path ? chalk.cyan(path) : chalk.dim("...")
		}`;
		if (totalLines > 10) {
			text += ` (${totalLines} lines)`;
		}

		if (context.collapsed) {
			return `${text}\n${chalk.dim(buildCollapsedSummary(fileContent))}`;
		}

		if (fileContent) {
			const { lines: preview, remaining } = summarizeLines(fileContent, 10);
			const formatted = preview.map((line: string) =>
				chalk.dim(replaceTabs(line)),
			);
			if (formatted.length) {
				text += `\n\n${formatSection("content", formatted)}`;
			}
			if (remaining > 0) {
				text += chalk.dim(`\n... (${remaining} more lines)`);
			}
		}

		if (context.result?.details) {
			const detailSections = formatDetailSections(context.result.details, {
				excludeKeys: ["content"],
			});
			if (detailSections.length) {
				text += `\n\n${detailSections.join("\n\n")}`;
			}
		}

		return text;
	}
}
