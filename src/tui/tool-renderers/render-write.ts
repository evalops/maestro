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

export class WriteRenderer implements ToolRenderer {
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
		const fileContent =
			typeof args?.content === "string"
				? args.content
				: String(args?.content ?? "");
		const contentLines = fileContent ? fileContent.split("\n") : [];
		const totalLines = contentLines.length;

		// Build path line with optional line count
		let pathLine = path ? theme.fg("muted", path) : theme.fg("dim", "...");
		if (totalLines > 10) {
			pathLine += theme.fg("dim", ` (${totalLines} lines)`);
		}

		if (context.collapsed) {
			return `${pathLine}\n${theme.fg("dim", buildCollapsedSummary(fileContent))}`;
		}

		const sections: string[] = [pathLine];

		if (fileContent) {
			const { lines: preview, remaining } = summarizeLines(fileContent, 10);
			const terminalWidth = process.stdout.columns ?? 80;
			const maxWidth = Math.max(48, Math.min(120, terminalWidth - 8));
			const formatted = clampAnsiLines(
				preview.map((line: string) => theme.fg("dim", replaceTabs(line))),
				maxWidth,
			);
			if (formatted.length) {
				sections.push(formatted.join("\n"));
			}
			if (remaining > 0) {
				sections.push(theme.fg("dim", `... (${remaining} more lines)`));
			}
		}

		if (context.result?.details) {
			const detailSections = formatDetailSections(context.result.details, {
				excludeKeys: ["content"],
			});
			if (detailSections.length) {
				sections.push(...detailSections);
			}
		}

		return sections.filter(Boolean).join("\n\n");
	}
}
