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
import { formatHeadline, renderCard, statusGlyph } from "./render-style.js";
import type { ToolRenderArgs, ToolRenderer } from "./types.js";

/** Count additions and deletions in a unified diff string */
function countDiffChanges(diffStr: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diffStr.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) {
			added++;
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			removed++;
		}
	}
	return { added, removed };
}

/** Build a summary bar for diff changes */
function buildDiffSummary(diffStr: string): string {
	const { added, removed } = countDiffChanges(diffStr);
	const parts: string[] = [];
	if (added > 0) {
		parts.push(theme.fg("success", `+${added}`));
	}
	if (removed > 0) {
		parts.push(theme.fg("error", `-${removed}`));
	}
	if (parts.length === 0) {
		return theme.fg("muted", "no changes");
	}
	return parts.join("  ");
}

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
		const status: "success" | "error" | "pending" =
			context.result?.isError === true
				? "error"
				: context.result
					? "success"
					: "pending";
		const headline = `${statusGlyph(status)} ${formatHeadline("edit", path || "file")}`;

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
			return `${headline}\n${renderCard([
				pathLine,
				theme.fg("dim", buildCollapsedSummary(diffText)),
			])}`;
		}

		const sections: string[] = [pathLine];
		const details =
			typeof context.result?.details === "object"
				? (context.result.details as Record<string, unknown>)
				: null;
		const diffValue =
			details && typeof details.diff === "string" ? details.diff : null;
		if (diffValue) {
			// Add summary bar
			const summary = buildDiffSummary(diffValue);
			sections.push(summary);

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

		return `${headline}\n${renderCard(
			sections
				.filter(Boolean)
				.flatMap((block) => block.split("\n"))
				.map((line) => line),
		)}`;
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
