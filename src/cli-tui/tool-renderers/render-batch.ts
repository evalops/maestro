import { theme } from "../../theme/theme.js";
import { truncateText } from "../utils/text-formatting.js";
import {
	buildCollapsedSummary,
	clampToolOutputLines,
	formatDetailSections,
	formatToolOutputTruncation,
} from "../utils/tool-text-utils.js";
import { formatHeadline, renderCard, statusGlyph } from "./render-style.js";
import type { ToolRenderArgs, ToolRenderer } from "./types.js";

type BatchResultEntry = {
	tool?: string;
	summary?: string;
	success?: boolean;
	result?: {
		content?:
			| Array<{
					type: string;
					text?: string;
			  }>
			| string;
		isError?: boolean;
	};
};

const SUMMARY_MAX_WIDTH = 120;

export class BatchRenderer implements ToolRenderer {
	render(context: ToolRenderArgs): string {
		const status: "success" | "error" | "pending" =
			context.result?.isError === true
				? "error"
				: context.result
					? "success"
					: "pending";
		const headline = `${statusGlyph(status)} ${formatHeadline("batch", "batch")}`;
		const sections: string[] = [];
		const results = this.getBatchResults(context);
		const stats = this.getBatchStats(results);
		const summaryLine = this.buildSummaryLine(stats, status);

		if (context.collapsed) {
			const preview = this.extractPreviewText(context, results);
			const summary = preview ? theme.fg("dim", preview) : "";
			return `${headline}\n${renderCard(
				[summaryLine, summary].filter(Boolean).map((line) => line),
			)}`;
		}

		if (summaryLine) {
			sections.push(summaryLine);
		}

		if (results.length > 0) {
			const rows = results.map((entry, index) =>
				this.formatResultRow(entry, index),
			);
			const clamped = clampToolOutputLines(rows);
			const banner = formatToolOutputTruncation({
				text: "",
				truncated: clamped.truncated,
				omittedChars: clamped.omittedChars,
				omittedLines: clamped.omittedLines,
			});
			if (clamped.lines.length > 0) {
				sections.push(clamped.lines.join("\n"));
			}
			if (banner) {
				sections.push(theme.fg("dim", banner));
			}
		} else if (context.result) {
			const preview = this.extractPreviewText(context, results);
			if (preview) {
				sections.push(theme.fg("dim", preview));
			} else {
				sections.push(theme.fg("dim", "No batch results reported."));
			}
		} else {
			sections.push(theme.fg("dim", "waiting for output..."));
		}

		const detailSections = formatDetailSections(context.result?.details, {
			excludeKeys: ["results"],
		});
		sections.push(...detailSections);

		return `${headline}\n${renderCard(
			sections
				.filter(Boolean)
				.flatMap((block) => block.split("\n"))
				.map((line) => line),
		)}`;
	}

	private getBatchResults(context: ToolRenderArgs): BatchResultEntry[] {
		const details = context.result?.details;
		if (!details || typeof details !== "object") return [];
		const results = (details as { results?: unknown }).results;
		if (!Array.isArray(results)) return [];
		return results.filter(Boolean) as BatchResultEntry[];
	}

	private getBatchStats(results: BatchResultEntry[]): {
		total: number;
		successes: number;
		failures: number;
	} {
		const total = results.length;
		const failures = results.filter((entry) => this.isErrorEntry(entry)).length;
		return { total, failures, successes: Math.max(0, total - failures) };
	}

	private isErrorEntry(entry: BatchResultEntry): boolean {
		return entry.success === false || entry.result?.isError === true;
	}

	private buildSummaryLine(
		stats: { total: number; successes: number; failures: number },
		status: "success" | "error" | "pending",
	): string {
		const statusLabel =
			status === "pending"
				? "running"
				: status === "error"
					? "errors"
					: "complete";
		const summaryParts = [
			theme.fg("muted", "Batch"),
			theme.fg("success", `${stats.successes} ok`),
			theme.fg(stats.failures ? "error" : "muted", `${stats.failures} err`),
			theme.fg("dim", statusLabel),
		];
		return summaryParts.join("  ");
	}

	private formatResultRow(entry: BatchResultEntry, index: number): string {
		const isError = this.isErrorEntry(entry);
		const glyph = isError ? theme.fg("error", "✕") : theme.fg("success", "✓");
		const toolLabel = entry.tool ? entry.tool : `call ${index + 1}`;
		const summary =
			entry.summary ||
			this.extractContentSummary(entry.result?.content) ||
			"Completed";
		const truncated = truncateText(summary, SUMMARY_MAX_WIDTH);
		return `${glyph} ${theme.fg("muted", toolLabel)} ${truncated}`;
	}

	private extractContentSummary(
		content: Array<{ type: string; text?: string }> | string | undefined,
	): string | null {
		if (!content) return null;
		if (typeof content === "string") {
			return content.replace(/\s+/g, " ").trim();
		}
		const textBlocks = content
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join(" ");
		const normalized = textBlocks.replace(/\s+/g, " ").trim();
		return normalized || null;
	}

	private extractPreviewText(
		context: ToolRenderArgs,
		results: BatchResultEntry[],
	): string | null {
		if (context.result?.content) {
			const preview = this.extractContentSummary(context.result.content);
			if (preview) {
				return truncateText(preview, SUMMARY_MAX_WIDTH);
			}
		}
		const firstSummary = results.length
			? results.map((entry) => entry.summary ?? "").join(" ")
			: "";
		if (!firstSummary.trim()) return null;
		const fallback = buildCollapsedSummary(firstSummary);
		return fallback ? truncateText(fallback, SUMMARY_MAX_WIDTH) : null;
	}
}
