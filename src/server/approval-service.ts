import {
	type ActionApprovalDecision,
	type ActionApprovalRequest,
	ActionApprovalService,
} from "../agent/action-approval.js";
import { serverRequestManager } from "./server-request-manager.js";

export class ServerRequestActionApprovalService extends ActionApprovalService {
	constructor(
		mode?: ConstructorParameters<typeof ActionApprovalService>[0],
		private readonly sessionId?: string,
	) {
		super(mode);
	}

	override async requestApproval(
		request: ActionApprovalRequest,
		signal?: AbortSignal,
	): Promise<ActionApprovalDecision> {
		if (this.requiresUserInteraction()) {
			serverRequestManager.registerApproval({
				sessionId: this.sessionId,
				request,
				service: this,
			});
		}
		try {
			return await super.requestApproval(request, signal);
		} finally {
			serverRequestManager.unregister(request.id);
		}
	}
}

export class WebActionApprovalService extends ServerRequestActionApprovalService {}
