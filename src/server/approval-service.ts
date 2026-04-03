import {
	type ActionApprovalDecision,
	type ActionApprovalRequest,
	ActionApprovalService,
} from "../agent/action-approval.js";
import { serverRequestManager } from "./server-request-manager.js";

type SessionIdProvider = string | (() => string | undefined);

export class ServerRequestActionApprovalService extends ActionApprovalService {
	constructor(
		mode?: ConstructorParameters<typeof ActionApprovalService>[0],
		private readonly sessionIdProvider?: SessionIdProvider,
	) {
		super(mode);
	}

	override async requestApproval(
		request: ActionApprovalRequest,
		signal?: AbortSignal,
	): Promise<ActionApprovalDecision> {
		if (this.requiresUserInteraction()) {
			serverRequestManager.registerApproval({
				sessionId: this.getSessionId(),
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

	private getSessionId(): string | undefined {
		if (typeof this.sessionIdProvider === "function") {
			return this.sessionIdProvider();
		}
		return this.sessionIdProvider;
	}
}

export class WebActionApprovalService extends ServerRequestActionApprovalService {}
