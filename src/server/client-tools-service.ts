import type { ImageContent, TextContent } from "../agent/types.js";

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

			// Add entry only once, after abort listener is registered
			this.pending.set(id, { resolve: safeResolve, timestamp: Date.now() });
		});
	}

	resolve(id: string, content: ToolResultContent[], isError: boolean) {
		const entry = this.pending.get(id);
		if (entry) {
			this.pending.delete(id);
			entry.resolve({ content, isError });
			return true;
		}
		return false;
	}

	cleanup() {
		const now = Date.now();
		const timeout = 60 * 1000; // 60 seconds - VS Code API calls should complete quickly
		for (const [id, entry] of this.pending.entries()) {
			if (now - entry.timestamp > timeout) {
				this.pending.delete(id);
				entry.resolve({
					content: [
						{
							type: "text",
							text: "Client tool execution timed out after 60 seconds. The VS Code extension may not be responding.",
						} as TextContent,
					],
					isError: true,
				});
			}
		}
	}
}

export const clientToolService = new ClientToolService();

// Run cleanup periodically
setInterval(() => clientToolService.cleanup(), 60 * 1000).unref();
