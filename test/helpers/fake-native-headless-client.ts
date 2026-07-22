import { EventEmitter } from "node:events";

import type { AgentEvent, ThinkingLevel } from "../../src/agent/types.js";
import {
	HEADLESS_PROTOCOL_VERSION,
	HeadlessProtocolTranslator,
	type HeadlessToAgentMessage,
} from "../../src/cli/headless-protocol.js";

export interface FakeNativeAgentAdapter {
	subscribe(listener: (event: AgentEvent) => void): () => void;
	setSystemPrompt?(value: string): void;
	setThinkingLevel?(level: ThinkingLevel): void;
	prompt(content: string, attachments?: string[]): void | Promise<void>;
	abort(): void;
}

/** Test-only native protocol client backed by a controllable fake event source. */
export class FakeNativeHeadlessClient extends EventEmitter {
	private readonly translator = new HeadlessProtocolTranslator();
	private unsubscribe: (() => void) | null = null;
	private readonly requestStartTimes = new Map<string, number>();
	readonly sent: HeadlessToAgentMessage[] = [];

	constructor(private readonly agent: FakeNativeAgentAdapter) {
		super();
	}

	async start() {
		this.unsubscribe = this.agent.subscribe((event) => {
			for (const message of this.translator.handleAgentEvent(event)) {
				if (message.type === "server_request") {
					this.requestStartTimes.set(message.request_id, message.started_at_ms);
				}
				this.emit("message", message);
			}
		});
		return {
			type: "ready" as const,
			protocol_version: HEADLESS_PROTOCOL_VERSION,
			model: "test-model",
			provider: "test-provider",
			session_id: null,
		};
	}

	hello() {}

	init(options: {
		system_prompt?: string;
		thinking_level?: ThinkingLevel;
	}) {
		if (options.system_prompt !== undefined) {
			this.agent.setSystemPrompt?.(options.system_prompt);
		}
		if (options.thinking_level) {
			this.agent.setThinkingLevel?.(options.thinking_level);
		}
	}

	prompt(content: string, attachments?: string[]) {
		void this.agent.prompt(content, attachments);
	}

	send(message: HeadlessToAgentMessage) {
		this.sent.push(message);
		if (message.type === "server_request_response") {
			const approved = message.approved === true;
			this.emit("message", {
				type: "server_request_resolved",
				request_id: message.request_id,
				request_type: message.request_type,
				call_id: message.request_id,
				resolution: approved ? "approved" : "denied",
				reason:
					typeof message.result?.error === "string"
						? message.result.error
						: typeof message.result?.output === "string"
							? message.result.output
							: undefined,
				resolved_by: "user",
				started_at_ms:
					this.requestStartTimes.get(message.request_id) ?? Date.now(),
				resolved_at_ms: Date.now(),
			});
		}
	}

	emitMessage(message: Record<string, unknown>) {
		this.emit("message", message);
	}

	interrupt() {
		this.agent.abort();
	}

	cancel() {
		this.agent.abort();
	}

	stop() {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}
}
