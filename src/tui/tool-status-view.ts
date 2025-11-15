import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentState } from "../agent/types.js";
import {
	badge,
	heading,
	labeledValue,
	muted,
	separator as themedSeparator,
} from "../style/theme.js";
import { type Container, Spacer, type TUI, Text } from "../tui-lib/index.js";

export const TOOL_FAILURE_LOG_PATH = join(
	homedir(),
	".composer",
	"tool-failures.log",
);

interface ToolStatusViewOptions {
	chatContainer: Container;
	ui: TUI;
	getTools: () => AgentState["tools"] | undefined;
	showInfoMessage: (message: string) => void;
}

export class ToolStatusView {
	constructor(private readonly options: ToolStatusViewOptions) {}

	handleToolsCommand(commandText = "/tools"): void {
		const parts = commandText.trim().split(/\s+/);
		if (parts.length > 1 && parts[1] === "clear") {
			if (!existsSync(TOOL_FAILURE_LOG_PATH)) {
				this.options.showInfoMessage("No tool failure log found to clear.");
				return;
			}
			try {
				writeFileSync(TOOL_FAILURE_LOG_PATH, "");
				this.options.showInfoMessage("Cleared tool failure log.");
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error ?? "unknown");
				this.options.showInfoMessage(`Failed to clear log: ${message}`);
			}
			return;
		}

		const tools = this.options.getTools() ?? [];
		const { recent, counts } = this.getToolFailureData();
		const toolLines = tools.length
			? tools.map((tool) => {
					const label = badge(tool.label ?? tool.name, undefined, "info");
					const description = tool.description || "No description provided";
					const failureCount = counts.get(tool.name) ?? 0;
					const failureBadge =
						failureCount > 0
							? ` ${badge("failures", failureCount.toString(), "danger")}`
							: "";
					return `${label} ${muted(`(${tool.name})`)}${failureBadge}\n  ${muted(description)}`;
				})
			: [muted("No tools are currently registered.")];

		const failureSection = recent.length
			? `${heading("Recent tool failures")}\n${recent
					.map(
						(entry) =>
							`${muted(entry.timestamp)} ${themedSeparator()} ${badge("tool", entry.tool, "warn")} ${entry.error}`,
					)
					.join("\n")}`
			: muted("No recent tool failures logged.");

		const text = `${heading("Available tools")}
${toolLines.join("\n\n")}\n\n${failureSection}\n\n${muted("Use /tools clear to reset the failure log.")}`;

		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(text, 1, 0));
		this.options.ui.requestRender();
	}

	getToolFailureData(limit = 5): {
		recent: Array<{ tool: string; error: string; timestamp: string }>;
		counts: Map<string, number>;
	} {
		const result = {
			recent: [] as Array<{ tool: string; error: string; timestamp: string }>,
			counts: new Map<string, number>(),
		};
		try {
			if (!existsSync(TOOL_FAILURE_LOG_PATH)) {
				return result;
			}
			const raw = readFileSync(TOOL_FAILURE_LOG_PATH, "utf-8");
			const lines = raw.split("\n").filter(Boolean).reverse();
			for (const line of lines.slice(0, limit)) {
				const parsed = JSON.parse(line) as {
					tool?: string;
					error?: string;
					timestamp?: number;
				};
				if (parsed.tool) {
					result.counts.set(
						parsed.tool,
						(result.counts.get(parsed.tool) ?? 0) + 1,
					);
				}
				result.recent.push({
					tool: parsed.tool ?? "unknown",
					error: parsed.error ?? "unknown error",
					timestamp: parsed.timestamp
						? new Date(parsed.timestamp).toLocaleString()
						: "unknown time",
				});
			}
		} catch {
			// ignore log parse issues
		}
		return result;
	}
}
