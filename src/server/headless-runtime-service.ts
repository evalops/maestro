import {
	type HeadlessConnectionRole,
	type HeadlessNotificationType,
	assertHeadlessFromAgentMessage,
	assertHeadlessRuntimeHeartbeatSnapshot,
	assertHeadlessRuntimeSnapshot,
	assertHeadlessRuntimeStreamEnvelope,
	assertHeadlessRuntimeSubscriptionSnapshot,
} from "@evalops/contracts";
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
	type HeadlessConnectionState,
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
import { HeadlessUtilityCommandManager } from "../headless/utility-command-manager.js";
import { searchWorkspaceFiles } from "../headless/utility-file-search.js";
import { HeadlessUtilityFileWatchManager } from "../headless/utility-file-watch-manager.js";
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
const CONNECTION_HEARTBEAT_INTERVAL_MS =
	Number.parseInt(
		process.env.MAESTRO_HEADLESS_CONNECTION_HEARTBEAT_INTERVAL_MS || "",
		10,
	) || 15 * 1000;
const MAX_CONNECTION_IDLE_MS =
	Number.parseInt(process.env.MAESTRO_HEADLESS_CONNECTION_IDLE_MS || "", 10) ||
	CONNECTION_HEARTBEAT_INTERVAL_MS * 3;
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
	connection_id: string;
	subscription_id: string;
	opt_out_notifications?: HeadlessNotificationType[];
	role: "viewer" | "controller";
	controller_lease_granted: boolean;
	controller_subscription_id: string | null;
	controller_connection_id: string | null;
	lease_expires_at: string | null;
	heartbeat_interval_ms: number;
	snapshot: HeadlessRuntimeSnapshot;
}

export interface HeadlessRuntimeHeartbeatSnapshot {
	connection_id: string;
	controller_lease_granted: boolean;
	controller_connection_id: string | null;
	lease_expires_at: string | null;
	heartbeat_interval_ms: number;
}

export type HeadlessRuntimeStreamEnvelope =
	| HeadlessRuntimeSnapshotEnvelope
	| HeadlessRuntimeEventEnvelope
	| HeadlessRuntimeHeartbeatEnvelope
	| HeadlessRuntimeResetEnvelope;

type RuntimeListener = (envelope: HeadlessRuntimeStreamEnvelope) => void;
type SubscriberListener = () => void;

function createConnectionId(): string {
	return `conn_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

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
		readonly connectionId: string,
		readonly optOutNotifications: HeadlessNotificationType[] = [],
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
		if (this.shouldFilterEnvelope(envelope)) {
			return;
		}
		this.queue.push(envelope);
		if (this.queue.length > MAX_SUBSCRIBER_MAILBOX_EVENTS) {
			this.queue.length = 0;
			this.queuedReset = createReset("lagged");
		}
		this.emit();
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

	isAttached(): boolean {
		return this.attached;
	}

	private emit(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	private shouldFilterEnvelope(
		envelope: HeadlessRuntimeStreamEnvelope,
	): boolean {
		if (this.optOutNotifications.length === 0) {
			return false;
		}
		if (
			envelope.type === "heartbeat" &&
			this.optOutNotifications.includes("heartbeat")
		) {
			return true;
		}
		if (envelope.type !== "message") {
			return false;
		}
		switch (envelope.message.type) {
			case "status":
				return this.optOutNotifications.includes("status");
			case "connection_info":
				return this.optOutNotifications.includes("connection_info");
			case "compaction":
				return this.optOutNotifications.includes("compaction");
			default:
				return false;
		}
	}
}

interface HeadlessConnectionRecord {
	id: string;
	role: HeadlessConnectionRole;
	clientProtocolVersion?: string;
	clientInfo?: HeadlessClientInfo;
	capabilities?: HeadlessClientCapabilities;
	optOutNotifications?: HeadlessNotificationType[];
	subscriptionIds: Set<string>;
	lastSeenAt: number;
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
		assertHeadlessRuntimeStreamEnvelope(
			envelope,
			"headless runtime stream envelope",
		);
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
	private readonly utilityCommands = new HeadlessUtilityCommandManager(
		(event) => {
			switch (event.type) {
				case "started":
					this.publish({
						type: "utility_command_started",
						command_id: event.command_id,
						command: event.command,
						...(event.cwd ? { cwd: event.cwd } : {}),
						shell_mode: event.shell_mode,
						terminal_mode: event.terminal_mode,
						...(event.pid !== undefined ? { pid: event.pid } : {}),
						...(event.columns !== undefined ? { columns: event.columns } : {}),
						...(event.rows !== undefined ? { rows: event.rows } : {}),
						...(event.owner_connection_id
							? { owner_connection_id: event.owner_connection_id }
							: {}),
					});
					return;
				case "resized":
					this.publish({
						type: "utility_command_resized",
						command_id: event.command_id,
						columns: event.columns,
						rows: event.rows,
					});
					return;
				case "output":
					this.publish({
						type: "utility_command_output",
						command_id: event.command_id,
						stream: event.stream,
						content: event.content,
					});
					return;
				case "exited":
					this.publish({
						type: "utility_command_exited",
						command_id: event.command_id,
						success: event.success,
						exit_code: event.exit_code,
						signal: event.signal,
						reason: event.reason,
					});
					return;
			}
		},
	);
	private readonly fileWatches = new HeadlessUtilityFileWatchManager(
		(event) => {
			switch (event.type) {
				case "started":
					this.publish({
						type: "utility_file_watch_started",
						watch_id: event.watch_id,
						root_dir: event.root_dir,
						include_patterns: event.include_patterns,
						exclude_patterns: event.exclude_patterns,
						debounce_ms: event.debounce_ms,
						owner_connection_id: event.owner_connection_id,
					});
					return;
				case "event":
					this.publish({
						type: "utility_file_watch_event",
						watch_id: event.watch_id,
						change_type: event.change_type,
						path: event.path,
						relative_path: event.relative_path,
						timestamp: event.timestamp,
						is_directory: event.is_directory,
					});
					return;
				case "stopped":
					this.publish({
						type: "utility_file_watch_stopped",
						watch_id: event.watch_id,
						reason: event.reason,
					});
					return;
			}
		},
	);
	private readonly subscribers = new Map<string, HeadlessSubscriberMailbox>();
	private readonly connections = new Map<string, HeadlessConnectionRecord>();
	private controllerConnectionId: string | null = null;
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
						? clientToolService.forSession(options.session_id)
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

	async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		for (const subscriber of this.subscribers.values()) {
			subscriber.detach();
		}
		this.subscribers.clear();
		this.connections.clear();
		this.controllerConnectionId = null;
		this.cancelPendingServerRequests(
			"Headless runtime disposed before request completed",
		);
		this.syncSubscriptionState(false);
		this.disposed = true;
		this.running = false;
		await this.utilityCommands.dispose();
		this.fileWatches.dispose();
		this.agent.abort();
		this.unsubscribeServerRequestEvents();
	}

	getSnapshot(): HeadlessRuntimeSnapshot {
		const snapshot: HeadlessRuntimeSnapshot = {
			protocolVersion: HEADLESS_PROTOCOL_VERSION,
			session_id: this.sessionId,
			cursor: this.broker.currentCursor(),
			last_init: this.lastInit,
			state: structuredClone(this.state),
		};
		assertHeadlessRuntimeSnapshot(snapshot, "headless runtime snapshot");
		return snapshot;
	}

	replayFrom(cursor: number): HeadlessRuntimeStreamEnvelope[] | null {
		return this.broker.replayFrom(cursor);
	}

	subscribe(listener: RuntimeListener): () => void {
		this.updatedAt = Date.now();
		return this.broker.subscribe(listener);
	}

	private getConnectionById(
		connectionId: string | null | undefined,
	): HeadlessConnectionRecord | undefined {
		return connectionId ? this.connections.get(connectionId) : undefined;
	}

	private getPreferredConnection(): HeadlessConnectionRecord | undefined {
		if (this.controllerConnectionId) {
			const controller = this.connections.get(this.controllerConnectionId);
			if (controller) {
				return controller;
			}
		}
		return Array.from(this.connections.values()).sort(
			(left, right) => right.lastSeenAt - left.lastSeenAt,
		)[0];
	}

	private getControllerSubscriptionId(): string | null {
		const controller = this.getConnectionById(this.controllerConnectionId);
		if (!controller) {
			return null;
		}
		for (const subscriptionId of controller.subscriptionIds) {
			if (this.subscribers.get(subscriptionId)?.isAttached()) {
				return subscriptionId;
			}
		}
		return controller.subscriptionIds.values().next().value ?? null;
	}

	private getLeaseExpiryIso(connection: HeadlessConnectionRecord): string {
		return new Date(
			connection.lastSeenAt + MAX_CONNECTION_IDLE_MS,
		).toISOString();
	}

	private touchConnection(connectionId: string): void {
		const connection = this.connections.get(connectionId);
		if (!connection) {
			return;
		}
		connection.lastSeenAt = Date.now();
		this.updatedAt = connection.lastSeenAt;
	}

	private countAttachedSubscriptions(connectionId: string): number {
		let attached = 0;
		for (const subscriptionId of this.connections.get(connectionId)
			?.subscriptionIds ?? []) {
			if (this.subscribers.get(subscriptionId)?.isAttached()) {
				attached += 1;
			}
		}
		return attached;
	}

	private buildConnectionState(
		connection: HeadlessConnectionRecord,
	): HeadlessConnectionState {
		return {
			connection_id: connection.id,
			role: connection.role,
			client_protocol_version: connection.clientProtocolVersion,
			client_info: connection.clientInfo,
			capabilities: connection.capabilities,
			opt_out_notifications: connection.optOutNotifications
				? [...connection.optOutNotifications]
				: undefined,
			subscription_count: connection.subscriptionIds.size,
			attached_subscription_count: this.countAttachedSubscriptions(
				connection.id,
			),
			controller_lease_granted: this.controllerConnectionId === connection.id,
			lease_expires_at: this.getLeaseExpiryIso(connection),
		};
	}

	private syncConnectionState(): void {
		const preferred = this.getPreferredConnection();
		this.state.connection_count = this.connections.size;
		this.state.connections = Array.from(this.connections.values())
			.map((connection) => this.buildConnectionState(connection))
			.sort((left, right) =>
				left.connection_id.localeCompare(right.connection_id),
			);
		this.state.controller_connection_id = this.controllerConnectionId;
		this.state.controller_subscription_id = this.getControllerSubscriptionId();
		this.state.client_protocol_version = preferred?.clientProtocolVersion;
		this.state.client_info = preferred?.clientInfo;
		this.state.capabilities = preferred?.capabilities;
		this.state.opt_out_notifications = preferred?.optOutNotifications
			? [...preferred.optOutNotifications]
			: undefined;
		this.state.connection_role = preferred?.role;
	}

	private emitConnectionInfo(connectionId?: string): void {
		this.syncConnectionState();
		const connection =
			this.getConnectionById(connectionId) ?? this.getPreferredConnection();
		if (!connection) {
			return;
		}
		this.publish(
			this.translator.buildConnectionInfoMessage({
				connection_id: connection.id,
				protocol_version: connection.clientProtocolVersion,
				client_info: connection.clientInfo,
				capabilities: connection.capabilities,
				opt_out_notifications: connection.optOutNotifications
					? [...connection.optOutNotifications]
					: undefined,
				role: connection.role,
				connection_count: this.state.connection_count,
				controller_connection_id: this.controllerConnectionId,
				lease_expires_at: this.getLeaseExpiryIso(connection),
				connections: this.state.connections,
			}),
		);
	}

	private getMessageConnectionId(metadata?: {
		connectionId?: string | null;
		subscriptionId?: string | null;
	}): string | undefined {
		const subscriber = metadata?.subscriptionId
			? this.subscribers.get(metadata.subscriptionId)
			: undefined;
		return subscriber?.connectionId ?? metadata?.connectionId ?? undefined;
	}

	private assertUtilityOwnerAccess(
		ownerConnectionId: string | undefined,
		actorConnectionId: string | undefined,
		resourceType: "command" | "file watch",
		resourceId: string,
	): void {
		if (!ownerConnectionId || ownerConnectionId === actorConnectionId) {
			return;
		}
		throw new Error(
			`Headless ${resourceType} ${resourceId} is owned by another connection`,
		);
	}

	private async disposeOwnedUtilitiesForConnection(
		connectionId: string,
	): Promise<void> {
		await this.utilityCommands.disposeOwnedByConnection(
			connectionId,
			"Owning connection closed while utility command was still running",
		);
		this.fileWatches.disposeOwnedByConnection(
			connectionId,
			"Owning connection closed while file watch was still running",
		);
	}

	private async disposeConnection(
		connection: HeadlessConnectionRecord,
		publish: boolean,
	): Promise<void> {
		this.connections.delete(connection.id);
		if (this.controllerConnectionId === connection.id) {
			this.controllerConnectionId = null;
		}
		await this.disposeOwnedUtilitiesForConnection(connection.id);
		this.updatedAt = Date.now();
		this.syncSubscriptionState(publish);
	}

	private ensureConnection(metadata: {
		connectionId?: string;
		role?: HeadlessConnectionRole;
		clientProtocolVersion?: string;
		clientInfo?: HeadlessClientInfo;
		capabilities?: HeadlessClientCapabilities;
		optOutNotifications?: HeadlessNotificationType[];
	}): HeadlessConnectionRecord {
		const role = metadata.role ?? "controller";
		const existing = metadata.connectionId
			? this.connections.get(metadata.connectionId)
			: undefined;
		if (metadata.connectionId && !existing) {
			throw new Error("Headless connection not found");
		}
		const connection =
			existing ??
			({
				id: metadata.connectionId ?? createConnectionId(),
				role,
				clientProtocolVersion:
					metadata.clientProtocolVersion ??
					this.state.client_protocol_version ??
					undefined,
				clientInfo:
					metadata.clientInfo ??
					(this.state.client_info ? { ...this.state.client_info } : undefined),
				capabilities:
					metadata.capabilities ??
					(this.state.capabilities
						? {
								server_requests: this.state.capabilities.server_requests
									? [...this.state.capabilities.server_requests]
									: undefined,
								utility_operations: this.state.capabilities.utility_operations
									? [...this.state.capabilities.utility_operations]
									: undefined,
							}
						: undefined),
				optOutNotifications:
					metadata.optOutNotifications ??
					(this.state.opt_out_notifications
						? [...this.state.opt_out_notifications]
						: undefined),
				subscriptionIds: new Set<string>(),
				lastSeenAt: Date.now(),
			} satisfies HeadlessConnectionRecord);
		if (existing && metadata.role && existing.role !== metadata.role) {
			throw new Error(
				"Headless connection role does not match subscription role",
			);
		}
		connection.clientProtocolVersion =
			metadata.clientProtocolVersion ?? connection.clientProtocolVersion;
		connection.clientInfo = metadata.clientInfo ?? connection.clientInfo;
		connection.capabilities = metadata.capabilities ?? connection.capabilities;
		connection.optOutNotifications = metadata.optOutNotifications
			? [...metadata.optOutNotifications]
			: connection.optOutNotifications;
		connection.lastSeenAt = Date.now();
		this.connections.set(connection.id, connection);
		return connection;
	}

	createSubscription(options?: {
		connectionId?: string;
		role?: HeadlessConnectionRole;
		explicit?: boolean;
		announceConnectionInfo?: boolean;
		takeControl?: boolean;
		optOutNotifications?: HeadlessNotificationType[];
		clientProtocolVersion?: string;
		clientInfo?: HeadlessClientInfo;
		capabilities?: HeadlessClientCapabilities;
	}): HeadlessRuntimeSubscriptionSnapshot {
		const role = options?.role ?? "controller";
		const explicit = options?.explicit ?? true;
		const announceConnectionInfo = options?.announceConnectionInfo ?? true;
		const reusableControllerConnectionId =
			!options?.connectionId &&
			role === "controller" &&
			this.controllerConnectionId &&
			this.connections.get(this.controllerConnectionId)?.subscriptionIds
				.size === 0
				? this.controllerConnectionId
				: undefined;
		const connection = this.ensureConnection({
			connectionId: options?.connectionId ?? reusableControllerConnectionId,
			role,
			clientProtocolVersion: options?.clientProtocolVersion,
			clientInfo: options?.clientInfo,
			capabilities: options?.capabilities,
			optOutNotifications: options?.optOutNotifications,
		});
		if (
			explicit &&
			role === "controller" &&
			this.controllerConnectionId &&
			this.controllerConnectionId !== connection.id &&
			!options?.takeControl
		) {
			throw new Error("Controller lease is already held by another connection");
		}
		const subscriber = new HeadlessSubscriberMailbox(
			createSubscriptionId(),
			role,
			explicit,
			connection.id,
			options?.optOutNotifications ?? connection.optOutNotifications,
		);
		this.subscribers.set(subscriber.id, subscriber);
		connection.subscriptionIds.add(subscriber.id);
		if (explicit && role === "controller") {
			this.controllerConnectionId = connection.id;
		}
		this.updatedAt = Date.now();
		if (announceConnectionInfo) {
			this.emitConnectionInfo(connection.id);
		} else {
			this.syncConnectionState();
		}
		this.syncSubscriptionState(explicit);
		const snapshot: HeadlessRuntimeSubscriptionSnapshot = {
			connection_id: connection.id,
			subscription_id: subscriber.id,
			opt_out_notifications:
				subscriber.optOutNotifications.length > 0
					? [...subscriber.optOutNotifications]
					: undefined,
			role,
			controller_lease_granted:
				role === "controller" && this.controllerConnectionId === connection.id,
			controller_subscription_id: this.getControllerSubscriptionId(),
			controller_connection_id: this.controllerConnectionId,
			lease_expires_at: this.getLeaseExpiryIso(connection),
			heartbeat_interval_ms: CONNECTION_HEARTBEAT_INTERVAL_MS,
			snapshot: this.getSnapshot(),
		};
		assertHeadlessRuntimeSubscriptionSnapshot(
			snapshot,
			"headless runtime subscription snapshot",
		);
		return snapshot;
	}

	attachSubscription(
		subscriptionId: string,
	): HeadlessAttachedSubscription | null {
		const subscriber = this.subscribers.get(subscriptionId);
		if (!subscriber) {
			return null;
		}
		this.updatedAt = Date.now();
		this.touchConnection(subscriber.connectionId);
		subscriber.attach();
		this.syncSubscriptionState(false);
		return {
			id: subscriber.id,
			next: () => subscriber.next(),
			onAvailable: (listener) => subscriber.onAvailable(listener),
			enqueue: (envelope) => {
				assertHeadlessRuntimeStreamEnvelope(
					envelope,
					"headless attached subscription envelope",
				);
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
		optOutNotifications?: HeadlessNotificationType[];
	}): HeadlessAttachedSubscription {
		const created = this.createSubscription({
			role: options.role ?? "controller",
			explicit: false,
			announceConnectionInfo: false,
			optOutNotifications: options.optOutNotifications,
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
				void this.unsubscribe(created.subscription_id, false);
			},
		};
	}

	async unsubscribe(subscriptionId: string, publish = true): Promise<boolean> {
		const subscriber = this.subscribers.get(subscriptionId);
		if (!subscriber) {
			return false;
		}
		subscriber.detach();
		this.subscribers.delete(subscriptionId);
		const connection = this.connections.get(subscriber.connectionId);
		connection?.subscriptionIds.delete(subscriptionId);
		if (connection && connection.subscriptionIds.size === 0) {
			await this.disposeConnection(connection, publish && subscriber.explicit);
			return true;
		}
		this.updatedAt = Date.now();
		this.syncSubscriptionState(publish && subscriber.explicit);
		return true;
	}

	assertCanSend(
		role: "viewer" | "controller",
		subscriptionId?: string | null,
		connectionId?: string | null,
	): void {
		if (role === "viewer") {
			throw new Error("Viewer headless connections cannot send messages");
		}
		const subscriber = subscriptionId
			? this.subscribers.get(subscriptionId)
			: undefined;
		const connection = subscriber
			? this.connections.get(subscriber.connectionId)
			: this.getConnectionById(connectionId);
		if (!subscriptionId && !connection) {
			if (this.controllerConnectionId) {
				throw new Error(
					"Controller lease is currently held by another connection",
				);
			}
			return;
		}
		if (subscriptionId && !subscriber) {
			throw new Error("Headless subscriber not found");
		}
		if (!connection) {
			throw new Error("Headless connection not found");
		}
		if (subscriber && subscriber.role !== "controller") {
			throw new Error("Headless subscriber does not have controller access");
		}
		if (connection.role !== "controller") {
			throw new Error("Headless connection does not have controller access");
		}
		if (
			this.controllerConnectionId &&
			this.controllerConnectionId !== connection.id
		) {
			throw new Error(
				"Controller lease is currently held by another connection",
			);
		}
		if (!this.controllerConnectionId) {
			this.controllerConnectionId = connection.id;
			this.emitConnectionInfo(connection.id);
			this.syncSubscriptionState(true);
		}
		this.touchConnection(connection.id);
		subscriber?.touch();
	}

	hasSubscription(subscriptionId: string): boolean {
		return this.subscribers.has(subscriptionId);
	}

	async expireIdleSubscriptions(now = Date.now()): Promise<void> {
		for (const [subscriptionId, subscriber] of Array.from(
			this.subscribers.entries(),
		)) {
			if (!subscriber.isExpired(now)) {
				continue;
			}
			await this.unsubscribe(subscriptionId, subscriber.explicit);
		}
	}

	async expireIdleConnections(now = Date.now()): Promise<void> {
		for (const [connectionId, connection] of Array.from(
			this.connections.entries(),
		)) {
			const hasAttachedSubscription = Array.from(
				connection.subscriptionIds,
			).some((subscriptionId) =>
				this.subscribers.get(subscriptionId)?.isAttached(),
			);
			if (hasAttachedSubscription) {
				continue;
			}
			if (now - connection.lastSeenAt <= MAX_CONNECTION_IDLE_MS) {
				continue;
			}
			for (const subscriptionId of Array.from(connection.subscriptionIds)) {
				await this.unsubscribe(subscriptionId, false);
			}
			const remaining = this.connections.get(connectionId);
			if (remaining && remaining.subscriptionIds.size === 0) {
				await this.disposeConnection(remaining, false);
			}
			this.syncSubscriptionState(true);
		}
	}

	heartbeat(): HeadlessRuntimeHeartbeatEnvelope {
		const envelope: HeadlessRuntimeHeartbeatEnvelope = {
			type: "heartbeat",
			cursor: this.broker.currentCursor(),
		};
		assertHeadlessRuntimeStreamEnvelope(
			envelope,
			"headless runtime heartbeat envelope",
		);
		return envelope;
	}

	heartbeatConnection(input: {
		connectionId?: string | null;
		subscriptionId?: string | null;
	}): HeadlessRuntimeHeartbeatSnapshot {
		const subscriber = input.subscriptionId
			? this.subscribers.get(input.subscriptionId)
			: undefined;
		const connection = subscriber
			? this.connections.get(subscriber.connectionId)
			: this.getConnectionById(input.connectionId);
		if (!connection) {
			throw new Error("Headless connection not found");
		}
		this.touchConnection(connection.id);
		this.syncSubscriptionState(false);
		const snapshot: HeadlessRuntimeHeartbeatSnapshot = {
			connection_id: connection.id,
			controller_lease_granted: this.controllerConnectionId === connection.id,
			controller_connection_id: this.controllerConnectionId,
			lease_expires_at: this.getLeaseExpiryIso(connection),
			heartbeat_interval_ms: CONNECTION_HEARTBEAT_INTERVAL_MS,
		};
		assertHeadlessRuntimeHeartbeatSnapshot(
			snapshot,
			"headless runtime heartbeat snapshot",
		);
		return snapshot;
	}

	registerConnection(metadata: {
		connectionId?: string;
		clientProtocolVersion?: string;
		clientInfo?: HeadlessClientInfo;
		capabilities?: HeadlessClientCapabilities;
		optOutNotifications?: HeadlessNotificationType[];
		role?: HeadlessConnectionRole;
		takeControl?: boolean;
	}): HeadlessRuntimeHeartbeatSnapshot {
		const role = metadata.role ?? "controller";
		const connection = this.ensureConnection({
			connectionId: metadata.connectionId,
			role,
			clientProtocolVersion: metadata.clientProtocolVersion,
			clientInfo: metadata.clientInfo,
			capabilities: metadata.capabilities,
			optOutNotifications: metadata.optOutNotifications,
		});
		if (
			role === "controller" &&
			this.controllerConnectionId &&
			this.controllerConnectionId !== connection.id &&
			!metadata.takeControl
		) {
			throw new Error("Controller lease is already held by another connection");
		}
		if (role === "controller") {
			this.controllerConnectionId = connection.id;
		}
		this.emitConnectionInfo(connection.id);
		this.syncSubscriptionState(false);
		const snapshot: HeadlessRuntimeHeartbeatSnapshot = {
			connection_id: connection.id,
			controller_lease_granted: this.controllerConnectionId === connection.id,
			controller_connection_id: this.controllerConnectionId,
			lease_expires_at: this.getLeaseExpiryIso(connection),
			heartbeat_interval_ms: CONNECTION_HEARTBEAT_INTERVAL_MS,
		};
		assertHeadlessRuntimeHeartbeatSnapshot(
			snapshot,
			"headless runtime connection registration snapshot",
		);
		return snapshot;
	}

	updateConnectionMetadata(metadata: {
		connectionId?: string;
		clientProtocolVersion?: string;
		clientInfo?: HeadlessClientInfo;
		capabilities?: HeadlessClientCapabilities;
		optOutNotifications?: HeadlessNotificationType[];
		role?: "viewer" | "controller";
	}): void {
		if (
			!metadata.clientProtocolVersion &&
			!metadata.clientInfo &&
			!metadata.capabilities &&
			!metadata.optOutNotifications &&
			!metadata.role
		) {
			return;
		}
		const connection = this.ensureConnection({
			connectionId: metadata.connectionId,
			role: metadata.role,
			clientProtocolVersion: metadata.clientProtocolVersion,
			clientInfo: metadata.clientInfo,
			capabilities: metadata.capabilities,
			optOutNotifications: metadata.optOutNotifications,
		});
		this.emitConnectionInfo(connection.id);
	}

	async send(
		msg: HeadlessToAgentMessage,
		metadata?: {
			connectionId?: string | null;
			subscriptionId?: string | null;
		},
	): Promise<void> {
		if (this.disposed) {
			throw new Error("Headless runtime is no longer available");
		}
		this.updatedAt = Date.now();

		switch (msg.type) {
			case "hello": {
				applyOutgoingHeadlessMessage(this.state, msg);
				const subscriber = metadata?.subscriptionId
					? this.subscribers.get(metadata.subscriptionId)
					: undefined;
				this.updateConnectionMetadata({
					connectionId:
						subscriber?.connectionId ?? metadata?.connectionId ?? undefined,
					clientProtocolVersion: msg.protocol_version,
					clientInfo: msg.client_info,
					capabilities: msg.capabilities,
					optOutNotifications: msg.opt_out_notifications,
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
				await this.utilityCommands.dispose(
					msg.type === "interrupt"
						? "Interrupted while utility command was still running"
						: "Cancelled while utility command was still running",
				);
				this.fileWatches.dispose(
					msg.type === "interrupt"
						? "Interrupted while file watch was still running"
						: "Cancelled while file watch was still running",
				);
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
				await this.utilityCommands.dispose(
					"Headless runtime shutdown while utility command was still running",
				);
				this.fileWatches.dispose(
					"Headless runtime shutdown while file watch was still running",
				);
				this.agent.abort();
				this.disposed = true;
				this.unsubscribeServerRequestEvents();
				this.publishSnapshot();
				return;
			case "utility_command_start":
				if (
					!this.state.capabilities?.utility_operations?.includes("command_exec")
				) {
					throw new Error(
						"utility_command_start requires command_exec capability",
					);
				}
				await this.utilityCommands.start({
					command_id: msg.command_id,
					command: msg.command,
					cwd: msg.cwd,
					env: msg.env,
					shell_mode: msg.shell_mode,
					terminal_mode: msg.terminal_mode,
					allow_stdin: msg.allow_stdin,
					columns: msg.columns,
					rows: msg.rows,
					owner_connection_id: this.getMessageConnectionId(metadata),
				});
				return;
			case "utility_command_terminate":
				this.assertUtilityOwnerAccess(
					this.utilityCommands.get(msg.command_id)?.owner_connection_id,
					this.getMessageConnectionId(metadata),
					"command",
					msg.command_id,
				);
				await this.utilityCommands.terminate(msg.command_id, msg.force);
				return;
			case "utility_command_stdin":
				if (
					!this.state.capabilities?.utility_operations?.includes("command_exec")
				) {
					throw new Error(
						"utility_command_stdin requires command_exec capability",
					);
				}
				this.assertUtilityOwnerAccess(
					this.utilityCommands.get(msg.command_id)?.owner_connection_id,
					this.getMessageConnectionId(metadata),
					"command",
					msg.command_id,
				);
				await this.utilityCommands.writeStdin(
					msg.command_id,
					msg.content,
					msg.eof,
				);
				return;
			case "utility_command_resize":
				if (
					!this.state.capabilities?.utility_operations?.includes("command_exec")
				) {
					throw new Error(
						"utility_command_resize requires command_exec capability",
					);
				}
				this.assertUtilityOwnerAccess(
					this.utilityCommands.get(msg.command_id)?.owner_connection_id,
					this.getMessageConnectionId(metadata),
					"command",
					msg.command_id,
				);
				await this.utilityCommands.resize(
					msg.command_id,
					msg.columns,
					msg.rows,
				);
				return;
			case "utility_file_search":
				if (
					!this.state.capabilities?.utility_operations?.includes("file_search")
				) {
					throw new Error(
						"utility_file_search requires file_search capability",
					);
				}
				{
					const result = searchWorkspaceFiles({
						query: msg.query,
						cwd: msg.cwd,
						limit: msg.limit,
					});
					this.publish({
						type: "utility_file_search_results",
						search_id: msg.search_id,
						query: result.query,
						cwd: result.cwd,
						results: result.results,
						truncated: result.truncated,
					});
				}
				return;
			case "utility_file_watch_start":
				if (
					!this.state.capabilities?.utility_operations?.includes("file_watch")
				) {
					throw new Error(
						"utility_file_watch_start requires file_watch capability",
					);
				}
				await this.fileWatches.start({
					watch_id: msg.watch_id,
					root_dir: msg.root_dir,
					include_patterns: msg.include_patterns,
					exclude_patterns: msg.exclude_patterns,
					debounce_ms: msg.debounce_ms,
					owner_connection_id: this.getMessageConnectionId(metadata),
				});
				return;
			case "utility_file_watch_stop":
				this.assertUtilityOwnerAccess(
					this.fileWatches.get(msg.watch_id)?.owner_connection_id,
					this.getMessageConnectionId(metadata),
					"file watch",
					msg.watch_id,
				);
				this.fileWatches.stop(msg.watch_id, "Stopped by controller");
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
		assertHeadlessFromAgentMessage(message, "headless runtime message");
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
			event.type === "action_approval_required" &&
			!this.approvalService.requiresUserInteraction()
		) {
			return;
		}
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
		this.syncConnectionState();
		this.state.subscriber_count = this.subscribers.size;
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

export type EnsureRuntimeOptions = {
	scope_key: string;
	sessionId?: string;
	subject?: string;
	clientProtocolVersion?: string;
	clientInfo?: HeadlessClientInfo;
	capabilities?: HeadlessClientCapabilities;
	optOutNotifications?: HeadlessNotificationType[];
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
		setInterval(() => {
			void this.cleanup();
		}, 60 * 1000).unref();
	}

	async ensureRuntime(
		options: EnsureRuntimeOptions,
	): Promise<HeadlessSessionRuntime> {
		if (options.sessionId) {
			const existing = this.getRuntime(options.scope_key, options.sessionId);
			if (existing) {
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
		if (
			options.clientProtocolVersion ||
			options.clientInfo ||
			options.capabilities ||
			options.optOutNotifications ||
			options.role
		) {
			runtime.registerConnection({
				clientProtocolVersion: options.clientProtocolVersion,
				clientInfo: options.clientInfo,
				capabilities: options.capabilities,
				optOutNotifications: options.optOutNotifications,
				role: options.role,
			});
		}
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

	private async cleanup(): Promise<void> {
		const now = Date.now();
		for (const [key, runtime] of this.runtimes.entries()) {
			await runtime.expireIdleSubscriptions(now);
			await runtime.expireIdleConnections(now);
			if (runtime.isDisposed() || runtime.isIdle(now)) {
				await runtime.dispose();
				this.runtimes.delete(key);
			}
		}
	}
}
