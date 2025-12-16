/**
 * Safety-related command handlers
 *
 * Handles /approvals and /plan commands for managing safety settings.
 */

import type { ApprovalMode } from "../../agent/action-approval.js";
import type { CommandExecutionContext } from "./types.js";

export interface ApprovalService {
	setMode(mode: ApprovalMode): void;
	getMode(): ApprovalMode;
	getPendingRequests(): Array<{ toolName: string; reason?: string }>;
}

export interface SafetyHandlerContext {
	/** Show success toast notification */
	showToast: (message: string, type: "success" | "info") => void;
	/** Refresh footer hint display */
	refreshFooterHint: () => void;
	/** Add content to chat display */
	addContent: (text: string) => void;
	/** Request UI render */
	requestRender: () => void;
}

/**
 * Handle /approvals command
 * Shows approval status and allows changing approval mode
 */
export function handleApprovalsCommand(
	context: CommandExecutionContext,
	approvalService: ApprovalService,
	handlers: SafetyHandlerContext,
): void {
	const arg = context.argumentText.trim().toLowerCase();

	// Handle mode change
	if (arg) {
		if (!["auto", "prompt", "fail"].includes(arg)) {
			context.showError('Mode must be one of "auto", "prompt", or "fail".');
			context.renderHelp();
			return;
		}
		approvalService.setMode(arg as ApprovalMode);
		handlers.showToast(`Switched approval mode to ${arg}.`, "success");
		handlers.refreshFooterHint();
	}

	// Display current status
	const pending = approvalService.getPendingRequests();
	const pendingSummary = pending.length
		? `Pending approvals (${pending.length}):${pending
				.slice(0, 5)
				.map((req) => `\n• ${req.toolName} – ${req.reason ?? "awaiting"}`)
				.join("")}`
		: "No pending approval requests.";

	const summaryLines = [
		`Approval mode: ${approvalService.getMode()}`,
		pendingSummary,
	];

	if (pending.length > 5) {
		summaryLines.push(
			`Showing first 5 of ${pending.length}. Use the approvals panel to review all.`,
		);
	}

	handlers.addContent(summaryLines.join("\n"));
	handlers.requestRender();
}

/**
 * Handle /plan command
 * Toggles plan mode on/off
 */
export function handlePlanModeCommand(
	context: CommandExecutionContext,
	handlers: SafetyHandlerContext,
): void {
	const arg = context.argumentText.trim().toLowerCase();

	// Handle mode change
	if (arg) {
		if (!["on", "off"].includes(arg)) {
			context.showError('Plan mode must be "on" or "off".');
			return;
		}
		process.env.COMPOSER_PLAN_MODE = arg === "on" ? "1" : "0";
		handlers.showToast(
			`Plan mode ${arg === "on" ? "enabled" : "disabled"}.`,
			"success",
		);
		handlers.refreshFooterHint();
	}

	// Display current status
	const status =
		process.env.COMPOSER_PLAN_MODE === "1" ? "enabled" : "disabled";
	handlers.addContent(`Plan mode is ${status}.`);
	handlers.requestRender();
}
