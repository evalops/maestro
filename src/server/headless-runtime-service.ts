import type {
	ActionApprovalService,
	ApprovalMode,
} from "../agent/action-approval.js";
import type { Agent } from "../agent/index.js";
import type { AgentEvent, Attachment, ThinkingLevel } from "../agent/types.js";
import {
	HEADLESS_PROTOCOL_VERSION,
	type HeadlessFromAgentMessage,
	type HeadlessInitMessage,
	HeadlessProtocolTranslator,
	type HeadlessRuntimeState,
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

const logger = createLogger("server:headless-runtime");

const MAX_BUFFERED_EVENTS =
	Number.parseInt(
		process.env.MAESTRO_HEADLESS_RUNTIME_EVENT_BUFFER || "",
		10,
	) || 512;
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

type RuntimeListener = (envelope: HeadlessRuntimeEventEnvelope) => void;

class HeadlessRuntimeBroker {
	private nextCursor = 1;
	private readonly listeners = new Set<RuntimeListener>();
	private readonly events: HeadlessRuntimeEventEnvelope[] = [];

	publish(message: HeadlessFromAgentMessage): HeadlessRuntimeEventEnvelope {
		const envelope: HeadlessRuntimeEventEnvelope = {
			type: "message",
			cursor: this.nextCursor++,
			message,
		};
		this.events.push(envelope);
		while (this.events.length > MAX_BUFFERED_EVENTS) {
			this.events.shift();
		}
		for (const listener of this.listeners) {
			listener(envelope);
		}
		return envelope;
	}

	currentCursor(): number {
		return this.nextCursor - 1;
	}

	replayFrom(cursor: number): HeadlessRuntimeEventEnvelope[] | null {
		if (this.events.length === 0) {
			return [];
		}
		const earliest = this.events[0]?.cursor ?? this.nextCursor;
		if (cursor < earliest - 1) {
			return null;
		}
		return this.events.filter((event) => event.cursor > cursor);
	}

	subscribe(listener: RuntimeListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
}

type RuntimeOptions = {
	scope_key: string;
	session_id: string;
	subject?: string;
	registeredModel: RegisteredModel;
	thinkingLevel: ThinkingLevel;
	approvalMode: ApprovalMode;
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
	}

	static async create(
		options: RuntimeOptions,
	): Promise<HeadlessSessionRuntime> {
		const approvalService = new WebActionApprovalService(options.approvalMode);
		const agent = await options.context.createAgent(
			options.registeredModel,
			options.thinkingLevel,
			options.approvalMode,
			{
				approvalService,
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
		return !this.running && now - this.updatedAt > MAX_IDLE_MS;
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.running = false;
		this.agent.abort();
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

	replayFrom(cursor: number): HeadlessRuntimeEventEnvelope[] | null {
		return this.broker.replayFrom(cursor);
	}

	subscribe(listener: RuntimeListener): () => void {
		this.updatedAt = Date.now();
		return this.broker.subscribe(listener);
	}

	heartbeat(): HeadlessRuntimeHeartbeatEnvelope {
		return {
			type: "heartbeat",
			cursor: this.broker.currentCursor(),
		};
	}

	async send(msg: HeadlessToAgentMessage): Promise<void> {
		if (this.disposed) {
			throw new Error("Headless runtime is no longer available");
		}
		this.updatedAt = Date.now();

		switch (msg.type) {
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
				applyOutgoingHeadlessMessage(this.state, msg);
				this.agent.abort();
				return;
			case "tool_response":
				if (msg.approved) {
					const resolved = this.approvalService.approve(msg.call_id);
					if (!resolved) {
						throw new Error(
							`No pending approval found for call_id: ${msg.call_id}`,
						);
					}
				} else {
					const reason = msg.result?.error ?? "Denied by user";
					const resolved = this.approvalService.deny(msg.call_id, reason);
					if (!resolved) {
						throw new Error(
							`No pending approval found for call_id: ${msg.call_id}`,
						);
					}
				}
				applyOutgoingHeadlessMessage(this.state, msg);
				return;
			case "shutdown":
				applyOutgoingHeadlessMessage(this.state, msg);
				this.agent.abort();
				this.disposed = true;
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
			this.running = false;
			this.updatedAt = Date.now();
		}
	}

	private publish(message: HeadlessFromAgentMessage): void {
		applyIncomingHeadlessMessage(this.state, message);
		this.updatedAt = Date.now();
		this.broker.publish(message);
	}

	private handleAgentEvent(event: AgentEvent): void {
		for (const message of this.translator.handleAgentEvent(event)) {
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
}

type EnsureRuntimeOptions = {
	scope_key: string;
	sessionId?: string;
	subject?: string;
	registeredModel: RegisteredModel;
	thinkingLevel: ThinkingLevel;
	approvalMode: ApprovalMode;
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
				return existing;
			}
		}

		const sessionId = options.sessionManager.getSessionId();
		const runtime = await HeadlessSessionRuntime.create({
			scope_key: options.scope_key,
			session_id: sessionId,
			subject: options.subject,
			registeredModel: options.registeredModel,
			thinkingLevel: options.thinkingLevel,
			approvalMode: options.approvalMode,
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
			if (runtime.isDisposed() || runtime.isIdle(now)) {
				runtime.dispose();
				this.runtimes.delete(key);
			}
		}
	}
}
