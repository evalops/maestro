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

export class ReadRenderer implements ToolRenderer {
	render(context: ToolRenderArgs): string {
		const args = context.result
			? context.args
			: (context.partialArgs ?? context.args);
		const path = shortenPath(args?.file_path || args?.path || "");
		let text = `${chalk.hex("#7bc7ff")("✦ read")} ${
			path ? chalk.cyan(path) : chalk.dim("...")
		}`;

		if (context.collapsed) {
			const summary = context.result
				? buildCollapsedSummary(this.getTextOutput(context))
				: "output hidden: awaiting result";
			return `${text}\n${chalk.dim(summary)}`;
		}

		if (context.result) {
			const output = this.getTextOutput(context);
			const { lines, remaining } = summarizeLines(output, 10);
			const displayLines = lines.map((line: string) =>
				chalk.dim(replaceTabs(line)),
			);
			if (displayLines.length) {
				text += `\n\n${formatSection("content", displayLines)}`;
			}
			if (remaining > 0) {
				text += chalk.dim(`\n... (${remaining} more lines)`);
			}

			const detailSections = formatDetailSections(context.result.details, {
				excludeKeys: ["content"],
			});
			if (detailSections.length) {
				text += `\n\n${detailSections.join("\n\n")}`;
			}
		}

		return text;
	}

	private getTextOutput(context: ToolRenderArgs): string {
		if (!context.result) return "";
		const textBlocks =
			context.result.content?.filter((c: any) => c.type === "text") || [];
		return textBlocks.map((c: any) => c.text).join("\n");
	}
}
