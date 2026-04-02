import type {
	ActionApprovalService,
	ApprovalMode,
} from "../agent/action-approval.js";
import type { Agent } from "../agent/index.js";
import type { AgentEvent, Attachment, ThinkingLevel } from "../agent/types.js";
import {
	HEADLESS_PROTOCOL_VERSION,
	type HeadlessClientCapabilities,
	type HeadlessClientInfo,
	type HeadlessClientToolResultMessage,
	type HeadlessFromAgentMessage,
	type HeadlessInitMessage,
	HeadlessProtocolTranslator,
	type HeadlessRuntimeState,
	type HeadlessServerRequestResponseMessage,
	type HeadlessToAgentMessage,
	applyIncomingHeadlessMessage,
	applyInitMessage,
	applyOutgoingHeadlessMessage,
	createHeadlessRuntimeState,
	loadPromptAttachments,
} from "../cli/headless-protocol.js";
import type { RegisteredModel } from "../models/registry.js";
import { checkSessionLimits } from "../safety/policy.js";
import type { SessionManager } from "../session/manager.js";
import { toSessionModelMetadata } from "../session/manager.js";
import { createLogger } from "../utils/logger.js";
import type { WebServerContext } from "./app-context.js";
import { WebActionApprovalService } from "./approval-service.js";
import { getAgentCircuitBreaker } from "./circuit-breaker.js";
import { clientToolService } from "./client-tools-service.js";
import {
	type ServerRequestLifecycleEvent,
	serverRequestManager,
} from "./server-request-manager.js";

const logger = createLogger("server:headless-runtime");

const MAX_BUFFERED_EVENTS =
	Number.parseInt(
		process.env.MAESTRO_HEADLESS_RUNTIME_EVENT_BUFFER || "",
		10,
	) || 512;
const MAX_SUBSCRIBER_MAILBOX_EVENTS =
	Number.parseInt(process.env.MAESTRO_HEADLESS_SUBSCRIBER_QUEUE || "", 10) ||
	128;
const MAX_SUBSCRIPTION_IDLE_MS =
	Number.parseInt(
		process.env.MAESTRO_HEADLESS_SUBSCRIPTION_IDLE_MS || "",
		10,
	) || 30 * 1000;
const MAX_IDLE_MS =
	Number.parseInt(process.env.MAESTRO_HEADLESS_RUNTIME_IDLE_MS || "", 10) ||
	30 * 60 * 1000;

export interface HeadlessRuntimeSnapshot {
	protocolVersion: string;
	session_id: string;
	cursor: number;
	last_init: HeadlessInitMessage | null;
	state: HeadlessRuntimeState;
}

export interface HeadlessRuntimeSnapshotEnvelope {
	type: "snapshot";
	snapshot: HeadlessRuntimeSnapshot;
}

export interface HeadlessRuntimeEventEnvelope {
	type: "message";
	cursor: number;
	message: HeadlessFromAgentMessage;
}

export interface HeadlessRuntimeHeartbeatEnvelope {
	type: "heartbeat";
	cursor: number;
}

export interface HeadlessRuntimeResetEnvelope {
	type: "reset";
	reason: "lagged" | "replay_gap";
	snapshot: HeadlessRuntimeSnapshot;
}

export interface HeadlessRuntimeSubscriptionSnapshot {
	subscription_id: string;
	role: "viewer" | "controller";
	controller_lease_granted: boolean;
	controller_subscription_id: string | null;
	snapshot: HeadlessRuntimeSnapshot;
}

export type HeadlessRuntimeStreamEnvelope =
	| HeadlessRuntimeSnapshotEnvelope
	| HeadlessRuntimeEventEnvelope
	| HeadlessRuntimeHeartbeatEnvelope
	| HeadlessRuntimeResetEnvelope;

type RuntimeListener = (envelope: HeadlessRuntimeStreamEnvelope) => void;
type SubscriberListener = () => void;

function createSubscriptionId(): string {
	return `sub_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

class HeadlessSubscriberMailbox {
	private readonly listeners = new Set<SubscriberListener>();
	private readonly queue: HeadlessRuntimeStreamEnvelope[] = [];
	private queuedReset: HeadlessRuntimeResetEnvelope | null = null;
	private detachedAt: number | null;
	private attached = false;

	constructor(
		readonly id: string,
		readonly role: "viewer" | "controller",
		readonly explicit: boolean,
	) {
		this.detachedAt = explicit ? Date.now() : null;
	}

	onAvailable(listener: SubscriberListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	enqueue(
		envelope: HeadlessRuntimeStreamEnvelope,
		createReset: (
			reason: HeadlessRuntimeResetEnvelope["reason"],
		) => HeadlessRuntimeResetEnvelope,
	): void {
		this.queue.push(envelope);
		if (this.queue.length > MAX_SUBSCRIBER_MAILBOX_EVENTS) {
			this.queue.length = 0;
			this.queuedReset = createReset("lagged");
		}
		this.emit();
	}

	prime(envelope: HeadlessRuntimeStreamEnvelope): void {
		this.queue.push(envelope);
	}

	next(): HeadlessRuntimeStreamEnvelope | null {
		const next = this.queuedReset ?? this.queue.shift() ?? null;
		if (next?.type === "reset") {
			this.queuedReset = null;
		}
		return next;
	}

	attach(): void {
		this.attached = true;
		this.detachedAt = null;
		this.emit();
	}

	detach(): void {
		this.attached = false;
		this.detachedAt = Date.now();
	}

	touch(): void {
		if (this.explicit && !this.attached) {
			this.detachedAt = Date.now();
		}
	}

	isExpired(now = Date.now()): boolean {
		return (
			this.explicit &&
			!this.attached &&
			this.detachedAt !== null &&
			now - this.detachedAt > MAX_SUBSCRIPTION_IDLE_MS
		);
	}

	private emit(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}

export interface HeadlessAttachedSubscription {
	id: string;
	next(): HeadlessRuntimeStreamEnvelope | null;
	onAvailable(listener: SubscriberListener): () => void;
	enqueue(envelope: HeadlessRuntimeStreamEnvelope): void;
	close(): void;
}

class HeadlessRuntimeBroker {
	private nextCursor = 1;
	private readonly listeners = new Set<RuntimeListener>();
	private readonly events: HeadlessRuntimeStreamEnvelope[] = [];

	private publishEnvelope(
		envelope: HeadlessRuntimeStreamEnvelope,
	): HeadlessRuntimeStreamEnvelope {
		this.events.push(envelope);
		while (this.events.length > MAX_BUFFERED_EVENTS) {
			this.events.shift();
		}
		for (const listener of this.listeners) {
			listener(envelope);
		}
		return envelope;
	}

	publish(message: HeadlessFromAgentMessage): HeadlessRuntimeEventEnvelope {
		const envelope: HeadlessRuntimeEventEnvelope = {
			type: "message",
			cursor: this.nextCursor++,
			message,
		};
		return this.publishEnvelope(envelope) as HeadlessRuntimeEventEnvelope;
	}

	publishSnapshot(
		createSnapshot: (cursor: number) => HeadlessRuntimeSnapshot,
	): HeadlessRuntimeSnapshotEnvelope {
		const cursor = this.nextCursor++;
		const envelope: HeadlessRuntimeSnapshotEnvelope = {
			type: "snapshot",
			snapshot: createSnapshot(cursor),
		};
		return this.publishEnvelope(envelope) as HeadlessRuntimeSnapshotEnvelope;
	}

	currentCursor(): number {
		return this.nextCursor - 1;
	}

	replayFrom(cursor: number): HeadlessRuntimeStreamEnvelope[] | null {
		if (this.events.length === 0) {
			return [];
		}
		const earliest = this.getEnvelopeCursor(this.events[0]) ?? this.nextCursor;
		if (cursor < earliest - 1) {
			return null;
		}
		return this.events.filter(
			(event) => (this.getEnvelopeCursor(event) ?? 0) > cursor,
		);
	}

	subscribe(listener: RuntimeListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private getEnvelopeCursor(
		envelope: HeadlessRuntimeStreamEnvelope | undefined,
	): number | undefined {
		if (!envelope) {
			return undefined;
		}
		switch (envelope.type) {
			case "message":
				return envelope.cursor;
			case "heartbeat":
				return envelope.cursor;
			case "snapshot":
			case "reset":
				return envelope.snapshot.cursor;
		}
	}
}

type RuntimeOptions = {
	scope_key: string;
	session_id: string;
	subject?: string;
	clientProtocolVersion?: string;
	clientInfo?: HeadlessClientInfo;
	capabilities?: HeadlessClientCapabilities;
	role?: "viewer" | "controller";
	registeredModel: RegisteredModel;
	thinkingLevel: ThinkingLevel;
	approvalMode: ApprovalMode;
	enableClientTools?: boolean;
	client?: "vscode" | "jetbrains" | "conductor" | "generic";
	context: Pick<WebServerContext, "createAgent">;
	sessionManager: SessionManager;
};

export class HeadlessSessionRuntime {
	private readonly translator = new HeadlessProtocolTranslator();
	private readonly broker = new HeadlessRuntimeBroker();
	private readonly state = createHeadlessRuntimeState();
	private readonly approvalService: ActionApprovalService;
	private readonly agent: Agent;
	private readonly sessionManager: SessionManager;
	private readonly registeredModel: RegisteredModel;
	private readonly subject?: string;
	private readonly sessionId: string;
	private readonly scopeKey: string;
	private readonly publishedServerRequestIds = new Set<string>();
	private readonly suppressedApprovalResolutionIds = new Set<string>();
	private readonly unsubscribeServerRequestEvents: () => void;
	private readonly subscribers = new Map<string, HeadlessSubscriberMailbox>();
	private controllerSubscriptionId: string | null = null;
	private lastInit: HeadlessInitMessage | null = null;
	private running = false;
	private disposed = false;
	private updatedAt = Date.now();

	private constructor(
		options: RuntimeOptions,
		agent: Agent,
		approvalService: ActionApprovalService,
	) {
		this.scopeKey = options.scope_key;
		this.sessionId = options.session_id;
		this.sessionManager = options.sessionManager;
		this.registeredModel = options.registeredModel;
		this.subject = options.subject;
		this.approvalService = approvalService;
		this.agent = agent;

		this.agent.subscribe((event) => {
			this.handleAgentEvent(event);
		});

		this.publish(
			this.translator.buildReadyMessage(this.agent, this.sessionManager),
		);
		this.publish(this.translator.buildSessionInfoMessage(this.sessionManager));
		this.updateConnectionMetadata({
			clientProtocolVersion: options.clientProtocolVersion,
			clientInfo: options.clientInfo,
			capabilities: options.capabilities,
			role: options.role,
		});
		this.unsubscribeServerRequestEvents = serverRequestManager.subscribe(
			(event) => {
				this.handleServerRequestEvent(event);
			},
		);
	}

	static async create(
		options: RuntimeOptions,
	): Promise<HeadlessSessionRuntime> {
		const approvalService = new WebActionApprovalService(
			options.approvalMode,
			options.session_id,
		);
		const agent = await options.context.createAgent(
			options.registeredModel,
			options.thinkingLevel,
			options.approvalMode,
			{
				approvalService,
				enableClientTools: options.enableClientTools,
				useClientAskUser:
					options.capabilities?.server_requests?.includes("user_input") ??
					false,
				clientToolService:
					options.enableClientTools ||
					options.capabilities?.server_requests?.includes("user_input")
						? {
								requestExecution: (id, toolName, args, signal) =>
									clientToolService.requestExecution(
										id,
										toolName,
										args,
										signal,
										options.session_id,
									),
							}
						: undefined,
				includeVscodeTools: options.client === "vscode",
				includeJetBrainsTools: options.client === "jetbrains",
				includeConductorTools: options.client === "conductor",
			},
		);
		return new HeadlessSessionRuntime(options, agent, approvalService);
	}

	id(): string {
		return this.sessionId;
	}

	key(): string {
		return `${this.scopeKey}:${this.sessionId}`;
	}

	isDisposed(): boolean {
		return this.disposed;
	}

	isIdle(now = Date.now()): boolean {
		return (
			!this.running &&
			this.subscribers.size === 0 &&
			now - this.updatedAt > MAX_IDLE_MS
		);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		for (const subscriber of this.subscribers.values()) {
			subscriber.detach();
		}
		this.subscribers.clear();
		this.controllerSubscriptionId = null;
		this.cancelPendingServerRequests(
			"Headless runtime disposed before request completed",
		);
		this.syncSubscriptionState(false);
		this.disposed = true;
		this.running = false;
		this.agent.abort();
		this.unsubscribeServerRequestEvents();
	}

	getSnapshot(): HeadlessRuntimeSnapshot {
		return {
			protocolVersion: HEADLESS_PROTOCOL_VERSION,
			session_id: this.sessionId,
			cursor: this.broker.currentCursor(),
			last_init: this.lastInit,
			state: structuredClone(this.state),
		};
	}

	replayFrom(cursor: number): HeadlessRuntimeStreamEnvelope[] | null {
		return this.broker.replayFrom(cursor);
	}

	subscribe(listener: RuntimeListener): () => void {
		this.updatedAt = Date.now();
		return this.broker.subscribe(listener);
	}

	createSubscription(options?: {
		role?: "viewer" | "controller";
		explicit?: boolean;
		takeControl?: boolean;
	}): HeadlessRuntimeSubscriptionSnapshot {
		const role = options?.role ?? "controller";
		const explicit = options?.explicit ?? true;
		if (
			explicit &&
			role === "controller" &&
			this.controllerSubscriptionId &&
			!options?.takeControl
		) {
			throw new Error("Controller lease is already held by another subscriber");
		}
		const subscriber = new HeadlessSubscriberMailbox(
			createSubscriptionId(),
			role,
			explicit,
		);
		this.subscribers.set(subscriber.id, subscriber);
		if (explicit && role === "controller") {
			this.controllerSubscriptionId = subscriber.id;
		}
		this.updatedAt = Date.now();
		this.syncSubscriptionState(explicit);
		return {
			subscription_id: subscriber.id,
			role,
			controller_lease_granted:
				role === "controller" &&
				this.controllerSubscriptionId === subscriber.id,
			controller_subscription_id: this.controllerSubscriptionId,
			snapshot: this.getSnapshot(),
		};
	}

	attachSubscription(
		subscriptionId: string,
	): HeadlessAttachedSubscription | null {
		const subscriber = this.subscribers.get(subscriptionId);
		if (!subscriber) {
			return null;
		}
		this.updatedAt = Date.now();
		subscriber.attach();
		return {
			id: subscriber.id,
			next: () => subscriber.next(),
			onAvailable: (listener) => subscriber.onAvailable(listener),
			enqueue: (envelope) => {
				subscriber.enqueue(envelope, (reason) =>
					this.buildResetEnvelope(reason),
				);
			},
			close: () => {
				subscriber.detach();
			},
		};
	}

	createImplicitStream(options: {
		cursor: number | null;
		role?: "viewer" | "controller";
	}): HeadlessAttachedSubscription {
		const created = this.createSubscription({
			role: options.role ?? "controller",
			explicit: false,
		});
		const attached = this.attachSubscription(created.subscription_id);
		if (!attached) {
			throw new Error("Failed to attach implicit headless subscriber");
		}
		if (options.cursor !== null && Number.isFinite(options.cursor)) {
			const replay = this.replayFrom(options.cursor);
			if (replay) {
				for (const envelope of replay) {
					attached.enqueue(envelope);
				}
			} else {
				attached.enqueue(this.buildResetEnvelope("replay_gap"));
			}
		} else {
			attached.enqueue({
				type: "snapshot",
				snapshot: this.getSnapshot(),
			});
		}
		const baseClose = attached.close;
		return {
			...attached,
			close: () => {
				baseClose();
				this.unsubscribe(created.subscription_id, false);
			},
		};
	}

	unsubscribe(subscriptionId: string, publish = true): boolean {
		const subscriber = this.subscribers.get(subscriptionId);
		if (!subscriber) {
			return false;
		}
		subscriber.detach();
		this.subscribers.delete(subscriptionId);
		if (this.controllerSubscriptionId === subscriptionId) {
			this.controllerSubscriptionId = null;
		}
		this.updatedAt = Date.now();
		this.syncSubscriptionState(publish && subscriber.explicit);
		return true;
	}

	assertCanSend(
		role: "viewer" | "controller",
		subscriptionId?: string | null,
	): void {
		if (role === "viewer") {
			throw new Error("Viewer headless connections cannot send messages");
		}
		if (!subscriptionId) {
			if (this.controllerSubscriptionId) {
				throw new Error(
					"Controller lease is currently held by another subscriber",
				);
			}
			return;
		}
		const subscriber = this.subscribers.get(subscriptionId);
		if (!subscriber) {
			throw new Error("Headless subscriber not found");
		}
		if (subscriber.role !== "controller") {
			throw new Error("Headless subscriber does not have controller access");
		}
		if (
			this.controllerSubscriptionId &&
			this.controllerSubscriptionId !== subscriptionId
		) {
			throw new Error(
				"Controller lease is currently held by another subscriber",
			);
		}
		if (!this.controllerSubscriptionId && subscriber.explicit) {
			this.controllerSubscriptionId = subscriptionId;
			this.syncSubscriptionState(true);
		}
		subscriber.touch();
	}

	hasSubscription(subscriptionId: string): boolean {
		return this.subscribers.has(subscriptionId);
	}

	expireIdleSubscriptions(now = Date.now()): void {
		for (const [subscriptionId, subscriber] of Array.from(
			this.subscribers.entries(),
		)) {
			if (!subscriber.isExpired(now)) {
				continue;
			}
			this.unsubscribe(subscriptionId, subscriber.explicit);
		}
	}

	heartbeat(): HeadlessRuntimeHeartbeatEnvelope {
		return {
			type: "heartbeat",
			cursor: this.broker.currentCursor(),
		};
	}

	updateConnectionMetadata(metadata: {
		clientProtocolVersion?: string;
		clientInfo?: HeadlessClientInfo;
		capabilities?: HeadlessClientCapabilities;
		role?: "viewer" | "controller";
	}): void {
		if (
			!metadata.clientProtocolVersion &&
			!metadata.clientInfo &&
			!metadata.capabilities &&
			!metadata.role
		) {
			return;
		}
		this.publish(
			this.translator.buildConnectionInfoMessage({
				protocol_version: metadata.clientProtocolVersion,
				client_info: metadata.clientInfo,
				capabilities: metadata.capabilities,
				role: metadata.role,
			}),
		);
	}

	async send(msg: HeadlessToAgentMessage): Promise<void> {
		if (this.disposed) {
			throw new Error("Headless runtime is no longer available");
		}
		this.updatedAt = Date.now();

		switch (msg.type) {
			case "hello": {
				applyOutgoingHeadlessMessage(this.state, msg);
				this.updateConnectionMetadata({
					clientProtocolVersion: msg.protocol_version,
					clientInfo: msg.client_info,
					capabilities: msg.capabilities,
					role: msg.role,
				});
				if (
					msg.protocol_version &&
					msg.protocol_version !== HEADLESS_PROTOCOL_VERSION
				) {
					this.publish({
						type: "status",
						message: `Client protocol ${msg.protocol_version} attached to server ${HEADLESS_PROTOCOL_VERSION}`,
					});
				}
				return;
			}
			case "init": {
				this.lastInit = msg;
				applyOutgoingHeadlessMessage(this.state, msg);
				const applied = applyInitMessage(this.agent, msg, this.approvalService);
				this.publish({
					type: "status",
					message:
						applied.length > 0
							? `Initialized: ${applied.join(", ")}`
							: "Init received with no changes",
				});
				return;
			}
			case "prompt": {
				if (this.running) {
					throw new Error("Headless runtime is already processing a prompt");
				}
				applyOutgoingHeadlessMessage(this.state, msg);
				this.running = true;
				let attachments: Attachment[] | undefined;
				if (msg.attachments?.length) {
					const loaded = await loadPromptAttachments(
						msg.attachments,
						(message) => {
							this.publish({
								type: "error",
								message,
								fatal: false,
								error_type: "tool",
							});
						},
					);
					if (loaded.length > 0) {
						attachments = loaded;
						this.publish({
							type: "status",
							message: `Loaded ${loaded.length} attachment(s)`,
						});
					}
				}
				void this.runPrompt(msg.content, attachments);
				return;
			}
			case "interrupt":
			case "cancel":
				this.cancelPendingServerRequests(
					msg.type === "interrupt"
						? "Interrupted before request completed"
						: "Cancelled before request completed",
				);
				applyOutgoingHeadlessMessage(this.state, msg);
				this.agent.abort();
				this.publishSnapshot();
				return;
			case "tool_response":
				this.resolveLegacyToolResponse(msg);
				applyOutgoingHeadlessMessage(this.state, msg);
				this.publishSnapshot();
				return;
			case "client_tool_result": {
				this.resolveLegacyClientToolResult(msg);
				applyOutgoingHeadlessMessage(this.state, msg);
				this.publishSnapshot();
				return;
			}
			case "server_request_response":
				this.resolveServerRequestResponse(msg);
				applyOutgoingHeadlessMessage(this.state, msg);
				this.publishSnapshot();
				return;
			case "shutdown":
				this.cancelPendingServerRequests("Shutdown before request completed");
				applyOutgoingHeadlessMessage(this.state, msg);
				this.agent.abort();
				this.disposed = true;
				this.unsubscribeServerRequestEvents();
				this.publishSnapshot();
				return;
		}
	}

	private async runPrompt(
		content: string,
		attachments?: Attachment[],
	): Promise<void> {
		try {
			const breaker = getAgentCircuitBreaker(this.registeredModel.provider);
			await breaker.execute(() => this.agent.prompt(content, attachments));
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unknown remote runtime error";
			this.publish({
				type: "error",
				message,
				fatal: false,
				error_type: "transient",
			});
		} finally {
			this.cancelPendingServerRequests("Run ended before request completed");
			this.running = false;
			this.updatedAt = Date.now();
		}
	}

	private publish(message: HeadlessFromAgentMessage): void {
		if (message.type === "server_request") {
			this.publishedServerRequestIds.add(message.request_id);
		} else if (message.type === "server_request_resolved") {
			this.publishedServerRequestIds.delete(message.request_id);
		}
		applyIncomingHeadlessMessage(this.state, message);
		this.syncSubscriptionState(false);
		this.updatedAt = Date.now();
		const envelope = this.broker.publish(message);
		for (const subscriber of this.subscribers.values()) {
			subscriber.enqueue(envelope, (reason) => this.buildResetEnvelope(reason));
		}
	}

	private publishSnapshot(): void {
		this.updatedAt = Date.now();
		const envelope = this.broker.publishSnapshot((cursor) => ({
			protocolVersion: HEADLESS_PROTOCOL_VERSION,
			session_id: this.sessionId,
			cursor,
			last_init: this.lastInit ? structuredClone(this.lastInit) : null,
			state: structuredClone(this.state),
		}));
		for (const subscriber of this.subscribers.values()) {
			subscriber.enqueue(envelope, (reason) => this.buildResetEnvelope(reason));
		}
	}

	private handleAgentEvent(event: AgentEvent): void {
		if (
			event.type === "action_approval_resolved" &&
			this.suppressedApprovalResolutionIds.delete(event.request.id)
		) {
			this.sessionManager.updateSnapshot(
				this.agent.state,
				toSessionModelMetadata(this.registeredModel),
			);
			return;
		}

		for (const message of this.translator.handleAgentEvent(event)) {
			if (message.type === "server_request_resolved") {
				continue;
			}
			this.publish(message);
		}

		if (event.type === "message_end") {
			this.sessionManager.saveMessage(event.message);
			if (
				this.sessionManager.shouldInitializeSession(this.agent.state.messages)
			) {
				let activeCount: number | undefined;
				try {
					const sessions = this.sessionManager.loadAllSessions();
					activeCount = sessions.filter(
						(session) =>
							Date.now() - session.modified.getTime() < 60 * 60 * 1000,
					).length;
				} catch (error) {
					logger.warn("Failed to count active sessions for headless runtime", {
						error: error instanceof Error ? error.message : String(error),
					});
				}

				const limitCheck = checkSessionLimits(
					{ startedAt: new Date() },
					activeCount !== undefined
						? { activeSessionCount: activeCount + 1 }
						: undefined,
				);

				if (!limitCheck.allowed) {
					this.publish({
						type: "error",
						message: `[Policy] ${limitCheck.reason}`,
						fatal: false,
						error_type: "fatal",
					});
					return;
				}

				this.sessionManager.startSession(this.agent.state, {
					subject: this.subject,
				});
			}
		}

		this.sessionManager.updateSnapshot(
			this.agent.state,
			toSessionModelMetadata(this.registeredModel),
		);
	}

	private cancelPendingServerRequests(reason: string): void {
		serverRequestManager.cancelBySession(this.sessionId, reason, "runtime");
	}

	private buildResetEnvelope(
		reason: HeadlessRuntimeResetEnvelope["reason"],
	): HeadlessRuntimeResetEnvelope {
		return {
			type: "reset",
			reason,
			snapshot: this.getSnapshot(),
		};
	}

	private syncSubscriptionState(publish: boolean): void {
		this.state.subscriber_count = this.subscribers.size;
		this.state.controller_subscription_id = this.controllerSubscriptionId;
		if (publish) {
			this.publishSnapshot();
		}
	}

	private handleServerRequestEvent(event: ServerRequestLifecycleEvent): void {
		if (event.request.sessionId !== this.sessionId) {
			return;
		}

		if (event.type === "registered") {
			if (this.publishedServerRequestIds.has(event.request.id)) {
				return;
			}
			this.publish({
				type: "server_request",
				request_id: event.request.id,
				request_type: event.request.kind,
				call_id: event.request.id,
				tool: event.request.toolName,
				args: event.request.args,
				reason: event.request.reason,
			});
			return;
		}

		if (event.request.kind === "approval") {
			this.suppressedApprovalResolutionIds.add(event.request.id);
		}
		this.publish({
			type: "server_request_resolved",
			request_id: event.request.id,
			request_type: event.request.kind,
			call_id: event.request.id,
			resolution: event.resolution,
			reason: event.reason,
			resolved_by: event.resolvedBy,
		});
	}

	private resolveLegacyToolResponse(
		msg: HeadlessToAgentMessage & { type: "tool_response" },
	): void {
		const reason = msg.approved
			? (msg.result?.output ?? "Approved")
			: (msg.result?.error ?? "Denied by user");
		const resolved = serverRequestManager.resolveApproval(msg.call_id, {
			approved: msg.approved,
			reason,
			resolvedBy: "user",
		});
		if (!resolved) {
			throw new Error(`No pending approval found for call_id: ${msg.call_id}`);
		}
	}

	private resolveLegacyClientToolResult(
		msg: HeadlessClientToolResultMessage,
	): void {
		const resolved = clientToolService.resolve(
			msg.call_id,
			msg.content,
			msg.is_error,
		);
		if (!resolved) {
			throw new Error(
				`No pending client tool request found for call_id: ${msg.call_id}`,
			);
		}
	}

	private resolveServerRequestResponse(
		msg: HeadlessServerRequestResponseMessage,
	): void {
		const request = serverRequestManager.get(msg.request_id);
		if (!request) {
			throw new Error(
				`No pending server request found for request_id: ${msg.request_id}`,
			);
		}
		if (request.kind !== msg.request_type) {
			throw new Error(
				`Pending request ${msg.request_id} is ${request.kind}, not ${msg.request_type}`,
			);
		}

		if (msg.request_type === "approval") {
			const reason = msg.approved
				? (msg.result?.output ?? "Approved")
				: (msg.result?.error ?? "Denied by user");
			const resolved = serverRequestManager.resolveApproval(msg.request_id, {
				approved: msg.approved ?? false,
				reason,
				resolvedBy: "user",
			});
			if (!resolved) {
				throw new Error(
					`No pending approval found for request_id: ${msg.request_id}`,
				);
			}
			return;
		}

		const resolved = clientToolService.resolve(
			msg.request_id,
			msg.content ?? [],
			msg.is_error ?? false,
		);
		if (!resolved) {
			throw new Error(
				`No pending client tool request found for request_id: ${msg.request_id}`,
			);
		}
	}
}

type EnsureRuntimeOptions = {
	scope_key: string;
	sessionId?: string;
	subject?: string;
	clientProtocolVersion?: string;
	clientInfo?: HeadlessClientInfo;
	capabilities?: HeadlessClientCapabilities;
	role?: "viewer" | "controller";
	registeredModel: RegisteredModel;
	thinkingLevel: ThinkingLevel;
	approvalMode: ApprovalMode;
	enableClientTools?: boolean;
	client?: "vscode" | "jetbrains" | "conductor" | "generic";
	context: Pick<WebServerContext, "createAgent">;
	sessionManager: SessionManager;
};

export class HeadlessRuntimeService {
	private readonly runtimes = new Map<string, HeadlessSessionRuntime>();

	constructor() {
		setInterval(() => this.cleanup(), 60 * 1000).unref();
	}

	async ensureRuntime(
		options: EnsureRuntimeOptions,
	): Promise<HeadlessSessionRuntime> {
		if (options.sessionId) {
			const existing = this.getRuntime(options.scope_key, options.sessionId);
			if (existing) {
				existing.updateConnectionMetadata({
					clientProtocolVersion: options.clientProtocolVersion,
					clientInfo: options.clientInfo,
					capabilities: options.capabilities,
					role: options.role,
				});
				return existing;
			}
		}

		const sessionId = options.sessionManager.getSessionId();
		const runtime = await HeadlessSessionRuntime.create({
			scope_key: options.scope_key,
			session_id: sessionId,
			subject: options.subject,
			clientProtocolVersion: options.clientProtocolVersion,
			clientInfo: options.clientInfo,
			capabilities: options.capabilities,
			role: options.role,
			registeredModel: options.registeredModel,
			thinkingLevel: options.thinkingLevel,
			approvalMode: options.approvalMode,
			enableClientTools: options.enableClientTools,
			client: options.client,
			context: options.context,
			sessionManager: options.sessionManager,
		});
		this.runtimes.set(runtime.key(), runtime);
		return runtime;
	}

	getRuntime(
		scopeKey: string,
		sessionId: string,
	): HeadlessSessionRuntime | undefined {
		const runtime = this.runtimes.get(`${scopeKey}:${sessionId}`);
		if (!runtime || runtime.isDisposed()) {
			return undefined;
		}
		return runtime;
	}

	private cleanup(): void {
		const now = Date.now();
		for (const [key, runtime] of this.runtimes.entries()) {
			runtime.expireIdleSubscriptions(now);
			if (runtime.isDisposed() || runtime.isIdle(now)) {
				runtime.dispose();
				this.runtimes.delete(key);
			}
		}
	}
}
