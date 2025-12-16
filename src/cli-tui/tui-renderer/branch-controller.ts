/**
 * BranchController - Handles session branching functionality
 *
 * Manages the /branch command which allows users to create a new session
 * starting from a previous user message. This is useful for exploring
 * alternative conversation paths.
 */

import type { AppMessage } from "../../agent/types.js";
import type { CommandExecutionContext } from "../commands/types.js";

export interface BranchControllerCallbacks {
	/** Check if agent is currently running */
	isAgentRunning: () => boolean;
	/** Get current conversation messages */
	getMessages: () => AppMessage[];
	/** Show the interactive user message selector */
	showSelector: () => void;
	/** Create a branched session and return the new session file path */
	createBranchedSession: (messageCount: number) => string;
	/** Set the session file for the new branch */
	setSessionFile: (path: string) => void;
	/** Reset conversation to the given messages with editor seed */
	resetConversation: (
		messages: AppMessage[],
		editorSeed: string,
		notification: string,
	) => void;
	/** Add content to chat container */
	addContent: (text: string) => void;
	/** Request UI render */
	requestRender: () => void;
}

export interface BranchControllerOptions {
	callbacks: BranchControllerCallbacks;
}

export class BranchController {
	private readonly callbacks: BranchControllerCallbacks;

	constructor(options: BranchControllerOptions) {
		this.callbacks = options.callbacks;
	}

	handleBranchCommand(context: CommandExecutionContext): void {
		if (this.callbacks.isAgentRunning()) {
			context.showError(
				"Wait for the current run to finish before branching the session.",
			);
			return;
		}

		const messages = this.callbacks.getMessages();
		const userMessages = messages
			.map((msg, index) => ({ msg, index }))
			.filter(({ msg }) => "role" in msg && msg.role === "user");

		if (userMessages.length === 0) {
			context.showInfo("No user messages available to branch from yet.");
			return;
		}

		const arg = context.argumentText.trim();
		if (!arg) {
			// No argument - show interactive selector
			this.callbacks.showSelector();
			return;
		}

		if (arg === "list") {
			this.renderBranchList(userMessages);
			return;
		}

		const targetIndex = Number.parseInt(arg, 10);
		if (!Number.isFinite(targetIndex) || targetIndex < 1) {
			context.showError("Provide a valid user message number to branch from.");
			return;
		}

		if (targetIndex > userMessages.length) {
			context.showError(
				`Only ${userMessages.length} user message${userMessages.length === 1 ? "" : "s"} available.`,
			);
			return;
		}

		const selection = userMessages[targetIndex - 1];
		const slice = messages.slice(0, selection.index);
		const editorSeed = extractUserText(selection.msg);
		const newSessionFile = this.callbacks.createBranchedSession(slice.length);
		this.callbacks.setSessionFile(newSessionFile);
		this.callbacks.resetConversation(
			slice,
			editorSeed,
			`Branched to new session before user message #${targetIndex}.`,
		);
	}

	private renderBranchList(
		userMessages: Array<{ msg: AppMessage; index: number }>,
	): void {
		const lines: string[] = ["User messages (use /branch <number>):"];
		userMessages.forEach(({ msg }, idx) => {
			const created = getMessageTimestamp(msg);
			const preview = extractUserTextPreview(msg);
			const meta = created ? ` • ${created}` : "";
			lines.push(`${idx + 1}. ${preview}${meta}`);
		});
		this.callbacks.addContent(lines.join("\n"));
		this.callbacks.requestRender();
	}
}

// ─── Utility Functions ───────────────────────────────────────────────────────

export function getMessageTimestamp(message: AppMessage): string | null {
	const ts = "timestamp" in message ? message.timestamp : undefined;
	if (!ts || typeof ts !== "number") return null;
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return null;
	}
}

export function extractUserText(message: AppMessage): string {
	const content = "content" in message ? message.content : undefined;
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		const textBlock = content.find(
			(block): block is { type: "text"; text: string } =>
				block != null &&
				typeof block === "object" &&
				"type" in block &&
				block.type === "text",
		);
		return textBlock?.text ?? "";
	}
	return "";
}

export function extractUserTextPreview(message: AppMessage): string {
	const text = extractUserText(message).replace(/\s+/g, " ").trim();
	if (!text) return "(empty)";
	return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

export function createBranchController(
	options: BranchControllerOptions,
): BranchController {
	return new BranchController(options);
}
