const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;

const hits = new Map<string, { count: number; windowStart: number }>();

export function checkSessionRateLimit(sessionId: string): {
	allowed: boolean;
	remaining: number;
} {
	const now = Date.now();
	const existing = hits.get(sessionId);
	if (!existing || now - existing.windowStart >= WINDOW_MS) {
		hits.set(sessionId, { count: 1, windowStart: now });
		return { allowed: true, remaining: MAX_REQUESTS - 1 };
	}
	if (existing.count >= MAX_REQUESTS) {
		return { allowed: false, remaining: 0 };
	}
	existing.count += 1;
	hits.set(sessionId, existing);
	return { allowed: true, remaining: MAX_REQUESTS - existing.count };
}
