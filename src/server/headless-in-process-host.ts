import type { HeadlessNotificationType } from "@evalops/contracts";
import type { HeadlessToAgentMessage } from "../cli/headless-protocol.js";
import type {
	EnsureRuntimeOptions,
	HeadlessAttachedSubscription,
	HeadlessRuntimeConnectionClosedSnapshot,
	HeadlessRuntimeService,
	HeadlessRuntimeSnapshot,
	HeadlessRuntimeStreamEnvelope,
	HeadlessRuntimeSubscriptionSnapshot,
} from "./headless-runtime-service.js";

export interface HeadlessInProcessSendOptions {
	scopeKey: string;
	sessionId: string;
	role?: "viewer" | "controller";
	connectionId?: string | null;
	subscriptionId?: string | null;
	message: HeadlessToAgentMessage;
}

export interface HeadlessInProcessDisconnectOptions {
	scopeKey: string;
	sessionId: string;
	connectionId?: string | null;
	subscriptionId?: string | null;
}

export interface HeadlessInProcessSubscribeOptions {
	scopeKey: string;
	sessionId: string;
	role?: "viewer" | "controller";
	takeControl?: boolean;
	optOutNotifications?: HeadlessNotificationType[];
}

export interface HeadlessInProcessStreamOptions {
	scopeKey: string;
	sessionId: string;
	role?: "viewer" | "controller";
	cursor?: number | null;
	optOutNotifications?: HeadlessNotificationType[];
}

export class HeadlessInProcessHost {
	constructor(private readonly runtimeService: HeadlessRuntimeService) {}

	async ensureSession(
		options: EnsureRuntimeOptions,
	): Promise<HeadlessRuntimeSnapshot> {
		const runtime = await this.runtimeService.ensureRuntime(options);
		return runtime.getSnapshot();
	}

	getSnapshot(scopeKey: string, sessionId: string): HeadlessRuntimeSnapshot {
		return this.getRuntime(scopeKey, sessionId).getSnapshot();
	}

	replayFrom(
		scopeKey: string,
		sessionId: string,
		cursor: number,
	): HeadlessRuntimeStreamEnvelope[] | null {
		return this.getRuntime(scopeKey, sessionId).replayFrom(cursor);
	}

	subscribe(
		options: HeadlessInProcessSubscribeOptions,
	): HeadlessRuntimeSubscriptionSnapshot {
		return this.getRuntime(
			options.scopeKey,
			options.sessionId,
		).createSubscription({
			role: options.role ?? "controller",
			explicit: true,
			takeControl: options.takeControl,
			optOutNotifications: options.optOutNotifications,
		});
	}

	attachStream(
		options: HeadlessInProcessStreamOptions,
	): HeadlessAttachedSubscription {
		return this.getRuntime(
			options.scopeKey,
			options.sessionId,
		).createImplicitStream({
			cursor: options.cursor ?? null,
			role: options.role,
			optOutNotifications: options.optOutNotifications,
		});
	}

	async unsubscribe(
		scopeKey: string,
		sessionId: string,
		subscriptionId: string,
	): Promise<boolean> {
		return this.getRuntime(scopeKey, sessionId).unsubscribe(subscriptionId);
	}

	async disconnect(
		options: HeadlessInProcessDisconnectOptions,
	): Promise<HeadlessRuntimeConnectionClosedSnapshot> {
		return this.getRuntime(
			options.scopeKey,
			options.sessionId,
		).disconnectConnection({
			connectionId: options.connectionId,
			subscriptionId: options.subscriptionId,
		});
	}

	async send(
		options: HeadlessInProcessSendOptions,
	): Promise<HeadlessRuntimeSnapshot> {
		const runtime = this.getRuntime(options.scopeKey, options.sessionId);
		const snapshot = runtime.getSnapshot();
		const controllerConnectionId =
			options.connectionId ??
			((options.role ?? "controller") === "controller"
				? (snapshot.state.controller_connection_id ?? undefined)
				: undefined);
		runtime.assertCanSend(
			options.role ?? "controller",
			options.subscriptionId ?? undefined,
			controllerConnectionId,
		);
		await runtime.send(options.message, {
			connectionId: controllerConnectionId,
			subscriptionId: options.subscriptionId ?? undefined,
		});
		return runtime.getSnapshot();
	}

	private getRuntime(scopeKey: string, sessionId: string) {
		const runtime = this.runtimeService.getRuntime(scopeKey, sessionId);
		if (!runtime) {
			throw new Error(`Headless session not found: ${scopeKey}:${sessionId}`);
		}
		return runtime;
	}
}
