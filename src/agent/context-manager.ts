import { createLogger } from "../utils/logger.js";

const logger = createLogger("context-manager");

export interface AgentContextSource {
	name: string;
	getSystemPromptAdditions(): Promise<string | null>;
}

export class AgentContextManager {
	private sources: AgentContextSource[] = [];

	addSource(source: AgentContextSource): void {
		this.sources.push(source);
	}

	async getCombinedSystemPrompt(): Promise<string> {
		const parts: string[] = [];
		// Run in parallel for performance
		const results = await Promise.all(
			this.sources.map((s) =>
				s.getSystemPromptAdditions().catch((error) => {
					logger.warn(`Context source '${s.name}' failed`, {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
					return null;
				}),
			),
		);

		for (const result of results) {
			if (result) {
				parts.push(result);
			}
		}

		return parts.length > 0 ? parts.join("\n\n") : "";
	}
}
