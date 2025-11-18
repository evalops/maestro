import chalk from "chalk";
import { highlightCodeLines } from "../../style/code-highlighter.js";
import {
	buildCollapsedSummary,
	formatDetailSections,
	formatSection,
	generateDiff,
	shortenPath,
} from "../tool-text-utils.js";
import type { ToolRenderArgs, ToolRenderer } from "./types.js";

export class EditRenderer implements ToolRenderer {
	render(context: ToolRenderArgs): string {
		const path = shortenPath(
			context.args?.file_path || context.args?.path || "",
		);
		let text = `${chalk.hex("#fcd5ce")("[edit]")} ${
			path ? chalk.cyan(path) : chalk.dim("...")
		}`;

		if (context.collapsed) {
			const diffText =
				context.result?.details?.diff || this.getTextOutput(context);
			text += `\n${chalk.dim(buildCollapsedSummary(diffText))}`;
			return text;
		}

		const sections: string[] = [];
		if (context.result?.details?.diff) {
			const diffLines = highlightCodeLines(context.result.details.diff, "diff");
			const diffSection = formatSection("diff", diffLines);
			if (diffSection) {
				sections.push(diffSection);
			}
		} else if (context.args?.before && context.args?.after) {
			const previewSection = formatSection(
				"preview",
				generateDiff(context.args.before, context.args.after).split("\n"),
			);
			if (previewSection) {
				sections.push(previewSection);
			}
		}

		const message = this.getTextOutput(context).trim();
		if (message) {
			const messageSection = formatSection(
				"result",
				message.split("\n").map((line) => chalk.dim(line)),
			);
			if (messageSection) {
				sections.push(messageSection);
			}
		}

		const detailSections = formatDetailSections(context.result?.details, {
			excludeKeys: ["diff"],
		});
		sections.push(...detailSections);

		if (sections.length === 0) {
			return text;
		}

		return `${text}\n\n${sections.filter(Boolean).join("\n\n")}`;
	}

	private getTextOutput(context: ToolRenderArgs): string {
		if (!context.result) return "";
		const textBlocks =
			context.result.content?.filter((c: any) => c.type === "text") || [];
		return textBlocks.map((c: any) => c.text).join("\n");
	}
}
