import chalk from "chalk";
import type { ToolRenderArgs, ToolRenderer } from "./types.js";
import { buildCollapsedSummary } from "../tool-text-utils.js";

export class GenericRenderer implements ToolRenderer {
	render(context: ToolRenderArgs): string {
		const label = context.toolName
			? `${context.toolName}`
			: context.args?.name ?? "tool";
		let text = chalk.bold(`${chalk.hex("#d4d8ff")("✷")} ${label}`);
		if (context.collapsed) {
			const combined = [
				JSON.stringify(context.args, null, 2),
				this.getTextOutput(context),
			]
				.filter(Boolean)
				.join("\n");
			text += `\n${chalk.dim(buildCollapsedSummary(combined))}`;
			return text;
		}

		const content = JSON.stringify(context.args, null, 2);
		text += `\n\n${content}`;
		const output = this.getTextOutput(context);
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}

	private getTextOutput(context: ToolRenderArgs): string {
		if (!context.result) return "";
		const textBlocks =
			context.result.content?.filter((c: any) => c.type === "text") || [];
		return textBlocks.map((c: any) => c.text).join("\n");
	}
}
