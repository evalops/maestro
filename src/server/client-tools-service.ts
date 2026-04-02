import type { ImageContent, TextContent } from "../agent/types.js";
import { serverRequestManager } from "./server-request-manager.js";

/** Content types that can be returned from client tool execution */
type ToolResultContent = TextContent | ImageContent;

type PendingEntry = {
	resolve: (result: { content: ToolResultContent[]; isError: boolean }) => void;
	timestamp: number;
};

export class ClientToolService {
	private pending = new Map<string, PendingEntry>();

	async requestExecution(
		id: string,
		toolName: string,
		args: unknown,
		signal?: AbortSignal,
		sessionId?: string,
	): Promise<{ content: ToolResultContent[]; isError: boolean }> {
		if (signal?.aborted) {
			return {
				content: [{ type: "text", text: "Aborted" } as TextContent],
				isError: true,
			};
		}

		return new Promise((resolve) => {
			// Track if we've already resolved to guard against race conditions
			let resolved = false;

			const safeResolve = (result: {
				content: ToolResultContent[];
				isError: boolean;
			}) => {
				if (resolved) return;
				resolved = true;
				this.pending.delete(id);
				serverRequestManager.unregister(id);
				if (signal && onAbort) {
					signal.removeEventListener("abort", onAbort);
				}
				resolve(result);
			};

			// Define abort handler before registering to avoid reference issues
			let onAbort: (() => void) | undefined;

			if (signal) {
				onAbort = () => {
					safeResolve({
						content: [{ type: "text", text: "Aborted" } as TextContent],
						isError: true,
					});
				};
				signal.addEventListener("abort", onAbort, { once: true });

				// Check again after registering in case signal fired synchronously
				if (signal.aborted) {
					safeResolve({
						content: [{ type: "text", text: "Aborted" } as TextContent],
						isError: true,
					});
					return;
				}
			}

			this.pending.set(id, { resolve: safeResolve, timestamp: Date.now() });
			serverRequestManager.registerClientTool({
				id,
				sessionId,
				toolName,
				args,
				resolve: (content, isError) => {
					safeResolve({ content, isError });
					return true;
				},
				cancel: (reason) => {
					safeResolve({
						content: [{ type: "text", text: reason } as TextContent],
						isError: true,
					});
					return true;
				},
			});
		});
	}

	resolve(id: string, content: ToolResultContent[], isError: boolean) {
		return serverRequestManager.resolveClientTool(id, content, isError);
	}
}

export const clientToolService = new ClientToolService();
