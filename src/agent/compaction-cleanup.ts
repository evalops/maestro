export interface PostCompactionCleanupContext {
	auto?: boolean;
	customInstructions?: string;
	compactedCount: number;
	firstKeptEntryIndex: number;
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
	for (const handler of cleanupHandlers.values()) {
		await handler(context);
	}
}

export function resetPostCompactionCleanupRegistry(): void {
	cleanupHandlers.clear();
}
