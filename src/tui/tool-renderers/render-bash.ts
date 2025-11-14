import chalk from "chalk";
import { buildCollapsedSummary } from "../tool-text-utils.js";
import type { ToolRenderArgs, ToolRenderer } from "./types.js";

export class BashRenderer implements ToolRenderer {
	render(context: ToolRenderArgs): string {
		const command = context.args?.command || "";
		let text = `${chalk.hex("#eab676")("⟢ bash")}\n${chalk.bold(
			`$ ${command || chalk.dim("...")}`,
		)}`;

		if (context.collapsed && context.result) {
			text += `\n${chalk.dim(buildCollapsedSummary())}`;
			return text;
		}

		if (context.result) {
			const output = this.getTextOutput(context).trim();
			if (output) {
				const lines = output.split("\n");
				const maxLines = 5;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				text += `\n\n${displayLines
					.map((line: string) => chalk.dim(line))
					.join("\n")}`;
				if (remaining > 0) {
					text += chalk.dim(`\n... (${remaining} more lines)`);
				}
			}
		}

		return text;
	}

	private getTextOutput(context: ToolRenderArgs): string {
		if (!context.result) return "";
		const textBlocks =
			context.result.content?.filter((c: any) => c.type === "text") || [];
		const imageBlocks =
			context.result.content?.filter((c: any) => c.type === "image") || [];

		let output = textBlocks.map((c: any) => c.text).join("\n");
		if (imageBlocks.length > 0) {
			const imageIndicators = imageBlocks
				.map((img: any) => `[Image: ${img.mimeType}]`)
				.join("\n");
			output = output ? `${output}\n${imageIndicators}` : imageIndicators;
		}
		return output;
	}
}
