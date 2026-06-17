/**
 * Permission request handler
 *
 * `src/agent/action-approval.ts` currently mixes three concerns:
 * (1) approval policy modes (auto/prompt/fail), (2) PII tracking +
 * workflow state, (3) per-mode UX wiring (TUI prompts, JSON-RPC
 * frames, ACP messages). This module owns concern (3) only: a thin
 * handler that takes a mode-specific `PermissionRequestFn` in its
 * constructor and routes incoming `PermissionRequest`s through it.
 * The policy module (action-approval) becomes a consumer of this
 * handler in a follow-up PR.
 *
 * Design notes:
 *   - The handler is intentionally tiny (one method + one validator).
 *     Mode-specific code lives only in the injected function.
 *   - `processConfirmationOutcome` validates the decision the
 *     injected function produced — defending against transports that
 *     return malformed payloads (extra tool ids, ids not in the
 *     request, missing comments on deny).
 *   - No async dependencies, no I/O, no global state. Callers feed
 *     in the request and receive a typed decision back.
 *
 * What's NOT here: action-approval migration, PII tracking, mode
 * conditionals, TUI/JSON-RPC/ACP transport implementations. Those
 * arrive in follow-up PRs once this shape is stable.
 */

/** What action approval is being requested for. */
export interface PermissionRequest {
	/** Stable batch id (correlates with audit logs). */
	batchId: string;
	/** Tool calls awaiting approval, in stable order. */
	tools: PermissionToolItem[];
	/** Caller context shown to the user (CWD, branch, model id, etc). */
	caller: PermissionCaller;
}

/** One tool call inside a permission batch. */
export interface PermissionToolItem {
	/** Stable id within the batch. */
	id: string;
	/** Short human-readable label, e.g. `"write file src/x.ts"`. */
	label: string;
	/** Tool name, e.g. `"bash"`, `"write"`. */
	toolName: string;
	/** Optional structured args (echoed back in the decision audit). */
	args?: unknown;
}

/** What the agent knows about the caller making the request. */
export interface PermissionCaller {
	cwd: string;
	branch?: string;
	commitSha?: string;
	modelId?: string;
	sessionId?: string;
}

/** Outcome the user picked. */
export type PermissionOutcome =
	| "approved"
	| "denied"
	| "skipped"
	| "approved-with-comment";

/** Decision returned by the injected request function. */
export interface PermissionDecision {
	/** What the user picked. */
	outcome: PermissionOutcome;
	/** Subset of request tool ids the user approved. May be empty. */
	approvedToolIds: string[];
	/** Optional comment the user attached (required when denying). */
	comment?: string;
}

/**
 * Mode-specific permission request function. The TUI implementation
 * shows a prompt; the JSON-RPC implementation forwards the batch to a
 * client; the ACP implementation frames it as an agent message. Each
 * returns the same typed decision shape.
 */
export type PermissionRequestFn = (
	request: PermissionRequest,
) => Promise<PermissionDecision>;

/**
 * Thin handler that wraps a `PermissionRequestFn` with validation.
 * Callers (action-approval, future MCP bridges, etc) construct one
 * per mode and call `requestPermission` for every approval batch.
 */
export class PermissionRequestHandler {
	constructor(private readonly fn: PermissionRequestFn) {}

	async requestPermission(
		request: PermissionRequest,
	): Promise<PermissionDecision> {
		assertRequestValid(request);
		const raw = await this.fn(request);
		return processConfirmationOutcome(request, raw);
	}
}

/**
 * Validate a raw decision against the request that produced it.
 *
 * Rejects malformed transport payloads: tool ids that aren't in the
 * request, approving while outcome is `"denied"`, denying without a
 * comment, missing `approvedToolIds`, etc. Returns a normalized
 * decision (approvedToolIds deduped + in request order).
 */
export function processConfirmationOutcome(
	request: PermissionRequest,
	raw: PermissionDecision,
): PermissionDecision {
	if (!raw || typeof raw !== "object") {
		throw new Error("PermissionRequestHandler: decision must be an object");
	}
	if (
		raw.outcome !== "approved" &&
		raw.outcome !== "denied" &&
		raw.outcome !== "skipped" &&
		raw.outcome !== "approved-with-comment"
	) {
		throw new Error(
			`PermissionRequestHandler: unknown outcome "${raw.outcome}"`,
		);
	}
	if (!Array.isArray(raw.approvedToolIds)) {
		throw new Error(
			"PermissionRequestHandler: decision.approvedToolIds must be an array",
		);
	}
	const requestIds = new Set(request.tools.map((t) => t.id));
	const seen = new Set<string>();
	const approvedToolIds: string[] = [];
	for (const id of raw.approvedToolIds) {
		if (typeof id !== "string") {
			throw new Error(
				"PermissionRequestHandler: approvedToolIds must be strings",
			);
		}
		if (!requestIds.has(id)) {
			throw new Error(
				`PermissionRequestHandler: approved id "${id}" is not in the request`,
			);
		}
		if (seen.has(id)) continue;
		seen.add(id);
		approvedToolIds.push(id);
	}
	// Sort approved ids back into request order so audit logs are
	// stable regardless of which order the transport handed them back.
	approvedToolIds.sort(
		(a, b) =>
			request.tools.findIndex((t) => t.id === a) -
			request.tools.findIndex((t) => t.id === b),
	);
	const comment = normalizeComment(raw.comment);
	if (
		(raw.outcome === "denied" || raw.outcome === "skipped") &&
		approvedToolIds.length > 0
	) {
		throw new Error(
			`PermissionRequestHandler: outcome is ${raw.outcome} but approvedToolIds is non-empty`,
		);
	}
	if (raw.outcome === "denied" && (!comment || !comment.trim())) {
		throw new Error(
			"PermissionRequestHandler: denied decisions require a non-empty comment",
		);
	}
	if (raw.outcome === "approved-with-comment" && !comment?.trim()) {
		throw new Error(
			"PermissionRequestHandler: approved-with-comment decisions require a non-empty comment",
		);
	}
	if (
		raw.outcome === "approved" &&
		approvedToolIds.length !== request.tools.length
	) {
		throw new Error(
			"PermissionRequestHandler: outcome is approved but approvedToolIds does not cover every request tool",
		);
	}
	const decision: PermissionDecision = {
		outcome: raw.outcome,
		approvedToolIds,
	};
	if (comment !== undefined) {
		decision.comment = comment;
	}
	return decision;
}

function normalizeComment(comment: string | undefined): string | undefined {
	if (comment === undefined) {
		return undefined;
	}
	if (typeof comment !== "string") {
		throw new Error(
			"PermissionRequestHandler: decision.comment must be a string",
		);
	}
	return comment;
}

function assertRequestValid(request: PermissionRequest): void {
	if (!request.batchId.trim()) {
		throw new Error("PermissionRequest: batchId is required");
	}
	if (!Array.isArray(request.tools) || request.tools.length === 0) {
		throw new Error("PermissionRequest: tools is required and non-empty");
	}
	const seen = new Set<string>();
	for (const t of request.tools) {
		if (!t.id.trim()) {
			throw new Error("PermissionRequest: tool.id is required");
		}
		if (seen.has(t.id)) {
			throw new Error(
				`PermissionRequest: duplicate tool id "${t.id}" in batch`,
			);
		}
		seen.add(t.id);
		if (!t.toolName.trim()) {
			throw new Error(`PermissionRequest: tool "${t.id}" missing toolName`);
		}
		if (!t.label.trim()) {
			throw new Error(`PermissionRequest: tool "${t.id}" missing label`);
		}
	}
}

/**
 * Convenience factory for the most common shape — "approve every tool
 * in the batch." Useful for mode-specific functions that default to
 * approving when no UI is wired yet.
 */
export function approveAll(request: PermissionRequest): PermissionDecision {
	return {
		outcome: "approved",
		approvedToolIds: request.tools.map((t) => t.id),
	};
}

/**
 * Convenience factory: deny everything with a fixed comment. Useful
 * for fail-closed modes and for tests that want to assert the
 * "policy refused" path.
 */
export function denyAll(
	request: PermissionRequest,
	comment: string,
): PermissionDecision {
	if (!comment.trim()) {
		throw new Error("denyAll: comment must be non-empty");
	}
	return {
		outcome: "denied",
		approvedToolIds: [],
		comment,
	};
}
