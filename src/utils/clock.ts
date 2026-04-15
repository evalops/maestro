export interface Clock {
	now(): number;
	setTimeout(handler: () => void, ms: number): NodeJS.Timeout;
	clearTimeout(timeoutId: NodeJS.Timeout): void;
}

export const systemClock: Clock = {
	now: () => Date.now(),
	setTimeout: (handler, ms) => setTimeout(handler, ms),
	clearTimeout: (timeoutId) => clearTimeout(timeoutId),
};
