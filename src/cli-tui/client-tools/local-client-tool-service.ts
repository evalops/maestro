import type { ClientToolExecutionService } from "../../agent/transport.js";
import type { ImageContent, TextContent } from "../../agent/types.js";

type ToolResultContent = TextContent | ImageContent;

export interface TuiPendingClientToolRequest {
	id: string;
	toolName: string;
	args: Record<string, unknown>;
	timestamp: number;
}

export type TuiClientToolLifecycleEvent =
	| {
			type: "registered";
			request: TuiPendingClientToolRequest;
	  }
	| {
			type: "resolved";
			request: TuiPendingClientToolRequest;
			content: ToolResultContent[];
			isError: boolean;
	  };

type PendingEntry = {
	request: TuiPendingClientToolRequest;
	resolve: (result: { content: ToolResultContent[]; isError: boolean }) => void;
};

function getAbortResult(): {
	content: ToolResultContent[];
	isError: boolean;
} {
	return {
		content: [{ type: "text", text: "Aborted" }],
		isError: true,
	};
}

export class TuiClientToolService implements ClientToolExecutionService {
	private readonly listeners = new Set<
		(event: TuiClientToolLifecycleEvent) => void
	>();
	private readonly pending = new Map<string, PendingEntry>();

	subscribe(
		listener: (event: TuiClientToolLifecycleEvent) => void,
	): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getPendingRequests(): TuiPendingClientToolRequest[] {
		return [...this.pending.values()].map((entry) => entry.request);
	}

	async requestExecution(
		id: string,
		toolName: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{ content: ToolResultContent[]; isError: boolean }> {
		if (signal?.aborted) {
			return getAbortResult();
		}

		return new Promise((resolve) => {
			let settled = false;
			let onAbort: (() => void) | undefined;
			const request: TuiPendingClientToolRequest = {
				id,
				toolName,
				args,
				timestamp: Date.now(),
			};
			const safeResolve = (result: {
				content: ToolResultContent[];
				isError: boolean;
			}) => {
				if (settled) {
					return;
				}
				settled = true;
				this.pending.delete(id);
				if (signal && onAbort) {
					signal.removeEventListener("abort", onAbort);
				}
				this.emit({
					type: "resolved",
					request,
					content: result.content,
					isError: result.isError,
				});
				resolve(result);
			};

			if (signal) {
				onAbort = () => {
					safeResolve(getAbortResult());
				};
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) {
					safeResolve(getAbortResult());
					return;
				}
			}

			this.pending.set(id, {
				request,
				resolve: safeResolve,
			});
			this.emit({
				type: "registered",
				request,
			});
		});
	}

	resolve(id: string, content: ToolResultContent[], isError: boolean): boolean {
		const entry = this.pending.get(id);
		if (!entry) {
			return false;
		}
		entry.resolve({ content, isError });
		return true;
	}

	cancel(id: string, reason: string): boolean {
		return this.resolve(id, [{ type: "text", text: reason }], true);
	}

	private emit(event: TuiClientToolLifecycleEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// Ignore listener failures so a broken UI subscriber cannot wedge
				// client tool execution.
			}
		}
	}
}
