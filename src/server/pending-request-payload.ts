import type {
	ComposerPendingClientToolRequest,
	ComposerPendingRequest,
	ComposerSession,
} from "@evalops/contracts";
import { isRecord } from "../utils/json.js";
import {
	type PendingServerRequestSnapshot,
	serverRequestManager,
} from "./server-request-manager.js";

/**
 * Strip Unicode characters that could deceive a human approver:
 *  - Bidi-override / embedding controls (U+202A–U+202E, U+2066–U+2069)
 *  - Zero-width / invisible characters (U+200B–U+200F, U+FEFF, U+FFFE)
 * Applied server-side before the approval payload is serialised, so both
 * the TUI Name line and the web approval card are protected.
 */
function sanitizeDisplayString(value: string): string {
	// Remove bidi-override, bidi-embedding, and isolate controls
	// Remove zero-width space/non-joiner/joiner, left-to-right/right-to-left marks, BOM
	return value
		.normalize("NFKC")
		.replace(/[\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff\ufffe]/gu, "");
}

function getToolRetryPayload(args: unknown): Record<string, unknown> {
	return isRecord(args) ? args : {};
}

function pendingRequestArgs(entry: PendingServerRequestSnapshot): unknown {
	if (entry.kind !== "tool_retry") {
		return entry.args;
	}
	const args = getToolRetryPayload(entry.args);
	return Object.prototype.hasOwnProperty.call(args, "args")
		? args.args
		: entry.args;
}

function mapPendingComposerRequests(
	pending: PendingServerRequestSnapshot[],
): ComposerPendingRequest[] {
	return pending.map((entry) => {
		const createdAt = new Date(entry.timestamp).toISOString();
		const expiresAt =
			Number.isFinite(entry.timeoutMs) && entry.timeoutMs > 0
				? new Date(entry.timestamp + entry.timeoutMs).toISOString()
				: undefined;
		return {
			id: entry.id,
			kind: entry.kind,
			status: "pending",
			visibility: "user",
			sessionId: entry.sessionId,
			toolCallId: entry.callId,
			toolName: entry.toolName,
			displayName:
				typeof entry.displayName === "string"
					? sanitizeDisplayString(entry.displayName)
					: entry.displayName,
			summaryLabel:
				typeof entry.summaryLabel === "string"
					? sanitizeDisplayString(entry.summaryLabel)
					: entry.summaryLabel,
			actionDescription:
				typeof entry.actionDescription === "string"
					? sanitizeDisplayString(entry.actionDescription)
					: entry.actionDescription,
			args: pendingRequestArgs(entry),
			reason:
				typeof entry.reason === "string"
					? sanitizeDisplayString(entry.reason)
					: entry.reason,
			createdAt,
			expiresAt,
			source: entry.platform ? "platform" : "local",
			platform: entry.platform,
		};
	});
}

export function getPendingComposerRequests(
	sessionId: string,
): ComposerPendingRequest[] {
	return mapPendingComposerRequests(
		serverRequestManager.listPending({ sessionId }),
	);
}

export function getPendingServerRequestPayload(
	sessionId: string,
): Pick<
	ComposerSession,
	| "pendingApprovalRequests"
	| "pendingClientToolRequests"
	| "pendingRequests"
	| "pendingToolRetryRequests"
> {
	const pending = serverRequestManager.listPending({ sessionId });

	const pendingApprovalRequests = pending
		.filter((entry) => entry.kind === "approval")
		.map((entry) => ({
			id: entry.id,
			toolName: entry.toolName,
			displayName:
				typeof entry.displayName === "string"
					? sanitizeDisplayString(entry.displayName)
					: entry.displayName,
			summaryLabel:
				typeof entry.summaryLabel === "string"
					? sanitizeDisplayString(entry.summaryLabel)
					: entry.summaryLabel,
			actionDescription:
				typeof entry.actionDescription === "string"
					? sanitizeDisplayString(entry.actionDescription)
					: entry.actionDescription,
			args: entry.args,
			reason:
				typeof entry.reason === "string"
					? sanitizeDisplayString(entry.reason)
					: entry.reason,
			platform: entry.platform,
		}));

	const pendingClientToolRequests: ComposerPendingClientToolRequest[] = pending
		.filter(
			(
				entry,
			): entry is typeof entry & {
				kind: "client_tool" | "mcp_elicitation" | "user_input";
			} =>
				entry.kind === "client_tool" ||
				entry.kind === "mcp_elicitation" ||
				entry.kind === "user_input",
		)
		.map((entry) => ({
			toolCallId: entry.callId,
			toolName: entry.toolName,
			args: entry.args,
			kind: entry.kind,
			reason: entry.reason,
		}));

	const pendingToolRetryRequests = pending
		.filter((entry) => entry.kind === "tool_retry")
		.map((entry) => {
			const args = getToolRetryPayload(entry.args);
			return {
				id: entry.id,
				toolCallId:
					typeof args.tool_call_id === "string"
						? args.tool_call_id
						: entry.callId,
				toolName: entry.toolName,
				args: args.args,
				errorMessage:
					typeof args.error_message === "string"
						? args.error_message
						: entry.reason,
				attempt:
					typeof args.attempt === "number" && Number.isFinite(args.attempt)
						? args.attempt
						: 1,
				maxAttempts:
					typeof args.max_attempts === "number" &&
					Number.isFinite(args.max_attempts)
						? args.max_attempts
						: undefined,
				summary: typeof args.summary === "string" ? args.summary : undefined,
			};
		});
	const pendingRequests = mapPendingComposerRequests(pending);

	return {
		...(pendingApprovalRequests.length > 0 ? { pendingApprovalRequests } : {}),
		...(pendingClientToolRequests.length > 0
			? { pendingClientToolRequests }
			: {}),
		...(pendingToolRetryRequests.length > 0
			? { pendingToolRetryRequests }
			: {}),
		...(pendingRequests.length > 0 ? { pendingRequests } : {}),
	};
}
