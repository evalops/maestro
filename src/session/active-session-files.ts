// Files to skip during migration (e.g., currently active session files).
export const activeSessionFiles = new Set<string>();

/**
 * Register a file to be skipped during migration.
 * Used to prevent race conditions with active session writers.
 */
export function registerActiveSessionFile(filePath: string): void {
	activeSessionFiles.add(filePath);
}

/**
 * Unregister a file from the skip list.
 */
export function unregisterActiveSessionFile(filePath: string): void {
	activeSessionFiles.delete(filePath);
}
