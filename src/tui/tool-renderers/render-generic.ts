import chalk from "chalk";
import {
	buildCollapsedSummary,
	formatDetailSections,
	formatJsonSnippet,
} from "../utils/tool-text-utils.js";
import type { ToolRenderArgs, ToolRenderer } from "./types.js";

export class GenericRenderer implements ToolRenderer {
	render(context: ToolRenderArgs): string {
		const args = context.result
			? context.args
			: (context.partialArgs ?? context.args);

		if (context.collapsed) {
			const combined = [
				JSON.stringify(context.args, null, 2),
				this.getTextOutput(context),
			]
				.filter(Boolean)
				.join("\n");
			return chalk.dim(buildCollapsedSummary(combined));
		}

		const sections: string[] = [];
		const argsLines = formatJsonSnippet(args);
		if (argsLines.length) {
			sections.push(argsLines.join("\n"));
		}

		const output = this.getTextOutput(context);
		if (output) {
			const lines = output.split("\n").map((line) => chalk.dim(line));
			if (lines.length) {
				sections.push(lines.join("\n"));
			}
		}

		if (!context.collapsed) {
			const detailSections = formatDetailSections(context.result?.details);
			sections.push(...detailSections);
		}

		if (sections.length === 0) {
			return chalk.dim("no output");
		}

		return sections.filter(Boolean).join("\n\n");
	}

	private getTextOutput(context: ToolRenderArgs): string {
		if (!context.result) return "";
		const { content } = context.result;
		if (typeof content === "string") {
			return content;
		}
		const textBlocks =
			Array.isArray(content) && content.length
				? content.filter(
						(c): c is { type: "text"; text: string } => c.type === "text",
					)
				: [];
		return textBlocks.map((c) => c.text).join("\n");
	}
}
