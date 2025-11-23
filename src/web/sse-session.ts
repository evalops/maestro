import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentEvent } from "../agent/types.js";

export interface SseContext {
	sessionId?: string;
	modelKey?: string;
	requestId?: string;
}

export type SseSkipListener = (metrics: {
	sent: number;
	skipped: number;
	lastError?: unknown;
	context?: SseContext;
}) => void;

type SseResponse = Pick<
	ServerResponse<IncomingMessage>,
	"write" | "end" | "writable" | "writableEnded" | "destroyed"
> & {
	flushHeaders?: () => void;
};

export class SseSession {
	private closed = false;
	private heartbeat?: NodeJS.Timeout;
	private skippedWrites = 0;
	private sentWrites = 0;
	private lastError?: unknown;
	private context: SseContext = {};
	constructor(
		private readonly res: SseResponse,
		private readonly onSkip?: SseSkipListener,
		context?: SseContext,
		private readonly heartbeatMs = 15_000,
	) {
		if (context) {
			this.context = context;
		}
		if (typeof res.flushHeaders === "function") {
			try {
				res.flushHeaders();
			} catch {
				// Ignore flush errors; writes are still guarded
			}
		}
	}

	private canWrite(): boolean {
		return (
			!!this.res &&
			this.res.writable !== false &&
			!this.res.writableEnded &&
			!this.res.destroyed
		);
	}

	private write(payload: string): boolean {
		if (!this.canWrite()) {
			this.skippedWrites++;
			this.notifySkip();
			return false;
		}
		try {
			this.res.write(payload);
			this.sentWrites++;
			return true;
		} catch (error) {
			this.skippedWrites++;
			this.lastError = error;
			this.notifySkip();
			return false;
		}
	}

	sendEvent(event: AgentEvent): void {
		const data = JSON.stringify(event);
		this.write(`data: ${data}\n\n`);
	}

	sendSessionUpdate(sessionId: string): void {
		const payload = { type: "session_update", sessionId };
		this.write(`data: ${JSON.stringify(payload)}\n\n`);
	}

	sendHeartbeat(): void {
		this.write('data: {"type":"heartbeat"}\n\n');
	}

	sendAborted(): void {
		this.write('data: {"type":"aborted"}\n\n');
	}

	sendDone(): void {
		this.write("data: [DONE]\n\n");
	}

	startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeat = setInterval(() => this.sendHeartbeat(), this.heartbeatMs);
	}

	stopHeartbeat(): void {
		if (this.heartbeat) {
			clearInterval(this.heartbeat);
			this.heartbeat = undefined;
		}
	}

	end(): void {
		if (this.closed) return;
		this.closed = true;
		this.stopHeartbeat();
		if (!this.canWrite()) {
			return;
		}
		try {
			this.res.end();
		} catch (error) {
			this.skippedWrites++;
			this.lastError = error;
			this.notifySkip();
		}
	}

	getMetrics(): { sent: number; skipped: number; lastError?: unknown } {
		return {
			sent: this.sentWrites,
			skipped: this.skippedWrites,
			lastError: this.lastError,
		};
	}

	setContext(context: SseContext): void {
		this.context = { ...this.context, ...context };
	}

	private notifySkip(): void {
		if (this.skippedWrites <= 1) return;
		if (this.onSkip) {
			this.onSkip({
				sent: this.sentWrites,
				skipped: this.skippedWrites,
				lastError: this.lastError,
				context: this.context,
			});
		}
	}
}

export function sendSSE(session: SseSession, event: AgentEvent) {
	session.sendEvent(event);
}

export function sendSessionUpdate(session: SseSession, sessionId: string) {
	session.sendSessionUpdate(sessionId);
}
