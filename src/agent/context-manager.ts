/**
 * Agent Context Manager
 *
 * This module manages dynamic context loading from multiple sources to build
 * the agent's system prompt. Context sources can include:
 * - Todo lists and task state
 * - LSP diagnostics and symbols
 * - Background task outputs
 * - Custom user-defined sources
 *
 * Key features:
 * - Parallel loading of all context sources for performance
 * - Per-source timeouts to prevent slow sources from blocking
 * - Content truncation to stay within token limits
 * - Detailed status reporting for debugging and monitoring
 *
 * The manager uses a defensive approach: individual source failures
 * don't block the entire context assembly. Failed sources are logged
 * and skipped, allowing the agent to continue with partial context.
 */

import { type Clock, systemClock } from "../utils/clock.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("context-manager");

/**
 * Custom error for context source timeouts.
 * Thrown when a source exceeds its allowed time budget.
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
	override readonly cause: Error | unknown;

	constructor(sourceName: string, cause: Error | unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(`Context source '${sourceName}' failed: ${message}`);
		this.name = "ContextSourceError";
		this.sourceName = sourceName;
		this.cause = cause;
	}
}

/**
 * Interface for pluggable context sources.
 *
 * Each source provides additional content to append to the system prompt.
 * Sources should:
 * - Return null if they have no content to contribute
 * - Respect the abort signal for cancellation
 * - Handle their own errors gracefully
 */
export interface AgentContextSource {
	/** Unique identifier for this source (used for filtering and logging) */
	name: string;
	/** Whether the source can be cached for the life of the manager/session. */
	cacheScope?: "none" | "session";

	/**
	 * Fetch the context content to add to the system prompt.
	 * @param options.signal - Abort signal for cancellation support
	 * @returns The content string, or null if no content to contribute
	 */
	getSystemPromptAdditions(options?: { signal?: AbortSignal }): Promise<
		string | null
	>;
}

/**
 * Configuration options for the context manager.
 */
interface AgentContextOptions {
	/** Maximum time to wait for each source (default: 1500ms) */
	sourceTimeoutMs?: number;
	/** Maximum characters allowed from each source (default: 4000) */
	maxCharsPerSource?: number;
	/** Whitelist of source names to enable (null = all enabled) */
	enabledSources?: string[] | null;
	/** Clock for timing (default: system clock) */
	clock?: Clock;
}

/** Status of a single source load operation */
export interface SourceLoadStatus {
	name: string;
	status: "success" | "timeout" | "error" | "skipped" | "empty";
	durationMs: number;
	cached?: boolean;
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

/**
 * Manages multiple context sources and assembles their content into
 * a combined system prompt addition.
 *
 * Usage:
 * ```typescript
 * const manager = new AgentContextManager({ sourceTimeoutMs: 2000 });
 * manager.addSource(todoContextSource);
 * manager.addSource(lspDiagnosticsSource);
 * const result = await manager.getCombinedSystemPromptWithStatus();
 * ```
 */
export class AgentContextManager {
	/** Registered context sources, loaded in parallel */
	private sources: AgentContextSource[] = [];
	/** Per-session cache for stable context sources. */
	private readonly sourceCache = new Map<string, string | null>();
	/** Resolved configuration with defaults applied */
	private readonly options: Required<AgentContextOptions>;

	constructor(options: AgentContextOptions = {}) {
		// Apply defaults for any unspecified options
		this.options = {
			sourceTimeoutMs: options.sourceTimeoutMs ?? 1500,
			maxCharsPerSource: options.maxCharsPerSource ?? 4000,
			enabledSources: options.enabledSources ?? null,
			clock: options.clock ?? systemClock,
		};
	}

	/**
	 * Register a context source.
	 * Sources are loaded in parallel when getCombinedSystemPrompt is called.
	 */
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
	 * This is the main entry point for context assembly.
	 *
	 * The method:
	 * 1. Filters sources based on enabledSources whitelist
	 * 2. Loads all enabled sources in parallel
	 * 3. Applies per-source timeout and truncation limits
	 * 4. Collects detailed status for monitoring
	 * 5. Joins successful results into a single prompt
	 */
	async getCombinedSystemPromptWithStatus(): Promise<ContextLoadResult> {
		const startTime = this.options.clock.now();
		const parts: string[] = []; // Successful content fragments
		const sourceStatuses: SourceLoadStatus[] = []; // Status for each source

		// Run all sources in parallel for optimal latency.
		// Each source has its own timeout, so slow sources don't block fast ones.
		const results = await Promise.all(
			this.sources.map(async (source) => {
				const sourceStart = this.options.clock.now();

				// Skip disabled sources immediately (no timeout overhead)
				if (
					this.options.enabledSources &&
					!this.options.enabledSources.includes(source.name)
				) {
					return {
						name: source.name,
						status: "skipped" as const,
						durationMs: 0,
						cached: false,
						content: null,
					};
				}

				if (
					source.cacheScope === "session" &&
					this.sourceCache.has(source.name)
				) {
					return this.formatSourceResult(
						source.name,
						this.sourceCache.get(source.name) ?? null,
						0,
						true,
					);
				}

				// Each source gets its own AbortController for independent cancellation
				const controller = new AbortController();

				try {
					const result = await withTimeout(
						source.getSystemPromptAdditions({
							signal: controller.signal,
						}),
						this.options.sourceTimeoutMs,
						controller,
						source.name,
						this.options.clock,
					);

					const durationMs = this.options.clock.now() - sourceStart;

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

					if (source.cacheScope === "session") {
						this.sourceCache.set(source.name, result);
					}

					return this.formatSourceResult(
						source.name,
						result,
						durationMs,
						false,
					);
				} catch (error) {
					const durationMs = this.options.clock.now() - sourceStart;

					if (error instanceof ContextTimeoutError) {
						logger.warn(`Context source '${source.name}' timed out`, {
							timeoutMs: this.options.sourceTimeoutMs,
							durationMs,
						});
						return {
							name: source.name,
							status: "timeout" as const,
							durationMs,
							cached: false,
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
						cached: false,
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
				cached: result.cached,
				error: "error" in result ? result.error : undefined,
				truncated: "truncated" in result ? result.truncated : undefined,
				originalLength:
					"originalLength" in result ? result.originalLength : undefined,
			});

			if (result.content) {
				parts.push(result.content);
				successCount++;
			} else if (result.status === "error" || result.status === "timeout") {
				failureCount++;
			}
		}

		const totalDurationMs = this.options.clock.now() - startTime;

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

	private formatSourceResult(
		name: string,
		content: string | null,
		durationMs: number,
		cached: boolean,
	):
		| {
				name: string;
				status: "empty";
				durationMs: number;
				cached: boolean;
				content: null;
		  }
		| {
				name: string;
				status: "success";
				durationMs: number;
				cached: boolean;
				content: string;
				truncated: boolean;
				originalLength: number;
		  } {
		if (content === null) {
			return {
				name,
				status: "empty",
				durationMs,
				cached,
				content: null,
			};
		}

		const originalLength = content.length;
		const truncated = truncate(content, this.options.maxCharsPerSource);
		const wasTruncated = truncated.length < originalLength;

		return {
			name,
			status: "success",
			durationMs,
			cached,
			content: truncated,
			truncated: wasTruncated,
			originalLength,
		};
	}
}

/**
 * Wraps a promise with a timeout, aborting if the timeout is exceeded.
 *
 * Uses Promise.race to compete the original promise against a timeout.
 * If the timeout wins, it aborts the controller (allowing the source
 * to clean up) and rejects with a ContextTimeoutError.
 *
 * @param promise - The promise to wrap
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @param controller - AbortController to signal cancellation
 * @param sourceName - Name of the source (for error messages)
 */
async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	controller: AbortController,
	sourceName: string,
	clock: Clock,
): Promise<T> {
	let timeoutHandle: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeoutHandle = clock.setTimeout(() => {
					// Abort the controller first to signal the source to stop
					controller.abort(new ContextTimeoutError(sourceName, timeoutMs));
					// Then reject to complete the race
					reject(new ContextTimeoutError(sourceName, timeoutMs));
				}, timeoutMs);
			}),
		]);
	} finally {
		// Always clean up the timer to prevent memory leaks
		if (timeoutHandle) clock.clearTimeout(timeoutHandle);
	}
}

/**
 * Truncates a string to a maximum length, appending a suffix indicating
 * how much content was removed.
 *
 * Example output: "content here...\n\n[truncated 1234 chars]"
 *
 * @param value - The string to truncate
 * @param maxChars - Maximum allowed length
 */
function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) {
		return value;
	}
	// Build suffix first to know how much space it needs
	const suffix = `\n\n[truncated ${value.length - maxChars} chars]`;
	const available = Math.max(0, maxChars - suffix.length);
	const head = available > 0 ? value.slice(0, available) : "";
	return `${head}${suffix}`.slice(0, Math.max(0, maxChars));
}
