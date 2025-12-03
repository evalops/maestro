import { theme } from "../../theme/theme.js";
import { formatHeadline, renderCard, statusGlyph } from "./render-style.js";
import { buildCollapsedSummary } from "../utils/tool-text-utils.js";
import type { ToolRenderArgs, ToolRenderer } from "./types.js";

type BatchResultEntry = {
	tool?: string;
	summary?: string;
	success?: boolean;
	result?: {
		content?: Array<{ type: string; text?: string }> | string;
		details?: unknown;
		isError?: boolean;
	};
};

export class BatchRenderer implements ToolRenderer {
	render(context: ToolRenderArgs): string {
		const results = this.getResults(context);
		const total = results.length;
		const failures = results.filter(
			(r) => r.success === false || r.result?.isError,
		).length;
		const successes = total - failures;
		const status: "success" | "error" | "pending" =
			failures > 0 ? "error" : context.result ? "success" : "pending";
		const summaryMeta =
			total === 0
				? "no tool calls"
				: `${total} tool${total === 1 ? "" : "s"} · ${successes} ok${
						failures ? ` · ${failures} err` : ""
					}`;
		const preview = this.getPreviewText(context);

		if (context.collapsed) {
			const headline = `${statusGlyph(status)} ${formatHeadline("batch", summaryMeta)}`;
			return preview
				? `${headline} ${theme.fg("dim", "— " + preview)}`
				: headline;
		}

		const lines: string[] = [];
		lines.push(`${statusGlyph(status)} ${formatHeadline("batch", summaryMeta)}`);
		if (preview) {
			lines.push(theme.fg("dim", preview));
		}

		const itemsToShow = results.slice(0, 8);
		const rowLines: string[] = [];
		for (let i = 0; i < itemsToShow.length; i++) {
			const entry = itemsToShow[i];
			const rowStatus =
				entry.success === false || entry.result?.isError ? "error" : "success";
			const summary =
				this.cleanSummary(entry.summary) ||
				this.extractTextSnippet(entry.result) ||
				"completed";
			const label = entry.tool ? entry.tool.toLowerCase() : `call ${i + 1}`;
			rowLines.push(
				`${statusGlyph(rowStatus)} ${theme.bold(label)} ${theme.fg("dim", "—")} ${theme.fg("muted", summary)}`,
			);
		}

		if (rowLines.length) {
			lines.push(renderCard(rowLines, { padding: 1 }));
		}

		if (results.length > itemsToShow.length) {
			lines.push(
				theme.fg(
					"muted",
					`… +${results.length - itemsToShow.length} more tool calls`,
				),
			);
		}

		return lines.join("\n");
	}

	private getResults(context: ToolRenderArgs): BatchResultEntry[] {
		const rawDetails = context.result?.details;
		if (!rawDetails || typeof rawDetails !== "object") return [];
		const results = (rawDetails as { results?: unknown }).results;
		if (!Array.isArray(results)) return [];
		return results.filter(Boolean) as BatchResultEntry[];
	}

	private getPreviewText(context: ToolRenderArgs): string | undefined {
		const content = context.result?.content;
		if (!content) return undefined;

		if (typeof content === "string") {
			return this.cleanSummary(content);
		}

		const textBlock = content.find((block) => block.type === "text");
		if (!textBlock?.text) return undefined;
		return this.cleanSummary(textBlock.text);
	}

	private cleanSummary(value?: string): string | undefined {
		if (!value) return undefined;
		const singleLine = value.replace(/\s+/g, " ").trim();
		if (!singleLine) return undefined;
		return singleLine.length > 120
			? `${singleLine.slice(0, 117)}…`
			: singleLine;
	}

	private extractTextSnippet(
		result?: BatchResultEntry["result"],
	): string | undefined {
		if (!result?.content) return undefined;

		if (typeof result.content === "string") {
			return (
				this.cleanSummary(result.content) ??
				buildCollapsedSummary(result.content)
			);
		}

		const firstText = result.content.find((c) => c.type === "text");
		if (!firstText?.text) return undefined;
		return (
			this.cleanSummary(firstText.text) ?? buildCollapsedSummary(firstText.text)
		);
	}
}
