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

export interface PendingApprovalRegistration {
	remoteApprovalRequestId?: string;
}

interface PendingApprovalRegistrationWaiter {
	resolve: (registration: PendingApprovalRegistration | null) => void;
	timeout: ReturnType<typeof setTimeout>;
}

export interface PlatformBackedActionApprovalOptions {
	sessionIdProvider?: SessionIdProvider;
	approvalsServiceConfig?: ApprovalsServiceConfig | false;
}

const logger = createLogger("approvals:platform-action-approval");
const PENDING_APPROVAL_REGISTRATION_WAIT_TIMEOUT_MS = 30_000;

export class PlatformBackedActionApprovalService extends ActionApprovalService {
	private readonly sessionIdProvider?: SessionIdProvider;
	private readonly approvalsServiceConfig?: ApprovalsServiceConfig | false;
	private readonly pendingApprovalRegistrations = new Map<
		string,
		PendingApprovalRegistration
	>();
	private readonly pendingApprovalRegistrationWaiters = new Map<
		string,
		PendingApprovalRegistrationWaiter[]
	>();

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
			this.publishPendingApprovalRegistration(request.id, null);
			return remoteRegistration.decision;
		}

		this.publishPendingApprovalRegistration(request.id, {
			remoteApprovalRequestId: remoteRegistration.remote?.requestId,
		});
		if (remoteRegistration.remote?.requestId && !request.platform) {
			request.platform = {
				source: "approvals_service",
				approvalRequestId: remoteRegistration.remote.requestId,
			};
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
			this.publishPendingApprovalRegistration(request.id, null);
			this.onPendingApprovalSettled(request);
		}
	}

	getPendingApprovalRegistration(
		requestId: string,
	): PendingApprovalRegistration | undefined {
		return this.pendingApprovalRegistrations.get(requestId);
	}

	waitForPendingApprovalRegistration(
		requestId: string,
		options: { signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<PendingApprovalRegistration | null> {
		const existing = this.pendingApprovalRegistrations.get(requestId);
		if (existing) {
			return Promise.resolve(existing);
		}
		if (options.signal?.aborted) {
			return Promise.resolve(null);
		}

		return new Promise((resolve) => {
			const service = this;
			let settled = false;
			const onAbort = () => finish(null);
			const timeout = setTimeout(
				() => finish(null),
				options.timeoutMs ?? PENDING_APPROVAL_REGISTRATION_WAIT_TIMEOUT_MS,
			);
			timeout.unref?.();
			const waiter: PendingApprovalRegistrationWaiter = {
				resolve: finish,
				timeout,
			};
			function finish(registration: PendingApprovalRegistration | null) {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timeout);
				options.signal?.removeEventListener("abort", onAbort);
				service.removePendingApprovalRegistrationWaiter(requestId, waiter);
				resolve(registration);
			}
			const waiters =
				this.pendingApprovalRegistrationWaiters.get(requestId) ?? [];
			waiters.push(waiter);
			this.pendingApprovalRegistrationWaiters.set(requestId, waiters);
			options.signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	protected onPendingApprovalRegistered(
		_sessionId: string | undefined,
		_request: ActionApprovalRequest,
	): void {}

	protected onPendingApprovalSettled(_request: ActionApprovalRequest): void {}

	private publishPendingApprovalRegistration(
		requestId: string,
		registration: PendingApprovalRegistration | null,
	): void {
		if (registration) {
			this.pendingApprovalRegistrations.set(requestId, registration);
		} else {
			this.pendingApprovalRegistrations.delete(requestId);
		}

		const waiters = this.pendingApprovalRegistrationWaiters.get(requestId);
		if (!waiters) {
			return;
		}
		this.pendingApprovalRegistrationWaiters.delete(requestId);
		for (const waiter of waiters) {
			waiter.resolve(registration);
		}
	}

	private removePendingApprovalRegistrationWaiter(
		requestId: string,
		waiter: PendingApprovalRegistrationWaiter,
	): void {
		const waiters = this.pendingApprovalRegistrationWaiters.get(requestId);
		if (!waiters) {
			return;
		}
		const remaining = waiters.filter((candidate) => candidate !== waiter);
		if (remaining.length > 0) {
			this.pendingApprovalRegistrationWaiters.set(requestId, remaining);
		} else {
			this.pendingApprovalRegistrationWaiters.delete(requestId);
		}
	}

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
