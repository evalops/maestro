import { highlightCodeLines } from "../../style/code-highlighter.js";
import { theme } from "../../theme/theme.js";
import {
	buildCollapsedSummary,
	clampAnsiLines,
	formatDetailSections,
	formatSection,
	generateDiff,
	shortenPath,
} from "../utils/tool-text-utils.js";
import type { ToolRenderArgs, ToolRenderer } from "./types.js";

export class EditRenderer implements ToolRenderer {
	render(context: ToolRenderArgs): string {
		const terminalWidth = process.stdout.columns ?? 80;
		const maxDiffWidth = Math.max(48, Math.min(120, terminalWidth - 8));
		const diffStyle =
			process.env.COMPOSER_TUI_DIFF_STYLE?.toLowerCase() ?? "auto";
		const pathValue =
			typeof context.args?.file_path === "string"
				? context.args.file_path
				: typeof context.args?.path === "string"
					? context.args.path
					: "";
		const path = shortenPath(pathValue);

		// Show path as the first line
		const pathLine = path ? theme.fg("muted", path) : theme.fg("dim", "...");

		if (context.collapsed) {
			const diffText =
				(typeof context.result?.details === "object" &&
					context.result?.details !== null &&
					"diff" in context.result.details &&
					typeof (context.result.details as { diff?: unknown }).diff ===
						"string" &&
					(context.result.details as { diff: string }).diff) ||
				this.getTextOutput(context);
			return `${pathLine}\n${theme.fg("dim", buildCollapsedSummary(diffText))}`;
		}

		const sections: string[] = [pathLine];
		const details =
			typeof context.result?.details === "object"
				? (context.result.details as Record<string, unknown>)
				: null;
		const diffValue =
			details && typeof details.diff === "string" ? details.diff : null;
		if (diffValue) {
			const diffLines = highlightCodeLines(diffValue, "diff");
			const shouldCompact = diffStyle === "auto" && terminalWidth < 90;
			const renderedLines = shouldCompact
				? clampAnsiLines(
						diffLines
							.slice(0, 80)
							.concat(
								diffLines.length > 80
									? [`${theme.fg("dim", "... truncated ...")}`]
									: [],
							),
						maxDiffWidth,
					)
				: clampAnsiLines(diffLines, maxDiffWidth);
			sections.push(renderedLines.join("\n"));
		} else if (
			typeof context.args?.before === "string" &&
			typeof context.args?.after === "string"
		) {
			const previewLines = clampAnsiLines(
				generateDiff(context.args.before, context.args.after).split("\n"),
				maxDiffWidth,
			);
			sections.push(previewLines.join("\n"));
		}

		const message = this.getTextOutput(context).trim();
		if (message) {
			const messageLines = message
				.split("\n")
				.map((line) => theme.fg("dim", line));
			sections.push(messageLines.join("\n"));
		}

		const detailSections = formatDetailSections(context.result?.details, {
			excludeKeys: ["diff"],
		});
		sections.push(...detailSections);

		return sections.filter(Boolean).join("\n\n");
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
