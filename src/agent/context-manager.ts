import { createLogger } from "../utils/logger.js";

const logger = createLogger("context-manager");

export interface AgentContextSource {
	name: string;
	getSystemPromptAdditions(options?: { signal?: AbortSignal }): Promise<
		string | null
	>;
}

interface AgentContextOptions {
	sourceTimeoutMs?: number;
	maxCharsPerSource?: number;
	enabledSources?: string[] | null;
}

export class AgentContextManager {
	private sources: AgentContextSource[] = [];
	private readonly options: Required<AgentContextOptions>;

	constructor(options: AgentContextOptions = {}) {
		this.options = {
			sourceTimeoutMs: options.sourceTimeoutMs ?? 1500,
			maxCharsPerSource: options.maxCharsPerSource ?? 4000,
			enabledSources: options.enabledSources ?? null,
		};
	}

	addSource(source: AgentContextSource): void {
		this.sources.push(source);
	}

	async getCombinedSystemPrompt(): Promise<string> {
		const parts: string[] = [];
		// Run in parallel for performance
		const results = await Promise.all(
			this.sources.map(async (source) => {
				if (
					this.options.enabledSources &&
					!this.options.enabledSources.includes(source.name)
				) {
					return null;
				}

				const controller = new AbortController();
				const started = Date.now();

				try {
					const result = await withTimeout(
						source.getSystemPromptAdditions({
							signal: controller.signal,
						}),
						this.options.sourceTimeoutMs,
						controller,
					);
					if (result === null) return null;

					const truncated = truncate(result, this.options.maxCharsPerSource);
					const elapsed = Date.now() - started;
					if (elapsed > this.options.sourceTimeoutMs * 0.8) {
						logger.debug(
							`Context source '${source.name}' completed in ${elapsed}ms`,
						);
					}
					return truncated;
				} catch (error) {
					logger.warn(`Context source '${source.name}' failed`, {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
					return null;
				}
			}),
		);

		for (const result of results) {
			if (result) {
				parts.push(result);
			}
		}

		return parts.length > 0 ? parts.join("\n\n") : "";
	}
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	controller: AbortController,
): Promise<T | null> {
	let timeoutHandle: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timeoutHandle = setTimeout(() => {
					controller.abort(new Error(`context timeout after ${timeoutMs}ms`));
					reject(new Error(`context timeout after ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) {
		return value;
	}
	const suffix = `\n\n[truncated ${value.length - maxChars} chars]`;
	const available = Math.max(0, maxChars - suffix.length);
	const head = available > 0 ? value.slice(0, available) : "";
	return `${head}${suffix}`;
}
