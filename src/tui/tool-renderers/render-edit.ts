import chalk from "chalk";
import { highlightCodeLines } from "../../style/code-highlighter.js";
import { theme } from "../../theme/theme.js";
import {
	buildCollapsedSummary,
	formatDetailSections,
	formatSection,
	generateDiff,
	shortenPath,
} from "../utils/tool-text-utils.js";
import type { ToolRenderArgs, ToolRenderer } from "./types.js";

export class EditRenderer implements ToolRenderer {
	render(context: ToolRenderArgs): string {
		const pathValue =
			typeof context.args?.file_path === "string"
				? context.args.file_path
				: typeof context.args?.path === "string"
					? context.args.path
					: "";
		const path = shortenPath(pathValue);
		let text = `${theme.fg("accent", "[edit]")} ${
			path ? theme.fg("dim", path) : theme.fg("dim", "...")
		}`;

		if (context.collapsed) {
			const diffText =
				(typeof context.result?.details === "object" &&
					context.result?.details !== null &&
					"diff" in context.result.details &&
					typeof (context.result.details as { diff?: unknown }).diff ===
						"string" &&
					(context.result.details as { diff: string }).diff) ||
				this.getTextOutput(context);
			text += `\n${theme.fg("dim", buildCollapsedSummary(diffText))}`;
			return text;
		}

		const sections: string[] = [];
		const details =
			typeof context.result?.details === "object"
				? (context.result.details as Record<string, unknown>)
				: null;
		const diffValue =
			details && typeof details.diff === "string" ? details.diff : null;
		if (diffValue) {
			const diffLines = highlightCodeLines(diffValue, "diff");
			const diffSection = formatSection("diff", diffLines);
			if (diffSection) {
				sections.push(diffSection);
			}
		} else if (
			typeof context.args?.before === "string" &&
			typeof context.args?.after === "string"
		) {
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
				message.split("\n").map((line) => theme.fg("dim", line)),
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
