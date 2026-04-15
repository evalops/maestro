import type { SandboxRuntimeProvider } from "./sandbox-runtime-provider.js";

export interface MessageConsumer {
	handleMessage(message: unknown): Promise<void>;
}

interface SandboxContext {
	sandboxId: string;
	iframe: HTMLIFrameElement | null;
	providers: SandboxRuntimeProvider[];
	consumers: Set<MessageConsumer>;
}

export class RuntimeMessageRouter {
	private sandboxes = new Map<string, SandboxContext>();
	private listener: ((e: MessageEvent) => void) | null = null;

	registerSandbox(
		sandboxId: string,
		providers: SandboxRuntimeProvider[],
		consumers: MessageConsumer[] = [],
	): void {
		const existing = this.sandboxes.get(sandboxId);
		if (existing) {
			existing.providers = providers;
			existing.consumers = new Set(consumers);
		} else {
			this.sandboxes.set(sandboxId, {
				sandboxId,
				iframe: null,
				providers,
				consumers: new Set(consumers),
			});
		}

		this.ensureListener();
	}

	setSandboxIframe(sandboxId: string, iframe: HTMLIFrameElement): void {
		const ctx = this.sandboxes.get(sandboxId);
		if (!ctx) return;
		ctx.iframe = iframe;
	}

	unregisterSandbox(sandboxId: string): void {
		this.sandboxes.delete(sandboxId);
		if (this.sandboxes.size === 0 && this.listener) {
			window.removeEventListener("message", this.listener);
			this.listener = null;
		}
	}

	addConsumer(sandboxId: string, consumer: MessageConsumer): void {
		const ctx = this.sandboxes.get(sandboxId);
		if (!ctx) return;
		ctx.consumers.add(consumer);
	}

	private ensureListener(): void {
		if (this.listener) return;

		this.listener = async (e: MessageEvent) => {
			const data = e.data as {
				sandboxId?: unknown;
				messageId?: unknown;
			} | null;
			const sandboxId = data?.sandboxId;
			if (typeof sandboxId !== "string" || sandboxId.length === 0) return;

			const ctx = this.sandboxes.get(sandboxId);
			if (!ctx) return;

			// Require the iframe binding before accepting any messages to avoid
			// spoofing by other windows that guess a sandboxId.
			if (!ctx.iframe?.contentWindow) {
				return;
			}
			if (e.source !== ctx.iframe.contentWindow) return;

			const messageId =
				typeof data?.messageId === "string" ? data.messageId : null;

			const respond = (response: unknown) => {
				if (!messageId) return;
				ctx.iframe?.contentWindow?.postMessage(
					{
						type: "runtime-response",
						sandboxId,
						messageId,
						response,
					},
					"*",
				);
			};

			for (const provider of ctx.providers) {
				if (provider.handleMessage) {
					try {
						await provider.handleMessage(e.data, respond);
					} catch (error) {
						console.warn("Sandbox provider error", error);
					}
				}
			}

			for (const consumer of ctx.consumers) {
				try {
					await consumer.handleMessage(e.data);
				} catch (error) {
					console.warn("Sandbox consumer error", error);
				}
			}
		};

		window.addEventListener("message", this.listener);
	}
}

export const RUNTIME_MESSAGE_ROUTER = new RuntimeMessageRouter();
