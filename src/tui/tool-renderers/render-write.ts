import chalk from "chalk";
import { theme } from "../../theme/theme.js";
import {
	buildCollapsedSummary,
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
		const lines = fileContent ? fileContent.split("\n") : [];
		const totalLines = lines.length;

		let text = `${theme.fg("accent", "[write]")} ${
			path ? theme.fg("dim", path) : theme.fg("dim", "...")
		}`;
		if (totalLines > 10) {
			text += ` (${totalLines} lines)`;
		}

		if (context.collapsed) {
			return `${text}\n${theme.fg("dim", buildCollapsedSummary(fileContent))}`;
		}

		if (fileContent) {
			const { lines: preview, remaining } = summarizeLines(fileContent, 10);
			const formatted = preview.map((line: string) =>
				theme.fg("dim", replaceTabs(line)),
			);
			if (formatted.length) {
				text += `\n\n${formatSection("content", formatted)}`;
			}
			if (remaining > 0) {
				text += theme.fg("dim", `\n... (${remaining} more lines)`);
			}
		}

		if (context.result?.details) {
			const detailSections = formatDetailSections(context.result.details, {
				excludeKeys: ["content"],
			});
			if (detailSections.length) {
				text += `\n\n${detailSections.join("\n\n")}`;
			}
		}

		return text;
	}
}
