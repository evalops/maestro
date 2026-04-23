import {
	type ActionApprovalDecision,
	type ActionApprovalRequest,
	ActionApprovalService,
	type ApprovalMode,
} from "../agent/action-approval.js";
import { createLogger } from "../utils/logger.js";
import {
	type ApprovalsServiceConfig,
	type ResolvedApprovalsServiceConfig,
	requestApprovalWithApprovalsService,
	resolveApprovalWithApprovalsService,
	resolveApprovalsServiceConfig,
} from "./service-client.js";

export type SessionIdProvider = string | (() => string | undefined);

type RemoteApprovalRegistration = {
	config: ResolvedApprovalsServiceConfig;
	requestId: string;
};

export interface PlatformBackedActionApprovalOptions {
	sessionIdProvider?: SessionIdProvider;
	approvalsServiceConfig?: ApprovalsServiceConfig | false;
}

const logger = createLogger("approvals:platform-action-approval");

export class PlatformBackedActionApprovalService extends ActionApprovalService {
	private readonly sessionIdProvider?: SessionIdProvider;
	private readonly approvalsServiceConfig?: ApprovalsServiceConfig | false;

	constructor(
		mode?: ApprovalMode,
		options: PlatformBackedActionApprovalOptions = {},
	) {
		super(mode);
		this.sessionIdProvider = options.sessionIdProvider;
		this.approvalsServiceConfig = options.approvalsServiceConfig;
	}

	override async requestApproval(
		request: ActionApprovalRequest,
		signal?: AbortSignal,
	): Promise<ActionApprovalDecision> {
		if (!this.requiresUserInteraction()) {
			return await super.requestApproval(request, signal);
		}

		const sessionId = this.getSessionId();
		const remoteRegistration = this.hasApprovalsServiceCandidate()
			? await this.requestRemoteApproval(request, sessionId, signal)
			: { remote: null };
		if ("decision" in remoteRegistration) {
			return remoteRegistration.decision;
		}

		this.onPendingApprovalRegistered(sessionId, request);
		try {
			const decision = await super.requestApproval(request, signal);
			if (remoteRegistration.remote) {
				return await this.resolveRemoteApproval(
					remoteRegistration.remote,
					decision,
					signal,
				);
			}
			return decision;
		} finally {
			this.onPendingApprovalSettled(request);
		}
	}

	protected onPendingApprovalRegistered(
		_sessionId: string | undefined,
		_request: ActionApprovalRequest,
	): void {}

	protected onPendingApprovalSettled(_request: ActionApprovalRequest): void {}

	private getSessionId(): string | undefined {
		if (typeof this.sessionIdProvider === "function") {
			return this.sessionIdProvider();
		}
		return this.sessionIdProvider;
	}

	private hasApprovalsServiceCandidate(): boolean {
		if (this.approvalsServiceConfig === false) {
			return false;
		}
		if (this.approvalsServiceConfig?.baseUrl) {
			return true;
		}
		return Boolean(
			process.env.APPROVALS_SERVICE_URL?.trim() ||
				process.env.MAESTRO_APPROVALS_SERVICE_URL?.trim() ||
				process.env.MAESTRO_PLATFORM_BASE_URL?.trim() ||
				process.env.MAESTRO_EVALOPS_BASE_URL?.trim() ||
				process.env.EVALOPS_BASE_URL?.trim(),
		);
	}

	private async requestRemoteApproval(
		request: ActionApprovalRequest,
		sessionId: string | undefined,
		signal?: AbortSignal,
	): Promise<
		| { remote: RemoteApprovalRegistration | null }
		| { decision: ActionApprovalDecision }
	> {
		let config: ResolvedApprovalsServiceConfig | null;
		try {
			config = resolveApprovalsServiceConfig(this.approvalsServiceConfig);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(
				"Failed to resolve approvals service config; using local approval",
				{
					error: message,
					toolName: request.toolName,
				},
			);
			return { remote: null };
		}
		if (!config) {
			return { remote: null };
		}

		try {
			const remote = await requestApprovalWithApprovalsService(
				config,
				request,
				{
					sessionId,
					signal,
				},
			);
			if (!remote) {
				return { remote: null };
			}
			if (remote.autoApprovedReason) {
				return {
					decision: {
						approved: true,
						reason: remote.autoApprovedReason,
						resolvedBy: "policy",
					},
				};
			}
			return { remote: { config, requestId: remote.requestId } };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (config.failureMode === "required") {
				return {
					decision: {
						approved: false,
						reason: `Approvals service unavailable: ${message}`,
						resolvedBy: "policy",
					},
				};
			}
			logger.warn(
				"Failed to register approval with approvals service; using local approval",
				{
					error: message,
					toolName: request.toolName,
				},
			);
			return { remote: null };
		}
	}

	private async resolveRemoteApproval(
		remote: RemoteApprovalRegistration,
		decision: ActionApprovalDecision,
		signal?: AbortSignal,
	): Promise<ActionApprovalDecision> {
		try {
			await resolveApprovalWithApprovalsService(
				remote.config,
				remote.requestId,
				decision,
				{ signal },
			);
			return decision;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (remote.config.failureMode === "required" && decision.approved) {
				return {
					approved: false,
					reason: `Approvals service decision sync failed: ${message}`,
					resolvedBy: "policy",
				};
			}
			logger.warn("Failed to sync approval decision to approvals service", {
				error: message,
				remoteRequestId: remote.requestId,
			});
			return decision;
		}
	}
}
