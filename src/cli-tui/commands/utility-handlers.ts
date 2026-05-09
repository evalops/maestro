/**
 * Utility command handlers
 *
 * Handles standalone utility commands that don't fit into other categories:
 * - /copy: Copy last assistant message to clipboard
 * - /init: Scaffold AGENTS.md file
 * - /report: Bug/feedback reporting
 */

import { relative } from "node:path";
import type { AppMessage } from "../../agent/types.js";
import { handleAgentsInit } from "../../cli/commands/agents.js";
import type { CommandExecutionContext } from "./types.js";

export interface CopyHandlerDeps {
	/** Get current conversation messages */
	getMessages: () => AppMessage[];
}

export interface CopyHandlerCallbacks {
	/** Show info message */
	showInfo: (message: string) => void;
	/** Show error message */
	showError: (message: string) => void;
}

/**
 * Handle /copy command - copy last assistant message to clipboard
 */
export function handleCopyCommand(
	_context: CommandExecutionContext,
	deps: CopyHandlerDeps,
	callbacks: CopyHandlerCallbacks,
): void {
	const messages = deps.getMessages();
	let lastAssistant: AppMessage | null = null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg) continue;
		if (msg.role === "assistant") {
			lastAssistant = msg;
			break;
		}
	}

	if (!lastAssistant) {
		callbacks.showError("No assistant message to copy.");
		return;
	}

	// Extract text content from the message
	const {
		renderMessageToPlainText,
		createRenderableMessage,
	} = require("../../conversation/render-model.js");
	const renderable = createRenderableMessage(lastAssistant);
	if (!renderable) {
		callbacks.showError("Could not render message.");
		return;
	}

	const text = renderMessageToPlainText(renderable);
	if (!text) {
		callbacks.showError("No text content to copy.");
		return;
	}

	// Copy to clipboard
	try {
		const clipboard = require("clipboardy");
		clipboard.writeSync(text);
		callbacks.showInfo("Copied last assistant message to clipboard.");
	} catch (error) {
		callbacks.showError(
			`Failed to copy to clipboard: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export interface InitHandlerCallbacks {
	/** Show success toast */
	showSuccess: (message: string) => void;
	/** Show error message */
	showError: (message: string) => void;
	/** Add content to chat container */
	addContent: (text: string) => void;
	/** Request UI render */
	requestRender: () => void;
}

function buildInitRerunCommand(targetArg: string | undefined): string {
	return targetArg ? `/init ${targetArg} --force` : "/init --force";
}

function parseInitArgs(argumentText: string): {
	targetArg: string | undefined;
	force: boolean;
} {
	const trimmed = argumentText.trim();
	if (!trimmed) {
		return { targetArg: undefined, force: false };
	}
	const forceMatch = trimmed.match(/(?:^|\s)(--force|-f)$/);
	if (!forceMatch) {
		return { targetArg: trimmed, force: false };
	}
	const targetArg = trimmed.slice(0, forceMatch.index).trim() || undefined;
	return { targetArg, force: true };
}

/**
 * Handle /init command - scaffold AGENTS.md file
 */
export function handleInitCommand(
	context: CommandExecutionContext,
	callbacks: InitHandlerCallbacks,
): void {
	try {
		const { targetArg, force } = parseInitArgs(context.argumentText);
		const result = handleAgentsInit(targetArg, { force });
		const rerunCommand = buildInitRerunCommand(targetArg);
		const relativePath = relative(process.cwd(), result.path);
		const displayPath =
			relativePath && !relativePath.startsWith("..") && relativePath !== ""
				? `./${relativePath}`
				: result.path;
		if (result.action === "preview") {
			callbacks.showSuccess(
				`Previewed AGENTS update for ${displayPath}. Re-run with ${rerunCommand} to apply it.`,
			);
			callbacks.addContent(
				[
					`AGENTS instructions already exist at ${displayPath}. Preview the proposed update below, then re-run with ${rerunCommand} to apply it.`,
					"",
					"```diff",
					result.diff ?? "",
					"```",
				].join("\n"),
			);
			callbacks.requestRender();
			return;
		}
		if (result.action === "updated") {
			callbacks.showSuccess(`Updated AGENTS instructions at ${displayPath}.`);
			callbacks.addContent(
				`Updated AGENTS instructions at ${displayPath} after preview/force confirmation.`,
			);
			callbacks.requestRender();
			return;
		}
		callbacks.showSuccess(`Scaffolded ${displayPath}.`);
		callbacks.addContent(`Created AGENTS instructions at ${displayPath}.`);
		callbacks.requestRender();
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to scaffold AGENTS file.";
		callbacks.showError(message);
	}
}

export interface ReportHandlerDeps {
	/** Show bug report modal */
	showBugReport: () => void;
	/** Show feedback modal */
	showFeedback: () => void;
	/** Show report type selector */
	showReportSelector: () => void;
}

/**
 * Handle /report command - show bug/feedback reporting
 */
export function handleReportCommand(
	context: CommandExecutionContext,
	deps: ReportHandlerDeps,
): void {
	const parsedType = context.parsedArgs?.type;
	const inlineArg = context.argumentText.trim().split(/\s+/)[0] ?? "";
	const candidate =
		typeof parsedType === "string" && parsedType.length > 0
			? parsedType.toLowerCase()
			: inlineArg.toLowerCase();

	if (candidate === "bug") {
		deps.showBugReport();
		return;
	}
	if (candidate === "feedback") {
		deps.showFeedback();
		return;
	}
	if (candidate.length > 0) {
		context.showError('Report type must be "bug" or "feedback".');
		context.renderHelp();
		return;
	}
	deps.showReportSelector();
}
