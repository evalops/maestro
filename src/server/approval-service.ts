import type {
	ActionApprovalRequest,
	ApprovalMode,
} from "../agent/action-approval.js";
import {
	PlatformBackedActionApprovalService,
	type SessionIdProvider,
} from "../approvals/platform-action-approval.js";
import type { ApprovalsServiceConfig } from "../approvals/service-client.js";
import { serverRequestManager } from "./server-request-manager.js";

export class ServerRequestActionApprovalService extends PlatformBackedActionApprovalService {
	constructor(
		mode?: ApprovalMode,
		sessionIdProvider?: SessionIdProvider,
		approvalsServiceConfig?: ApprovalsServiceConfig | false,
	) {
		super(mode, { sessionIdProvider, approvalsServiceConfig });
	}

	protected override onPendingApprovalRegistered(
		sessionId: string | undefined,
		request: ActionApprovalRequest,
	): void {
		serverRequestManager.registerApproval({
			sessionId,
			request,
			service: this,
		});
	}

	protected override onPendingApprovalSettled(
		request: ActionApprovalRequest,
	): void {
		serverRequestManager.unregister(request.id);
	}
}

export class WebActionApprovalService extends ServerRequestActionApprovalService {}
