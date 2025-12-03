import { createLogger } from "../utils/logger.js";

const logger = createLogger("context-manager");

/**
 * Custom error for context source timeouts.
 */
export class ContextTimeoutError extends Error {
	readonly sourceName: string;
	readonly timeoutMs: number;

	constructor(sourceName: string, timeoutMs: number) {
		super(`Context source '${sourceName}' timed out after ${timeoutMs}ms`);
		this.name = "ContextTimeoutError";
		this.sourceName = sourceName;
		this.timeoutMs = timeoutMs;
	}
}

/**
 * Custom error for context source failures.
 */
export class ContextSourceError extends Error {
	readonly sourceName: string;
	readonly cause: Error | unknown;

	constructor(sourceName: string, cause: Error | unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(`Context source '${sourceName}' failed: ${message}`);
		this.name = "ContextSourceError";
		this.sourceName = sourceName;
		this.cause = cause;
	}
}

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

/** Status of a single source load operation */
export interface SourceLoadStatus {
	name: string;
	status: "success" | "timeout" | "error" | "skipped" | "empty";
	durationMs: number;
	error?: string;
	truncated?: boolean;
	originalLength?: number;
}

/** Result from getCombinedSystemPrompt with detailed status */
export interface ContextLoadResult {
	prompt: string;
	sourceStatuses: SourceLoadStatus[];
	totalDurationMs: number;
	successCount: number;
	failureCount: number;
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

	/**
	 * Get combined system prompt from all sources.
	 * Returns just the prompt string for backward compatibility.
	 */
	async getCombinedSystemPrompt(): Promise<string> {
		const result = await this.getCombinedSystemPromptWithStatus();
		return result.prompt;
	}

	/**
	 * Get combined system prompt with detailed status for each source.
	 */
	async getCombinedSystemPromptWithStatus(): Promise<ContextLoadResult> {
		const startTime = Date.now();
		const parts: string[] = [];
		const sourceStatuses: SourceLoadStatus[] = [];

		// Run in parallel for performance
		const results = await Promise.all(
			this.sources.map(async (source) => {
				const sourceStart = Date.now();

				// Check if source is enabled
				if (
					this.options.enabledSources &&
					!this.options.enabledSources.includes(source.name)
				) {
					return {
						name: source.name,
						status: "skipped" as const,
						durationMs: 0,
						content: null,
					};
				}

				const controller = new AbortController();

				try {
					const result = await withTimeout(
						source.getSystemPromptAdditions({
							signal: controller.signal,
						}),
						this.options.sourceTimeoutMs,
						controller,
						source.name,
					);

					const durationMs = Date.now() - sourceStart;

					if (result === null) {
						return {
							name: source.name,
							status: "empty" as const,
							durationMs,
							content: null,
						};
					}

					const originalLength = result.length;
					const truncated = truncate(result, this.options.maxCharsPerSource);
					const wasTruncated = truncated.length < originalLength;

					// Log slow sources (> 80% of timeout)
					if (durationMs > this.options.sourceTimeoutMs * 0.8) {
						logger.warn(`Context source '${source.name}' is slow`, {
							durationMs,
							timeoutMs: this.options.sourceTimeoutMs,
							percentOfTimeout: Math.round(
								(durationMs / this.options.sourceTimeoutMs) * 100,
							),
						});
					}

					return {
						name: source.name,
						status: "success" as const,
						durationMs,
						content: truncated,
						truncated: wasTruncated,
						originalLength,
					};
				} catch (error) {
					const durationMs = Date.now() - sourceStart;

					if (error instanceof ContextTimeoutError) {
						logger.warn(`Context source '${source.name}' timed out`, {
							timeoutMs: this.options.sourceTimeoutMs,
							durationMs,
						});
						return {
							name: source.name,
							status: "timeout" as const,
							durationMs,
							content: null,
							error: error.message,
						};
					}

					logger.warn(`Context source '${source.name}' failed`, {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
						durationMs,
					});
					return {
						name: source.name,
						status: "error" as const,
						durationMs,
						content: null,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			}),
		);

		let successCount = 0;
		let failureCount = 0;

		for (const result of results) {
			sourceStatuses.push({
				name: result.name,
				status: result.status,
				durationMs: result.durationMs,
				error: result.error,
				truncated: result.truncated,
				originalLength: result.originalLength,
			});

			if (result.content) {
				parts.push(result.content);
				successCount++;
			} else if (result.status === "error" || result.status === "timeout") {
				failureCount++;
			}
		}

		const totalDurationMs = Date.now() - startTime;

		// Log summary if there were failures
		if (failureCount > 0) {
			logger.warn("Some context sources failed", {
				successCount,
				failureCount,
				totalDurationMs,
				failedSources: sourceStatuses
					.filter((s) => s.status === "error" || s.status === "timeout")
					.map((s) => s.name),
			});
		}

		return {
			prompt: parts.length > 0 ? parts.join("\n\n") : "",
			sourceStatuses,
			totalDurationMs,
			successCount,
			failureCount,
		};
	}

	/**
	 * Get list of registered source names.
	 */
	getSourceNames(): string[] {
		return this.sources.map((s) => s.name);
	}

	/**
	 * Check if a source is enabled.
	 */
	isSourceEnabled(name: string): boolean {
		if (!this.options.enabledSources) {
			return true; // All enabled if no filter
		}
		return this.options.enabledSources.includes(name);
	}
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	controller: AbortController,
	sourceName: string,
): Promise<T> {
	let timeoutHandle: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeoutHandle = setTimeout(() => {
					controller.abort(new ContextTimeoutError(sourceName, timeoutMs));
					reject(new ContextTimeoutError(sourceName, timeoutMs));
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
