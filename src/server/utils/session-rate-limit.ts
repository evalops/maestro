import {
	getRedisClient,
	initRedis,
	isRedisAvailable,
} from "../rate-limiter.js";

const WINDOW_MS =
	Number.parseInt(process.env.MAESTRO_RATE_LIMIT_WINDOW_MS || "60000", 10) ||
	60_000;
const SESSION_LIMIT =
	Number.parseInt(process.env.MAESTRO_RATE_LIMIT_SESSION || "30", 10) || 30;
const IP_LIMIT =
	Number.parseInt(process.env.MAESTRO_RATE_LIMIT_IP || "60", 10) || 60;
const FALLBACK_MAX_BUCKETS =
	Number.parseInt(
		process.env.MAESTRO_RATE_LIMIT_FALLBACK_MAX_BUCKETS || "10000",
		10,
	) || 10000;
const FALLBACK_CLEANUP_INTERVAL =
	Number.parseInt(
		process.env.MAESTRO_RATE_LIMIT_FALLBACK_CLEANUP_INTERVAL || "1000",
		10,
	) || 1000;

type BucketKey = string;

const hits = new Map<BucketKey, { count: number; windowStart: number }>();
let fallbackCleanupCounter = 0;

/**
 * Lua script for atomic rate limit check.
 *
 * This script ensures that INCR and PEXPIRE happen atomically, preventing
 * the race condition where INCR succeeds but PEXPIRE fails, leaving keys
 * without TTL that would permanently block users.
 *
 * The script also repairs keys that somehow lost their TTL by re-applying it.
 */
const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local window_ms = tonumber(ARGV[1])

-- Increment the counter
local count = redis.call('INCR', key)

-- Get current TTL
local ttl = redis.call('PTTL', key)

-- Set expiration if key is new (count == 1) or has no TTL (-1 means no expiry, -2 means key doesn't exist)
if ttl < 0 then
	redis.call('PEXPIRE', key, window_ms)
end

return count
`;

async function checkBucket(
	key: BucketKey,
	limit: number,
): Promise<{
	allowed: boolean;
	remaining: number;
}> {
	if (isRedisAvailable()) {
		const client = getRedisClient();
		if (client) {
			try {
				// Use Lua script for atomic incr + expire
				const count = (await client.eval(
					RATE_LIMIT_SCRIPT,
					1,
					key,
					String(WINDOW_MS),
				)) as number;
				const remaining = Math.max(0, limit - count);
				return { allowed: count <= limit, remaining };
			} catch {
				// Fall through to in-memory fallback on Redis errors
			}
		}
	}

	const now = Date.now();
	const existing = hits.get(key);
	if (!existing || now - existing.windowStart >= WINDOW_MS) {
		hits.set(key, { count: 1, windowStart: now });
		maybeCleanupFallback(now);
		return { allowed: true, remaining: limit - 1 };
	}
	if (existing.count >= limit) {
		return { allowed: false, remaining: 0 };
	}
	existing.count += 1;
	hits.set(key, existing);
	maybeCleanupFallback(now);
	return { allowed: true, remaining: limit - existing.count };
}

function maybeCleanupFallback(now: number): void {
	if (hits.size > FALLBACK_MAX_BUCKETS) {
		cleanupFallback(now);
		return;
	}
	fallbackCleanupCounter += 1;
	if (
		FALLBACK_CLEANUP_INTERVAL > 0 &&
		fallbackCleanupCounter % FALLBACK_CLEANUP_INTERVAL === 0
	) {
		cleanupFallback(now);
	}
}

function cleanupFallback(now: number): void {
	for (const [key, entry] of hits) {
		if (now - entry.windowStart >= WINDOW_MS) {
			hits.delete(key);
		}
	}
	if (hits.size <= FALLBACK_MAX_BUCKETS) {
		return;
	}
	const entries = Array.from(hits.entries()).sort(
		(a, b) => a[1].windowStart - b[1].windowStart,
	);
	const excess = hits.size - FALLBACK_MAX_BUCKETS;
	for (let i = 0; i < excess; i += 1) {
		const entry = entries[i];
		if (entry) {
			hits.delete(entry[0]);
		}
	}
}

// Exported for tests
export function getFallbackBucketCountForTests(): number {
	return hits.size;
}

// Exported for tests
export function resetFallbackBucketsForTests(): void {
	hits.clear();
	fallbackCleanupCounter = 0;
}

export function checkSessionRateLimit(sessionKey: string): {
	allowed: boolean;
	remaining: number;
} {
	return {
		allowed: true,
		remaining: SESSION_LIMIT, // placeholder sync wrapper
	};
}

export function checkIpRateLimit(ip?: string | null): {
	allowed: boolean;
	remaining: number;
} {
	if (!ip) return { allowed: true, remaining: IP_LIMIT };
	return {
		allowed: true,
		remaining: IP_LIMIT,
	};
}

export async function checkSessionRateLimitAsync(sessionKey: string) {
	await initRedis().catch(() => {});
	return checkBucket(`session:${sessionKey}`, SESSION_LIMIT);
}

export async function checkIpRateLimitAsync(ip?: string | null) {
	await initRedis().catch(() => {});
	if (!ip) return { allowed: true, remaining: IP_LIMIT };
	return checkBucket(`ip:${ip}`, IP_LIMIT);
}
