import chalk from "chalk";
import {
	buildCollapsedSummary,
	formatDetailSections,
	formatJsonSnippet,
	formatSection,
} from "../utils/tool-text-utils.js";
import type { ToolRenderArgs, ToolRenderer } from "./types.js";

export class GenericRenderer implements ToolRenderer {
	render(context: ToolRenderArgs): string {
		const args = context.result
			? context.args
			: (context.partialArgs ?? context.args);
		const label = context.toolName
			? `${context.toolName}`
			: (args?.name ?? "tool");
		const text = chalk.bold(`${chalk.hex("#d4d8ff")(`[${label}]`)}`);
		if (context.collapsed) {
			const combined = [
				JSON.stringify(context.args, null, 2),
				this.getTextOutput(context),
			]
				.filter(Boolean)
				.join("\n");
			return `${text}\n${chalk.dim(buildCollapsedSummary(combined))}`;
		}

		const sections: string[] = [];
		const argsLines = formatJsonSnippet(args);
		if (argsLines.length) {
			sections.push(formatSection("arguments", argsLines));
		}

		const output = this.getTextOutput(context);
		if (output) {
			const lines = output.split("\n").map((line) => chalk.dim(line));
			if (lines.length) {
				sections.push(formatSection("result", lines));
			}
		}

		if (!context.collapsed) {
			const detailSections = formatDetailSections(context.result?.details);
			sections.push(...detailSections);
		}

		if (sections.length === 0) {
			return text;
		}

		return `${text}\n\n${sections.filter(Boolean).join("\n\n")}`;
	}

	private getTextOutput(context: ToolRenderArgs): string {
		if (!context.result) return "";
		const textBlocks =
			context.result.content?.filter(
				(c): c is { type: "text"; text: string } => c.type === "text",
			) || [];
		return textBlocks.map((c) => c.text).join("\n");
	}
}
