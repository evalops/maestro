import {
	type HeadlessNotificationType,
	assertHeadlessFromAgentMessage,
	assertHeadlessRuntimeStreamEnvelope,
} from "@evalops/contracts";
import type {
	HeadlessFromAgentMessage,
	HeadlessInitMessage,
	HeadlessRuntimeState,
} from "../../cli/headless-protocol.js";

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
	reason: "lagged" | "replay_gap" | "restored_from_snapshot";
	snapshot: HeadlessRuntimeSnapshot;
}

export type HeadlessRuntimeStreamEnvelope =
	| HeadlessRuntimeSnapshotEnvelope
	| HeadlessRuntimeEventEnvelope
	| HeadlessRuntimeHeartbeatEnvelope
	| HeadlessRuntimeResetEnvelope;

export type RuntimeListener = (envelope: HeadlessRuntimeStreamEnvelope) => void;
export type SubscriberListener = () => void;

export interface HeadlessAttachedSubscription {
	id: string;
	next(): HeadlessRuntimeStreamEnvelope | null;
	onAvailable(listener: SubscriberListener): () => void;
	enqueue(envelope: HeadlessRuntimeStreamEnvelope): void;
	close(): void;
}

export function createConnectionId(): string {
	return `conn_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createSubscriptionId(): string {
	return `sub_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export class HeadlessSubscriberMailbox {
	private readonly listeners = new Set<SubscriberListener>();
	private readonly queue: HeadlessRuntimeStreamEnvelope[] = [];
	private queuedReset: HeadlessRuntimeResetEnvelope | null = null;
	private detachedAt: number | null;
	private attached = false;
	private allowRawAgentEvents: boolean;

	constructor(
		readonly id: string,
		readonly role: "viewer" | "controller",
		readonly explicit: boolean,
		readonly connectionId: string,
		readonly optOutNotifications: HeadlessNotificationType[] = [],
		allowRawAgentEvents = false,
	) {
		this.detachedAt = explicit ? Date.now() : null;
		this.allowRawAgentEvents = allowRawAgentEvents;
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

	allowsRawAgentEvents(): boolean {
		return this.allowRawAgentEvents;
	}

	setAllowRawAgentEvents(value: boolean): void {
		this.allowRawAgentEvents = value;
	}

	private emit(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	private shouldFilterEnvelope(
		envelope: HeadlessRuntimeStreamEnvelope,
	): boolean {
		if (envelope.type === "heartbeat") {
			return this.optOutNotifications.includes("heartbeat");
		}
		if (envelope.type !== "message") {
			return false;
		}
		if (
			envelope.message.type === "raw_agent_event" &&
			!this.allowRawAgentEvents
		) {
			return true;
		}
		if (this.optOutNotifications.length === 0) {
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

export class HeadlessRuntimeBroker {
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
		const envelope = this.createMessageEnvelope(message);
		return this.publishEnvelope(envelope) as HeadlessRuntimeEventEnvelope;
	}

	createPrivateMessage(
		message: HeadlessFromAgentMessage,
	): HeadlessRuntimeEventEnvelope {
		return this.createMessageEnvelope(message);
	}

	private createMessageEnvelope(
		message: HeadlessFromAgentMessage,
	): HeadlessRuntimeEventEnvelope {
		assertHeadlessFromAgentMessage(message, "headless runtime message");
		const envelope: HeadlessRuntimeEventEnvelope = {
			type: "message",
			cursor: this.nextCursor++,
			message,
		};
		return envelope;
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

	restoreFromSnapshot(snapshot: HeadlessRuntimeSnapshot): void {
		const envelope: HeadlessRuntimeResetEnvelope = {
			type: "reset",
			reason: "restored_from_snapshot",
			snapshot,
		};
		assertHeadlessRuntimeStreamEnvelope(
			envelope,
			"headless runtime restore envelope",
		);
		this.events.length = 0;
		this.events.push(envelope);
		this.nextCursor = Math.max(1, snapshot.cursor + 1);
	}

	replayFrom(cursor: number): HeadlessRuntimeStreamEnvelope[] | null {
		if (this.events.length === 0) {
			return [];
		}
		const first = this.events[0];
		const earliest = this.getEnvelopeCursor(first) ?? this.nextCursor;
		if (cursor < earliest - 1) {
			if (
				first?.type === "reset" &&
				first.reason === "restored_from_snapshot"
			) {
				return [...this.events];
			}
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
