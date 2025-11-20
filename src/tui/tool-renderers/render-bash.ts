import chalk from "chalk";
import {
	buildCollapsedSummary,
	formatDetailSections,
	formatSection,
	formatShellSnippet,
	summarizeLines,
} from "../utils/tool-text-utils.js";
import type { ToolRenderArgs, ToolRenderer } from "./types.js";

export class BashRenderer implements ToolRenderer {
	render(context: ToolRenderArgs): string {
		const args = context.result
			? context.args
			: (context.partialArgs ?? context.args);
		const command = args?.command || "";
		const text = chalk.hex("#eab676")("⟢ bash");
		const commandLines = formatShellSnippet(command ? `$ ${command}` : "$ ...");
		const sections: string[] = [];
		if (commandLines.length) {
			sections.push(formatSection("command", commandLines));
		}

		if (context.collapsed) {
			const summarySource = context.result
				? this.getTextOutput(context)
				: command;
			const summary = buildCollapsedSummary(summarySource);
			return `${text}\n${chalk.dim(summary)}`;
		}

		if (context.result) {
			const output = this.getTextOutput(context).trim();
			if (output) {
				const { lines, remaining } = summarizeLines(output, 5);
				const dimmed = lines.map((line) => chalk.dim(line));
				sections.push(formatSection("output", dimmed));
				if (remaining > 0) {
					sections.push(chalk.dim(`  ... (${remaining} more lines)`));
				}
			}
		}

		if (!context.collapsed) {
			const detailSections = formatDetailSections(context.result?.details, {
				excludeKeys: ["command", "output"],
			});
			sections.push(...detailSections);
		}

		if (sections.length === 0) {
			return `${text}\n${chalk.dim("waiting for output...")}`;
		}

		return `${text}\n\n${sections.filter(Boolean).join("\n\n")}`;
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
