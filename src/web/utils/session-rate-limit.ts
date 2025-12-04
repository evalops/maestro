const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;

type BucketKey = string;

const hits = new Map<BucketKey, { count: number; windowStart: number }>();

function checkBucket(
	key: BucketKey,
	limit = MAX_REQUESTS,
): {
	allowed: boolean;
	remaining: number;
} {
	const now = Date.now();
	const existing = hits.get(key);
	if (!existing || now - existing.windowStart >= WINDOW_MS) {
		hits.set(key, { count: 1, windowStart: now });
		return { allowed: true, remaining: limit - 1 };
	}
	if (existing.count >= limit) {
		return { allowed: false, remaining: 0 };
	}
	existing.count += 1;
	hits.set(key, existing);
	return { allowed: true, remaining: limit - existing.count };
}

export function checkSessionRateLimit(sessionId: string): {
	allowed: boolean;
	remaining: number;
} {
	return checkBucket(`session:${sessionId}`);
}

export function checkIpRateLimit(ip?: string | null): {
	allowed: boolean;
	remaining: number;
} {
	if (!ip) return { allowed: true, remaining: MAX_REQUESTS };
	return checkBucket(`ip:${ip}`, MAX_REQUESTS * 2);
}
