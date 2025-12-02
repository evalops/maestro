import { theme } from "../../theme/theme.js";
import {
	buildCollapsedSummary,
	clampAnsiLines,
	formatDetailSections,
	formatSection,
	formatShellSnippet,
	summarizeLines,
} from "../utils/tool-text-utils.js";
import type { ToolRenderArgs, ToolRenderer } from "./types.js";

export class BashRenderer implements ToolRenderer {
	render(context: ToolRenderArgs): string {
		const args = context.result
			? context.args
			: (context.partialArgs ?? context.args);
		const command =
			typeof args?.command === "string"
				? args.command
				: String(args?.command ?? "");
		const commandLines = formatShellSnippet(command ? `$ ${command}` : "$ ...");
		const sections: string[] = [];

		// Command section (always show)
		if (commandLines.length) {
			sections.push(commandLines.join("\n"));
		}

		if (context.collapsed) {
			const summarySource = context.result
				? this.getTextOutput(context)
				: command;
			const summary = buildCollapsedSummary(summarySource);
			return sections.length
				? `${sections[0]}\n${theme.fg("dim", summary)}`
				: theme.fg("dim", summary);
		}

		if (context.result) {
			const output = this.getTextOutput(context).trim();
			if (output) {
				const { lines, remaining } = summarizeLines(output, 5);
				const terminalWidth = process.stdout.columns ?? 80;
				const maxWidth = Math.max(48, Math.min(120, terminalWidth - 8));
				const dimmed = clampAnsiLines(
					lines.map((line) => theme.fg("dim", line)),
					maxWidth,
				);
				sections.push(dimmed.join("\n"));
				if (remaining > 0) {
					sections.push(theme.fg("dim", `... (${remaining} more lines)`));
				}
			}
		}

		if (!context.collapsed) {
			const detailSections = formatDetailSections(context.result?.details, {
				excludeKeys: ["command", "output"],
			});
			sections.push(...detailSections);
		}

		if (sections.length === 0) {
			return theme.fg("dim", "waiting for output...");
		}

		return sections.filter(Boolean).join("\n\n");
	}

	private getTextOutput(context: ToolRenderArgs): string {
		if (!context.result) return "";
		const textBlocks =
			context.result.content?.filter(
				(c): c is { type: "text"; text: string } => c.type === "text",
			) || [];
		const imageBlocks =
			context.result.content?.filter(
				(c): c is { type: "image"; mimeType: string; data: string } =>
					c.type === "image",
			) || [];

		let output = textBlocks.map((c) => c.text).join("\n");
		if (imageBlocks.length > 0) {
			const imageIndicators = imageBlocks
				.map((img) => `[Image: ${img.mimeType}]`)
				.join("\n");
			output = output ? `${output}\n${imageIndicators}` : imageIndicators;
		}
		return output;
	}
}
