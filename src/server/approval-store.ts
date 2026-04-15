import type { ActionApprovalService } from "../agent/action-approval.js";

type PendingEntry = {
	service: ActionApprovalService;
	timestamp: number;
};

class ApprovalStore {
	private pending = new Map<string, PendingEntry>();

	register(id: string, service: ActionApprovalService) {
		this.pending.set(id, { service, timestamp: Date.now() });
	}

	unregister(id: string) {
		this.pending.delete(id);
	}

	get(id: string): ActionApprovalService | undefined {
		return this.pending.get(id)?.service;
	}

	/**
	 * Cleanup stale entries (older than 1 hour)
	 */
	cleanup() {
		const now = Date.now();
		const hour = 60 * 60 * 1000;
		for (const [id, entry] of this.pending.entries()) {
			if (now - entry.timestamp > hour) {
				this.pending.delete(id);
			}
		}
	}
}

export const approvalStore = new ApprovalStore();

// Run cleanup periodically
setInterval(() => approvalStore.cleanup(), 5 * 60 * 1000).unref();
