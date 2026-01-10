import {
	type ActionApprovalDecision,
	type ActionApprovalRequest,
	ActionApprovalService,
} from "../agent/action-approval.js";
import { approvalStore } from "./approval-store.js";

export class WebActionApprovalService extends ActionApprovalService {
	override async requestApproval(
		request: ActionApprovalRequest,
		signal?: AbortSignal,
	): Promise<ActionApprovalDecision> {
		if (this.requiresUserInteraction()) {
			approvalStore.register(request.id, this);
		}
		try {
			return await super.requestApproval(request, signal);
		} finally {
			approvalStore.unregister(request.id);
		}
	}
}
