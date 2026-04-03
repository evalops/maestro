export type ToolRetryMode = "prompt" | "skip" | "abort";

export interface ToolRetryConfig {
	maxAutoRetries?: number;
	initialDelayMs?: number;
	maxDelayMs?: number;
	backoffMultiplier?: number;
}

export interface ToolRetryRequest {
	/** Unique request identifier (per retry prompt). */
	id: string;
	/** Tool call identifier the retry applies to. */
	toolCallId: string;
	/** Tool name for display. */
	toolName: string;
	/** Arguments passed to the tool. */
	args: unknown;
	/** Short error summary for UI display. */
	errorMessage: string;
	/** Attempt number for this failure (1-indexed). */
	attempt: number;
	/** Maximum attempts before giving up (if known). */
	maxAttempts?: number;
	/** Optional summary string for banners. */
	summary?: string;
}

export interface ToolRetryDecision {
	action: "retry" | "skip" | "abort";
	reason?: string;
	resolvedBy: "policy" | "user" | "runtime";
}

interface PendingEntry {
	request: ToolRetryRequest;
	resolve: (decision: ToolRetryDecision) => void;
	cleanup?: () => void;
}

export class ToolRetryService {
	private pending = new Map<string, PendingEntry>();

	constructor(private mode: ToolRetryMode = "prompt") {}

	setMode(mode: ToolRetryMode): void {
		this.mode = mode;
	}

	getMode(): ToolRetryMode {
		return this.mode;
	}

	requiresUserInteraction(): boolean {
		return this.mode === "prompt";
	}

	async requestDecision(
		request: ToolRetryRequest,
		signal?: AbortSignal,
	): Promise<ToolRetryDecision> {
		if (this.mode === "skip") {
			return {
				action: "skip",
				reason: "Retry skipped by policy",
				resolvedBy: "policy",
			};
		}
		if (this.mode === "abort") {
			return {
				action: "abort",
				reason: "Retry aborted by policy",
				resolvedBy: "policy",
			};
		}
		if (signal?.aborted) {
			return {
				action: "abort",
				reason: "Run aborted",
				resolvedBy: "policy",
			};
		}

		return await new Promise<ToolRetryDecision>((resolve) => {
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
						action: "abort",
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

	retry(
		id: string,
		reason?: string,
		resolvedBy: ToolRetryDecision["resolvedBy"] = "user",
	): boolean {
		return this.resolveEntry(id, {
			action: "retry",
			reason: reason ?? "Retrying",
			resolvedBy,
		});
	}

	skip(
		id: string,
		reason?: string,
		resolvedBy: ToolRetryDecision["resolvedBy"] = "user",
	): boolean {
		return this.resolveEntry(id, {
			action: "skip",
			reason: reason ?? "Skipped",
			resolvedBy,
		});
	}

	abort(
		id: string,
		reason?: string,
		resolvedBy: ToolRetryDecision["resolvedBy"] = "user",
	): boolean {
		return this.resolveEntry(id, {
			action: "abort",
			reason: reason ?? "Aborted",
			resolvedBy,
		});
	}

	clearPending(reason = "Retry cancelled"): void {
		for (const id of Array.from(this.pending.keys())) {
			this.resolveEntry(id, {
				action: "skip",
				reason,
				resolvedBy: "policy",
			});
		}
	}

	getPendingRequests(): ToolRetryRequest[] {
		return Array.from(this.pending.values()).map((entry) => entry.request);
	}

	private resolveEntry(id: string, decision: ToolRetryDecision): boolean {
		const entry = this.pending.get(id);
		if (!entry) {
			return false;
		}
		this.pending.delete(id);
		entry.resolve(decision);
		return true;
	}
}
