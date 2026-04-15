/**
 * Action Approval System
 *
 * This module implements the approval workflow for risky tool executions.
 * When tools are flagged as requiring approval (by the action firewall or
 * tool configuration), this system manages the approval lifecycle.
 *
 * Three approval modes are supported:
 * - auto: Automatically approve all requests (for trusted/automated workflows)
 * - prompt: Queue requests and wait for user decision (default for interactive)
 * - fail: Automatically reject all requests (for strict security contexts)
 *
 * The approval flow:
 * 1. Agent prepares a tool call
 * 2. Action firewall evaluates and may require approval
 * 3. ActionApprovalService.requestApproval() is called
 * 4. In "prompt" mode, request is queued and awaits user decision
 * 5. User approves/denies via the UI or API
 * 6. Decision is returned to the agent to proceed or abort
 */

/** Determines how approval requests are handled */
export type ApprovalMode = "auto" | "prompt" | "fail";

/**
 * Represents a pending approval request for a tool execution.
 */
export interface ActionApprovalRequest {
	/** Unique identifier for this request */
	id: string;
	/** Name of the tool requesting approval */
	toolName: string;
	/** Optional human-facing label for the tool */
	displayName?: string;
	/** Optional compact summary of the requested action */
	summaryLabel?: string;
	/** Optional present-tense action description for approval UI */
	actionDescription?: string;
	/** Arguments the tool will be called with */
	args: unknown;
	/** Human-readable reason why approval is required */
	reason: string;
}

/**
 * The decision made for an approval request.
 */
export interface ActionApprovalDecision {
	/** Whether the action was approved */
	approved: boolean;
	/** Optional explanation for the decision */
	reason?: string;
	/** Who made the decision: automated policy or human user */
	resolvedBy: "policy" | "user";
}

/**
 * Serializable snapshot of PII tracking state.
 * Used to persist and restore workflow state across sessions.
 */
export interface WorkflowStateSnapshot {
	/** List of PII artifacts that are pending redaction */
	pendingPii: Array<{
		id: string;
		label: string;
		sourceToolCallId: string;
		redacted: boolean;
		parents?: string[];
	}>;
	/** Artifact IDs that were redacted but never captured (indicates bugs) */
	orphanedRedactions: string[];
}

/**
 * Full context provided to the action firewall for approval decisions.
 * Includes the action itself plus ambient context about the workflow.
 */
export interface ActionApprovalContext {
	/** Name of the tool being executed */
	toolName: string;
	/** Arguments for the tool call */
	args: unknown;
	/** Additional metadata for policy evaluation */
	metadata?: {
		/** Current PII tracking state for data protection policies */
		workflowState?: WorkflowStateSnapshot;
		/** MCP tool annotations that hint at tool behavior */
		annotations?: {
			/** Tool only reads data, doesn't modify state */
			readOnlyHint?: boolean;
			/** Tool may cause irreversible changes */
			destructiveHint?: boolean;
			/** Tool can be safely retried */
			idempotentHint?: boolean;
			/** Tool interacts with external/untrusted systems */
			openWorldHint?: boolean;
		};
	};
	/** User context for permission-based policies */
	user?: {
		id: string;
		orgId: string;
	};
	/** Session context for time/scope-based policies */
	session?: {
		id: string;
		startedAt: Date;
	};
	/** The user's original request (for intent-matching policies) */
	userIntent?: string;
}

/**
 * Verdict from the action firewall after evaluating a tool call.
 *
 * - allow: Tool can proceed without approval
 * - require_approval: Tool needs user approval before execution
 * - block: Tool is denied and cannot be executed
 */
export type ActionFirewallVerdict =
	| { action: "allow" }
	| { action: "require_approval"; ruleId: string; reason: string }
	| {
			action: "block";
			ruleId: string;
			reason: string;
			/** Suggested steps to resolve the block */
			remediation?: string;
	  };

/**
 * Internal entry for a pending approval request.
 * Stores the promise resolver and cleanup callback.
 */
type PendingEntry = {
	/** The approval request details */
	request: ActionApprovalRequest;
	/** Resolver function to complete the approval promise */
	resolve: (decision: ActionApprovalDecision) => void;
	/** Cleanup callback to remove abort listeners */
	cleanup?: () => void;
};

/**
 * Manages the approval workflow for risky tool executions.
 *
 * In "prompt" mode, this service queues approval requests and returns
 * a promise that resolves when the user makes a decision. The UI/API
 * can call approve() or deny() to resolve pending requests.
 *
 * The service also handles abort signals to clean up pending requests
 * when the agent run is cancelled.
 */
export class ActionApprovalService {
	/** Map of request ID -> pending entry awaiting decision */
	private pending = new Map<string, PendingEntry>();

	constructor(private mode: ApprovalMode = "prompt") {}

	/** Update the approval mode at runtime */
	setMode(mode: ApprovalMode): void {
		this.mode = mode;
	}

	/** Get the current approval mode */
	getMode(): ApprovalMode {
		return this.mode;
	}

	/** Check if this mode requires user interaction (UI should show prompts) */
	requiresUserInteraction(): boolean {
		return this.mode === "prompt";
	}

	/**
	 * Request approval for an action.
	 *
	 * Behavior depends on the current mode:
	 * - auto: Immediately returns approved
	 * - fail: Immediately returns denied
	 * - prompt: Queues request and waits for user decision
	 *
	 * @param request - The approval request details
	 * @param signal - Optional abort signal to cancel the request
	 * @returns Promise that resolves with the approval decision
	 */
	async requestApproval(
		request: ActionApprovalRequest,
		signal?: AbortSignal,
	): Promise<ActionApprovalDecision> {
		// Fast path for auto mode - no queuing needed
		if (this.mode === "auto") {
			return {
				approved: true,
				reason: "Auto-approved by policy",
				resolvedBy: "policy",
			};
		}

		// Fast path for fail mode - immediate rejection
		if (this.mode === "fail") {
			return {
				approved: false,
				reason: "Denied by approval policy",
				resolvedBy: "policy",
			};
		}

		// Check if already aborted before queuing
		if (signal?.aborted) {
			return {
				approved: false,
				reason: "Run aborted",
				resolvedBy: "policy",
			};
		}

		// Prompt mode: queue the request and wait for user decision
		return await new Promise<ActionApprovalDecision>((resolve) => {
			const entry: PendingEntry = {
				request,
				resolve: () => {}, // Placeholder, replaced below
			};

			// Wrap resolver to ensure cleanup on resolution
			entry.resolve = (decision) => {
				entry.cleanup?.();
				resolve(decision);
			};

			// Set up abort handling to auto-deny if the run is cancelled
			if (signal) {
				const onAbort = () => {
					if (!this.pending.has(request.id)) return;
					this.pending.delete(request.id);
					entry.cleanup?.();
					resolve({
						approved: false,
						reason: "Run aborted",
						resolvedBy: "policy",
					});
				};
				entry.cleanup = () => signal.removeEventListener("abort", onAbort);
				signal.addEventListener("abort", onAbort, { once: true });
			}

			// Add to pending map - UI can query this to show approval prompts
			this.pending.set(request.id, entry);
		});
	}

	/**
	 * Approve a pending request. Called by UI or API when user approves.
	 * @returns true if request was found and resolved, false if not pending
	 */
	approve(id: string, note?: string): boolean {
		return this.resolve(id, {
			approved: true,
			reason: note ?? "Approved",
			resolvedBy: "user",
		});
	}

	/**
	 * Deny a pending request. Called by UI or API when user denies.
	 * @returns true if request was found and resolved, false if not pending
	 */
	deny(id: string, reason?: string): boolean {
		return this.resolve(id, {
			approved: false,
			reason: reason ?? "Denied",
			resolvedBy: "user",
		});
	}

	/**
	 * Resolve a pending request with an explicit decision.
	 * Used by remote/server adapters that need policy-driven cancellation.
	 */
	resolve(id: string, decision: ActionApprovalDecision): boolean {
		return this.resolveEntry(id, decision);
	}

	/**
	 * Clear all pending requests with a denial.
	 * Called when the session ends or is reset.
	 */
	clearPending(reason = "Approval cancelled"): void {
		for (const id of Array.from(this.pending.keys())) {
			this.resolve(id, {
				approved: false,
				reason: reason,
				resolvedBy: "policy",
			});
		}
	}

	/**
	 * Get all currently pending approval requests.
	 * Used by UI to display approval prompts.
	 */
	getPendingRequests(): ActionApprovalRequest[] {
		return Array.from(this.pending.values()).map((entry) => entry.request);
	}

	/**
	 * Internal helper to resolve a pending entry with a decision.
	 * Handles cleanup and removal from pending map.
	 */
	private resolveEntry(id: string, decision: ActionApprovalDecision): boolean {
		const entry = this.pending.get(id);
		if (!entry) {
			return false;
		}
		this.pending.delete(id);
		entry.resolve(decision);
		return true;
	}
}
