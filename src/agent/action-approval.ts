export type ApprovalMode = "auto" | "prompt" | "fail";

export interface ActionApprovalRequest {
	id: string;
	toolName: string;
	args: unknown;
	reason: string;
}

export interface ActionApprovalDecision {
	approved: boolean;
	reason?: string;
	resolvedBy: "policy" | "user";
}

export interface WorkflowStateSnapshot {
	pendingPii: Array<{
		id: string;
		label: string;
		sourceToolCallId: string;
		redacted: boolean;
		parents?: string[];
	}>;
	orphanedRedactions: string[];
}

export interface ActionApprovalContext {
	toolName: string;
	args: unknown;
	metadata?: {
		/** Snapshot of per-run workflow state used by safety policies. */
		workflowState?: WorkflowStateSnapshot;
		/** Tool annotations from MCP for approval decisions */
		annotations?: {
			readOnlyHint?: boolean;
			destructiveHint?: boolean;
			idempotentHint?: boolean;
			openWorldHint?: boolean;
		};
	};
}

export type ActionFirewallVerdict =
	| { action: "allow" }
	| { action: "require_approval"; ruleId: string; reason: string };

type PendingEntry = {
	request: ActionApprovalRequest;
	resolve: (decision: ActionApprovalDecision) => void;
	cleanup?: () => void;
};

export class ActionApprovalService {
	private pending = new Map<string, PendingEntry>();

	constructor(private mode: ApprovalMode = "prompt") {}

	setMode(mode: ApprovalMode): void {
		this.mode = mode;
	}

	getMode(): ApprovalMode {
		return this.mode;
	}

	requiresUserInteraction(): boolean {
		return this.mode === "prompt";
	}

	async requestApproval(
		request: ActionApprovalRequest,
		signal?: AbortSignal,
	): Promise<ActionApprovalDecision> {
		if (this.mode === "auto") {
			return {
				approved: true,
				reason: "Auto-approved by policy",
				resolvedBy: "policy",
			};
		}
		if (this.mode === "fail") {
			return {
				approved: false,
				reason: "Denied by approval policy",
				resolvedBy: "policy",
			};
		}
		if (signal?.aborted) {
			return {
				approved: false,
				reason: "Run aborted",
				resolvedBy: "policy",
			};
		}
		return await new Promise<ActionApprovalDecision>((resolve) => {
			const entry: PendingEntry = {
				request,
				resolve: () => {},
			};
			entry.resolve = (decision) => {
				entry.cleanup?.();
				resolve(decision);
			};
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
			this.pending.set(request.id, entry);
		});
	}

	approve(id: string, note?: string): boolean {
		return this.resolveEntry(id, {
			approved: true,
			reason: note ?? "Approved",
			resolvedBy: "user",
		});
	}

	deny(id: string, reason?: string): boolean {
		return this.resolveEntry(id, {
			approved: false,
			reason: reason ?? "Denied",
			resolvedBy: "user",
		});
	}

	clearPending(reason = "Approval cancelled"): void {
		for (const id of Array.from(this.pending.keys())) {
			this.resolveEntry(id, {
				approved: false,
				reason: reason,
				resolvedBy: "policy",
			});
		}
	}

	getPendingRequests(): ActionApprovalRequest[] {
		return Array.from(this.pending.values()).map((entry) => entry.request);
	}
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
