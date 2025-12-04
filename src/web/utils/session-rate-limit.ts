const WINDOW_MS =
	Number.parseInt(process.env.COMPOSER_RATE_LIMIT_WINDOW_MS || "60000", 10) ||
	60_000;
const SESSION_LIMIT =
	Number.parseInt(process.env.COMPOSER_RATE_LIMIT_SESSION || "30", 10) || 30;
const IP_LIMIT =
	Number.parseInt(process.env.COMPOSER_RATE_LIMIT_IP || "60", 10) || 60;

type BucketKey = string;

const hits = new Map<BucketKey, { count: number; windowStart: number }>();

function checkBucket(
	key: BucketKey,
	limit: number,
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

export function checkSessionRateLimit(sessionKey: string): {
	allowed: boolean;
	remaining: number;
} {
	return checkBucket(`session:${sessionKey}`, SESSION_LIMIT);
}

export function checkIpRateLimit(ip?: string | null): {
	allowed: boolean;
	remaining: number;
} {
	if (!ip) return { allowed: true, remaining: IP_LIMIT };
	return checkBucket(`ip:${ip}`, IP_LIMIT);
}
