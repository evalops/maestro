import type { TextContent } from "../agent/types.js";

type PendingEntry = {
	resolve: (result: { content: any[]; isError: boolean }) => void;
	timestamp: number;
};

export class ClientToolService {
	private pending = new Map<string, PendingEntry>();

	async requestExecution(
		id: string,
		toolName: string,
		args: unknown,
		signal?: AbortSignal,
	): Promise<{ content: any[]; isError: boolean }> {
		if (signal?.aborted) {
			return {
				content: [{ type: "text", text: "Aborted" } as TextContent],
				isError: true,
			};
		}

		return new Promise((resolve) => {
			this.pending.set(id, { resolve, timestamp: Date.now() });

			if (signal) {
				signal.addEventListener(
					"abort",
					() => {
						this.pending.delete(id);
						resolve({
							content: [{ type: "text", text: "Aborted" } as TextContent],
							isError: true,
						});
					},
					{ once: true },
				);
			}
		});
	}

	resolve(id: string, content: any[], isError: boolean) {
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
