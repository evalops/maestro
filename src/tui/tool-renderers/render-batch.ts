import { theme } from "../../theme/theme.js";
import { buildCollapsedSummary } from "../utils/tool-text-utils.js";
import { formatHeadline, renderCard, statusGlyph } from "./render-style.js";
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
	details?: unknown;
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
		const bar = this.buildBar(total, successes);
		const summaryMeta =
			total === 0
				? "no tool calls"
				: `${total} tool${total === 1 ? "" : "s"} · ${successes} ok${
						failures ? ` · ${failures} err` : ""
					}${bar ? ` · ${bar}` : ""}`;
		const preview = this.getPreviewText(context);
		const errorSnippet = failures ? this.findFirstErrorSnippet(results) : null;

		if (context.collapsed) {
			const headline = `${statusGlyph(status)} ${formatHeadline("batch", summaryMeta)}`;
			return preview
				? `${headline} ${theme.fg("dim", `— ${preview}`)}${errorSnippet ? ` ${theme.fg("error", errorSnippet)}` : ""}`
				: errorSnippet
					? `${headline} ${theme.fg("error", errorSnippet)}`
					: headline;
		}

		const lines: string[] = [];
		lines.push(
			`${statusGlyph(status)} ${formatHeadline("batch", summaryMeta)}`,
		);
		if (preview) {
			lines.push(theme.fg("dim", preview));
		}
		if (errorSnippet) {
			lines.push(theme.fg("error", errorSnippet));
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
			const duration = this.formatDuration(entry);
			rowLines.push(
				`${statusGlyph(rowStatus)} ${theme.bold(label)} ${theme.fg("dim", "—")} ${theme.fg("muted", summary)}${duration ? theme.fg("dim", ` (${duration})`) : ""}`,
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

	private buildBar(total: number, successes: number): string {
		if (total <= 0) return "";
		const slots = Math.min(10, total);
		const successSlots = Math.max(
			0,
			Math.min(slots, Math.round((successes / total) * slots)),
		);
		const failSlots = Math.max(0, slots - successSlots);
		return `${"■".repeat(successSlots)}${"□".repeat(failSlots)}`;
	}

	private findFirstErrorSnippet(results: BatchResultEntry[]): string | null {
		const firstErr =
			results.find((r) => r.success === false || r.result?.isError) ?? null;
		if (!firstErr) return null;
		return (
			this.cleanSummary(firstErr.summary) ||
			this.extractTextSnippet(firstErr.result) ||
			"error"
		);
	}

	private formatDuration(entry: BatchResultEntry): string | null {
		const details =
			entry.details && typeof entry.details === "object"
				? (entry.details as Record<string, unknown>)
				: entry.result?.details && typeof entry.result.details === "object"
					? (entry.result.details as Record<string, unknown>)
					: null;
		if (!details) return null;
		const duration =
			this.toNumber(details.durationMs) ??
			this.toNumber(details.duration_ms) ??
			this.toNumber(details.duration);
		if (!duration || duration < 1) return null;
		if (duration < 1000) return `${duration}ms`;
		return `${(duration / 1000).toFixed(1)}s`;
	}

	private toNumber(value: unknown): number | null {
		return typeof value === "number" && Number.isFinite(value) ? value : null;
	}
}
