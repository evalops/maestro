/**
 * Restart Policy Engine
 *
 * Functions for configuring and executing restart policies with
 * support for fixed and exponential backoff strategies, plus jitter
 * to prevent thundering herd problems.
 */

/**
 * Restart Policy Configuration
 *
 * Defines how a task should be restarted after non-zero exit. The policy
 * supports two backoff strategies and includes jitter to prevent thundering
 * herd when multiple tasks restart simultaneously.
 *
 * ## Strategies
 *
 * ### Fixed Delay
 * Always waits `delayMs` between restart attempts. Simple and predictable.
 * Use when: restart failures are likely transient and short-lived.
 *
 * ### Exponential Backoff
 * Delay doubles with each attempt: delayMs, 2*delayMs, 4*delayMs, ...
 * Capped at `maxDelayMs` to prevent unbounded waits.
 * Use when: failures may indicate resource contention or need recovery time.
 *
 * ## Jitter
 *
 * Random variation applied to delay to prevent synchronized restarts:
 * `actualDelay = delay ± (delay * jitterRatio)`
 *
 * This is critical when multiple background tasks fail together (e.g., database
 * goes down). Without jitter, they'd all retry at the exact same time, potentially
 * overwhelming the recovering service.
 */
export interface RestartPolicy {
	/** Maximum restart attempts before giving up (task fails permanently) */
	maxAttempts: number;
	/** Base delay between restart attempts in milliseconds */
	delayMs: number;
	/** Current restart attempt counter (0 = no restarts yet) */
	attempts: number;
	/** "fixed" = constant delay, "exponential" = doubles each attempt */
	strategy: "fixed" | "exponential";
	/** Upper bound for exponential backoff (prevents multi-minute waits) */
	maxDelayMs: number;
	/** Random variation factor: 0.0 = no jitter, 1.0 = ±100% variation */
	jitterRatio: number;
	/** Next attempt count that triggers a notification (grows exponentially) */
	nextNotifyAttempt?: number;
}

/**
 * Options for creating a restart policy.
 */
export interface RestartPolicyOptions {
	/** Maximum restart attempts (1-5, clamped) */
	maxAttempts: number;
	/** Base delay between restart attempts in milliseconds (50-60000, clamped) */
	delayMs: number;
	/** Backoff strategy (default: "fixed") */
	strategy?: "fixed" | "exponential";
	/** Upper bound for exponential backoff (default: delayMs * 8) */
	maxDelayMs?: number;
	/** Random variation factor 0-1 (default: 0) */
	jitterRatio?: number;
}

/** Minimum allowed delay in milliseconds */
const MIN_DELAY_MS = 50;
/** Maximum allowed delay in milliseconds */
const MAX_DELAY_MS = 60_000;
/** Maximum allowed max delay in milliseconds (10 minutes) */
const MAX_MAX_DELAY_MS = 10 * 60 * 1000;
/** Maximum allowed restart attempts */
const MAX_ATTEMPTS = 5;
/** Default multiplier for maxDelayMs when not specified */
const DEFAULT_MAX_DELAY_MULTIPLIER = 8;

/**
 * Create a normalized restart policy from options.
 *
 * Applies bounds checking and defaults:
 * - maxAttempts: clamped to 1-5
 * - delayMs: clamped to 50-60000ms
 * - maxDelayMs: defaults to delayMs * 8, clamped to 10 minutes
 * - jitterRatio: clamped to 0-1
 *
 * @param options - Restart policy options
 * @param notifyThreshold - Optional threshold for restart notifications
 * @returns Normalized restart policy, or undefined if maxAttempts <= 0
 */
export function createRestartPolicy(
	options: RestartPolicyOptions,
	notifyThreshold?: number,
): RestartPolicy | undefined {
	if (!options || options.maxAttempts <= 0) {
		return undefined;
	}

	const maxAttempts = Math.min(Math.max(options.maxAttempts, 0), MAX_ATTEMPTS);
	if (maxAttempts === 0) {
		return undefined;
	}

	const delayMs = Math.min(
		Math.max(options.delayMs, MIN_DELAY_MS),
		MAX_DELAY_MS,
	);
	const strategy: RestartPolicy["strategy"] =
		options.strategy === "exponential" ? "exponential" : "fixed";

	const rawMaxDelay =
		options.maxDelayMs !== undefined
			? Math.max(options.maxDelayMs, delayMs)
			: delayMs * DEFAULT_MAX_DELAY_MULTIPLIER;
	const maxDelayMs = Math.min(Math.max(rawMaxDelay, delayMs), MAX_MAX_DELAY_MS);

	const jitterRatio = Math.min(Math.max(options.jitterRatio ?? 0, 0), 1);

	const policy: RestartPolicy = {
		maxAttempts,
		delayMs,
		attempts: 0,
		strategy,
		maxDelayMs,
		jitterRatio,
	};

	if (notifyThreshold !== undefined && Number.isFinite(notifyThreshold)) {
		policy.nextNotifyAttempt = notifyThreshold;
	}

	return policy;
}

/**
 * Check if a restart policy can attempt another restart.
 *
 * @param policy - The restart policy
 * @returns true if attempts < maxAttempts
 */
export function canRestart(policy: RestartPolicy | undefined): boolean {
	if (!policy) {
		return false;
	}
	return policy.attempts < policy.maxAttempts;
}

/**
 * Increment the restart attempt counter.
 *
 * @param policy - The restart policy to update (mutated in place)
 * @returns The new attempt count
 */
export function incrementAttempts(policy: RestartPolicy): number {
	policy.attempts += 1;
	return policy.attempts;
}

/**
 * Compute restart delay with backoff and jitter.
 *
 * Calculates the actual delay before the next restart attempt, applying
 * the configured backoff strategy and jitter.
 *
 * ## Exponential Backoff Calculation
 *
 * For exponential strategy, delay doubles with each attempt:
 * - Attempt 1: delayMs * 2^0 = delayMs
 * - Attempt 2: delayMs * 2^1 = 2 * delayMs
 * - Attempt 3: delayMs * 2^2 = 4 * delayMs
 * - etc., capped at maxDelayMs
 *
 * ## Jitter Application
 *
 * Jitter adds randomness to prevent synchronized restarts (thundering herd):
 *
 * ```
 * jitterRange = delay * jitterRatio
 * actualDelay = random(delay - jitterRange, delay + jitterRange)
 * ```
 *
 * Example with delay=1000ms and jitterRatio=0.25:
 * - jitterRange = 250ms
 * - actualDelay = random value between 750ms and 1250ms
 *
 * A minimum of 50ms is enforced to prevent near-instant retries.
 *
 * @param policy - The restart policy configuration
 * @param randomFn - Optional random function for testing (default: Math.random)
 * @returns Delay in milliseconds before next restart attempt
 */
export function computeRestartDelay(
	policy: RestartPolicy,
	randomFn: () => number = Math.random,
): number {
	let delay = policy.delayMs;

	// Apply exponential backoff if configured
	if (policy.strategy === "exponential") {
		// Exponent is attempts-1 so first restart uses base delay
		const exponent = Math.max(policy.attempts - 1, 0);
		// 2^exponent scaling: 1x, 2x, 4x, 8x, ...
		const scaled = policy.delayMs * 2 ** exponent;
		// Clamp between base delay and maximum
		delay = Math.min(Math.max(scaled, policy.delayMs), policy.maxDelayMs);
	}

	// Apply jitter to prevent synchronized restarts
	if (policy.jitterRatio > 0 && delay > 0) {
		const jitter = delay * policy.jitterRatio;
		// Minimum 50ms to prevent near-instant retries after jitter subtraction
		const min = Math.max(MIN_DELAY_MS, delay - jitter);
		const max = delay + jitter;
		const range = Math.max(max - min, 0);
		// Uniform random distribution within jitter range
		delay = Math.round(min + randomFn() * range);
	}

	return delay;
}

/**
 * Check if restart notification should be triggered.
 *
 * Uses exponential growth (2, 4, 8, ...) to avoid spamming notifications.
 *
 * @param policy - The restart policy
 * @returns true if notification should be shown
 */
export function shouldNotifyRestart(policy: RestartPolicy): boolean {
	if (policy.nextNotifyAttempt === undefined) {
		return false;
	}
	return policy.attempts >= policy.nextNotifyAttempt;
}

/**
 * Update the next notification threshold after showing a notification.
 *
 * Doubles the threshold to implement exponential notification spacing.
 *
 * @param policy - The restart policy to update (mutated in place)
 */
export function updateNotifyThreshold(policy: RestartPolicy): void {
	if (policy.nextNotifyAttempt !== undefined) {
		policy.nextNotifyAttempt = policy.nextNotifyAttempt * 2;
	}
}
