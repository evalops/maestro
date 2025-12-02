import { theme } from "../../theme/theme.js";
import {
	buildCollapsedSummary,
	clampAnsiLines,
	formatDetailSections,
	formatSection,
	replaceTabs,
	shortenPath,
	summarizeLines,
} from "../utils/tool-text-utils.js";
import type { ToolRenderArgs, ToolRenderer } from "./types.js";

export class ReadRenderer implements ToolRenderer {
	render(context: ToolRenderArgs): string {
		const args = context.result
			? context.args
			: (context.partialArgs ?? context.args);
		const pathValue =
			typeof args?.file_path === "string"
				? args.file_path
				: typeof args?.path === "string"
					? args.path
					: "";
		const path = shortenPath(pathValue);

		// Build path line with optional range
		let pathLine = path ? theme.fg("muted", path) : theme.fg("dim", "...");
		const rangeLabel = this.formatRangeLabel(args, context.result?.details);
		if (rangeLabel) {
			pathLine += theme.fg("dim", `:${rangeLabel}`);
		}

		if (context.collapsed) {
			const summary = context.result
				? buildCollapsedSummary(this.getTextOutput(context))
				: "output hidden: awaiting result";
			return `${pathLine}\n${theme.fg("dim", summary)}`;
		}

		const sections: string[] = [pathLine];

		if (context.result) {
			const output = this.getTextOutput(context);
			const { lines, remaining } = summarizeLines(output, 10);
			const terminalWidth = process.stdout.columns ?? 80;
			const maxWidth = Math.max(48, Math.min(120, terminalWidth - 8));
			const displayLines = clampAnsiLines(
				lines.map((line: string) => theme.fg("dim", replaceTabs(line))),
				maxWidth,
			);
			if (displayLines.length) {
				sections.push(displayLines.join("\n"));
			}
			if (remaining > 0) {
				sections.push(theme.fg("dim", `... (${remaining} more lines)`));
			}

			const detailSections = formatDetailSections(context.result.details, {
				excludeKeys: ["content"],
			});
			if (detailSections.length) {
				sections.push(...detailSections);
			}
		}

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

	private formatRangeLabel(
		args: Record<string, unknown>,
		details?: unknown,
	): string | null {
		const detailRange = this.extractRangeFromDetails(details);
		if (detailRange) {
			return detailRange;
		}
		const offset = this.toNumber(args.offset);
		const limit = this.toNumber(args.limit);
		if (!offset && !limit) {
			return null;
		}
		const start = offset ?? 1;
		const end = limit ? start + limit - 1 : undefined;
		return end ? `${start}-${end}` : `${start}+`;
	}

	private extractRangeFromDetails(details: unknown): string | null {
		if (!details || typeof details !== "object") return null;
		const start = this.toNumber((details as Record<string, unknown>).startLine);
		const end = this.toNumber((details as Record<string, unknown>).endLine);
		if (start && end) {
			return `${start}-${end}`;
		}
		if (start) {
			return `${start}+`;
		}
		return null;
	}

	private toNumber(value: unknown): number | undefined {
		return typeof value === "number" && Number.isFinite(value)
			? value
			: undefined;
	}
}
