import {
	type ToolRetryDecision,
	type ToolRetryMode,
	type ToolRetryRequest,
	ToolRetryService,
} from "../agent/tool-retry.js";
import { serverRequestManager } from "./server-request-manager.js";

type SessionIdProvider = string | (() => string | undefined);

export class ServerRequestToolRetryService extends ToolRetryService {
	constructor(
		mode: ToolRetryMode = "prompt",
		private readonly sessionIdProvider?: SessionIdProvider,
	) {
		super(mode);
	}

	override async requestDecision(
		request: ToolRetryRequest,
		signal?: AbortSignal,
	): Promise<ToolRetryDecision> {
		if (this.requiresUserInteraction()) {
			serverRequestManager.registerToolRetry({
				sessionId: this.getSessionId(),
				request,
				service: this,
			});
		}
		try {
			return await super.requestDecision(request, signal);
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
