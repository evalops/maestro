let lastUserInteractionTime = Date.now();

/**
 * Record a user interaction timestamp.
 */
export function recordUserInteraction(at = Date.now()): void {
	lastUserInteractionTime = at;
}

/**
 * Read the last recorded user interaction timestamp.
 */
export function getLastUserInteractionTime(): number {
	return lastUserInteractionTime;
}

/**
 * Get the elapsed time since the last recorded interaction.
 */
export function getTimeSinceLastUserInteraction(now = Date.now()): number {
	return now - lastUserInteractionTime;
}

/**
 * Reset interaction tracking state for tests.
 */
export function resetUserInteractionTracking(at = Date.now()): void {
	lastUserInteractionTime = at;
}
