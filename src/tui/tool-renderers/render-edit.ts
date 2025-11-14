import chalk from "chalk";
import type { ToolRenderArgs, ToolRenderer } from "./types.js";
import {
	buildCollapsedSummary,
	generateDiff,
	shortenPath,
} from "../tool-text-utils.js";

export class EditRenderer implements ToolRenderer {
	render(context: ToolRenderArgs): string {
		const path = shortenPath(context.args?.file_path || context.args?.path || "");
		let text = `${chalk.hex("#fcd5ce")("✧ edit")} ${
			path ? chalk.cyan(path) : chalk.dim("...")
		}`;

		if (context.collapsed) {
			const diffText =
				context.result?.details?.diff || this.getTextOutput(context);
			text += `\n${chalk.dim(buildCollapsedSummary(diffText))}`;
			return text;
		}

		if (context.result?.details?.diff) {
			const diffLines = context.result.details.diff.split("\n");
			const coloredLines = diffLines.map((line: string) => {
				if (line.startsWith("+")) {
					return chalk.green(line);
				}
				if (line.startsWith("-")) {
					return chalk.red(line);
				}
				return chalk.dim(line);
			});
			text += `\n\n${coloredLines.join("\n")}`;
		} else if (context.args?.before && context.args?.after) {
			text += `\n\n${generateDiff(context.args.before, context.args.after)}`;
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
