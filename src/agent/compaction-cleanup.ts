import { createLogger } from "../utils/logger.js";

const logger = createLogger("compaction-cleanup");

export interface PostCompactionCleanupContext {
	auto?: boolean;
	customInstructions?: string;
	compactedCount: number;
	firstKeptEntryIndex: number;
	sessionId?: string;
	threadId?: string;
}

type CleanupHandler = (
	context: PostCompactionCleanupContext,
) => void | Promise<void>;

const cleanupHandlers = new Map<string, CleanupHandler>();

export function registerPostCompactionCleanup(
	id: string,
	handler: CleanupHandler,
): () => void {
	cleanupHandlers.set(id, handler);
	return () => {
		if (cleanupHandlers.get(id) === handler) {
			cleanupHandlers.delete(id);
		}
	};
}

export async function runPostCompactionCleanup(
	context: PostCompactionCleanupContext,
): Promise<void> {
	for (const [id, handler] of cleanupHandlers.entries()) {
		try {
			await handler(context);
		} catch (error) {
			logger.warn("Post-compaction cleanup handler failed", {
				handlerId: id,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				compactedCount: context.compactedCount,
				firstKeptEntryIndex: context.firstKeptEntryIndex,
				sessionId: context.sessionId,
				threadId: context.threadId,
			});
		}
	}
}

export function resetPostCompactionCleanupRegistry(): void {
	cleanupHandlers.clear();
}
