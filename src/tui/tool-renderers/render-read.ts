import chalk from "chalk";
import {
	buildCollapsedSummary,
	replaceTabs,
	shortenPath,
} from "../tool-text-utils.js";
import type { ToolRenderArgs, ToolRenderer } from "./types.js";

export class ReadRenderer implements ToolRenderer {
	render(context: ToolRenderArgs): string {
		const path = shortenPath(
			context.args?.file_path || context.args?.path || "",
		);
		let text = `${chalk.hex("#7bc7ff")("✦ read")} ${
			path ? chalk.cyan(path) : chalk.dim("...")
		}`;

		if (context.collapsed) {
			const summary = context.result
				? buildCollapsedSummary()
				: "output hidden: awaiting result";
			text += `\n${chalk.dim(summary)}`;
			return text;
		}

		if (context.result) {
			const output = this.getTextOutput(context);
			const lines = output.split("\n");
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

	private getTextOutput(context: ToolRenderArgs): string {
		if (!context.result) return "";
		const textBlocks =
			context.result.content?.filter((c: any) => c.type === "text") || [];
		return textBlocks.map((c: any) => c.text).join("\n");
	}
}
