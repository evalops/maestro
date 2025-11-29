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
				s.getSystemPromptAdditions().catch((err) => {
					console.warn(`Context source '${s.name}' failed:`, err);
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
