import { describe, expect, it } from "vitest";
import {
	type RestartPolicy,
	canRestart,
	computeRestartDelay,
	createRestartPolicy,
	incrementAttempts,
	shouldNotifyRestart,
	updateNotifyThreshold,
} from "../../src/tools/background/index.js";

describe("createRestartPolicy", () => {
	it("creates a valid policy with minimal options", () => {
		const policy = createRestartPolicy({ maxAttempts: 3, delayMs: 1000 });

		expect(policy).not.toBeUndefined();
		expect(policy?.maxAttempts).toBe(3);
		expect(policy?.delayMs).toBe(1000);
		expect(policy?.attempts).toBe(0);
		expect(policy?.strategy).toBe("fixed");
		expect(policy?.jitterRatio).toBe(0);
	});

	it("returns undefined for maxAttempts <= 0", () => {
		expect(
			createRestartPolicy({ maxAttempts: 0, delayMs: 1000 }),
		).toBeUndefined();
		expect(
			createRestartPolicy({ maxAttempts: -1, delayMs: 1000 }),
		).toBeUndefined();
	});

	it("clamps maxAttempts to 5", () => {
		const policy = createRestartPolicy({ maxAttempts: 10, delayMs: 1000 });
		expect(policy?.maxAttempts).toBe(5);
	});

	it("clamps delayMs to minimum 50ms", () => {
		const policy = createRestartPolicy({ maxAttempts: 3, delayMs: 10 });
		expect(policy?.delayMs).toBe(50);
	});

	it("clamps delayMs to maximum 60000ms", () => {
		const policy = createRestartPolicy({ maxAttempts: 3, delayMs: 100000 });
		expect(policy?.delayMs).toBe(60000);
	});

	it("sets exponential strategy when specified", () => {
		const policy = createRestartPolicy({
			maxAttempts: 3,
			delayMs: 1000,
			strategy: "exponential",
		});
		expect(policy?.strategy).toBe("exponential");
	});

	it("defaults maxDelayMs to delayMs * 8", () => {
		const policy = createRestartPolicy({ maxAttempts: 3, delayMs: 1000 });
		expect(policy?.maxDelayMs).toBe(8000);
	});

	it("respects custom maxDelayMs", () => {
		const policy = createRestartPolicy({
			maxAttempts: 3,
			delayMs: 1000,
			maxDelayMs: 5000,
		});
		expect(policy?.maxDelayMs).toBe(5000);
	});

	it("clamps maxDelayMs to at least delayMs", () => {
		const policy = createRestartPolicy({
			maxAttempts: 3,
			delayMs: 1000,
			maxDelayMs: 500,
		});
		expect(policy?.maxDelayMs).toBe(1000);
	});

	it("clamps maxDelayMs to 10 minutes max", () => {
		const policy = createRestartPolicy({
			maxAttempts: 3,
			delayMs: 1000,
			maxDelayMs: 999999999,
		});
		expect(policy?.maxDelayMs).toBe(10 * 60 * 1000);
	});

	it("clamps jitterRatio to 0-1", () => {
		const policyLow = createRestartPolicy({
			maxAttempts: 3,
			delayMs: 1000,
			jitterRatio: -0.5,
		});
		expect(policyLow?.jitterRatio).toBe(0);

		const policyHigh = createRestartPolicy({
			maxAttempts: 3,
			delayMs: 1000,
			jitterRatio: 1.5,
		});
		expect(policyHigh?.jitterRatio).toBe(1);
	});

	it("sets nextNotifyAttempt when threshold provided", () => {
		const policy = createRestartPolicy({ maxAttempts: 3, delayMs: 1000 }, 2);
		expect(policy?.nextNotifyAttempt).toBe(2);
	});

	it("does not set nextNotifyAttempt when threshold not provided", () => {
		const policy = createRestartPolicy({ maxAttempts: 3, delayMs: 1000 });
		expect(policy?.nextNotifyAttempt).toBeUndefined();
	});
});

describe("canRestart", () => {
	it("returns false for undefined policy", () => {
		expect(canRestart(undefined)).toBe(false);
	});

	it("returns true when attempts < maxAttempts", () => {
		const policy: RestartPolicy = {
			maxAttempts: 3,
			delayMs: 1000,
			attempts: 2,
			strategy: "fixed",
			maxDelayMs: 8000,
			jitterRatio: 0,
		};
		expect(canRestart(policy)).toBe(true);
	});

	it("returns false when attempts >= maxAttempts", () => {
		const policy: RestartPolicy = {
			maxAttempts: 3,
			delayMs: 1000,
			attempts: 3,
			strategy: "fixed",
			maxDelayMs: 8000,
			jitterRatio: 0,
		};
		expect(canRestart(policy)).toBe(false);
	});
});

describe("incrementAttempts", () => {
	it("increments attempts and returns new count", () => {
		const policy: RestartPolicy = {
			maxAttempts: 3,
			delayMs: 1000,
			attempts: 0,
			strategy: "fixed",
			maxDelayMs: 8000,
			jitterRatio: 0,
		};

		expect(incrementAttempts(policy)).toBe(1);
		expect(policy.attempts).toBe(1);

		expect(incrementAttempts(policy)).toBe(2);
		expect(policy.attempts).toBe(2);
	});
});

describe("computeRestartDelay", () => {
	describe("fixed strategy", () => {
		it("returns constant delay regardless of attempts", () => {
			const policy: RestartPolicy = {
				maxAttempts: 5,
				delayMs: 1000,
				attempts: 1,
				strategy: "fixed",
				maxDelayMs: 8000,
				jitterRatio: 0,
			};

			expect(computeRestartDelay(policy)).toBe(1000);

			policy.attempts = 3;
			expect(computeRestartDelay(policy)).toBe(1000);

			policy.attempts = 5;
			expect(computeRestartDelay(policy)).toBe(1000);
		});
	});

	describe("exponential strategy", () => {
		it("doubles delay with each attempt", () => {
			const policy: RestartPolicy = {
				maxAttempts: 5,
				delayMs: 1000,
				attempts: 1,
				strategy: "exponential",
				maxDelayMs: 16000,
				jitterRatio: 0,
			};

			// Attempt 1: 1000 * 2^0 = 1000
			expect(computeRestartDelay(policy)).toBe(1000);

			// Attempt 2: 1000 * 2^1 = 2000
			policy.attempts = 2;
			expect(computeRestartDelay(policy)).toBe(2000);

			// Attempt 3: 1000 * 2^2 = 4000
			policy.attempts = 3;
			expect(computeRestartDelay(policy)).toBe(4000);

			// Attempt 4: 1000 * 2^3 = 8000
			policy.attempts = 4;
			expect(computeRestartDelay(policy)).toBe(8000);
		});

		it("caps at maxDelayMs", () => {
			const policy: RestartPolicy = {
				maxAttempts: 10,
				delayMs: 1000,
				attempts: 5,
				strategy: "exponential",
				maxDelayMs: 5000,
				jitterRatio: 0,
			};

			// Would be 1000 * 2^4 = 16000, but capped at 5000
			expect(computeRestartDelay(policy)).toBe(5000);
		});
	});

	describe("jitter", () => {
		it("applies jitter within expected range", () => {
			const policy: RestartPolicy = {
				maxAttempts: 5,
				delayMs: 1000,
				attempts: 1,
				strategy: "fixed",
				maxDelayMs: 8000,
				jitterRatio: 0.25,
			};

			// With jitterRatio 0.25, delay should be in range [750, 1250]
			// (but min 50ms is enforced)
			const mockRandom = () => 0; // Returns minimum
			expect(computeRestartDelay(policy, mockRandom)).toBe(750);

			const mockRandomMax = () => 1; // Returns maximum
			expect(computeRestartDelay(policy, mockRandomMax)).toBe(1250);

			const mockRandomMid = () => 0.5; // Returns middle
			expect(computeRestartDelay(policy, mockRandomMid)).toBe(1000);
		});

		it("enforces minimum 50ms after jitter", () => {
			const policy: RestartPolicy = {
				maxAttempts: 5,
				delayMs: 60,
				attempts: 1,
				strategy: "fixed",
				maxDelayMs: 8000,
				jitterRatio: 0.5, // Would subtract 30ms, going to 30ms
			};

			// min(50, 60-30) = 50, so range is [50, 90]
			const mockRandom = () => 0;
			expect(computeRestartDelay(policy, mockRandom)).toBe(50);
		});

		it("does not apply jitter when jitterRatio is 0", () => {
			const policy: RestartPolicy = {
				maxAttempts: 5,
				delayMs: 1000,
				attempts: 1,
				strategy: "fixed",
				maxDelayMs: 8000,
				jitterRatio: 0,
			};

			// Should always return exact delay
			expect(computeRestartDelay(policy, () => 0.123)).toBe(1000);
			expect(computeRestartDelay(policy, () => 0.999)).toBe(1000);
		});
	});
});

describe("shouldNotifyRestart", () => {
	it("returns false when nextNotifyAttempt is undefined", () => {
		const policy: RestartPolicy = {
			maxAttempts: 5,
			delayMs: 1000,
			attempts: 3,
			strategy: "fixed",
			maxDelayMs: 8000,
			jitterRatio: 0,
		};
		expect(shouldNotifyRestart(policy)).toBe(false);
	});

	it("returns false when attempts < nextNotifyAttempt", () => {
		const policy: RestartPolicy = {
			maxAttempts: 5,
			delayMs: 1000,
			attempts: 1,
			strategy: "fixed",
			maxDelayMs: 8000,
			jitterRatio: 0,
			nextNotifyAttempt: 2,
		};
		expect(shouldNotifyRestart(policy)).toBe(false);
	});

	it("returns true when attempts >= nextNotifyAttempt", () => {
		const policy: RestartPolicy = {
			maxAttempts: 5,
			delayMs: 1000,
			attempts: 2,
			strategy: "fixed",
			maxDelayMs: 8000,
			jitterRatio: 0,
			nextNotifyAttempt: 2,
		};
		expect(shouldNotifyRestart(policy)).toBe(true);

		policy.attempts = 3;
		expect(shouldNotifyRestart(policy)).toBe(true);
	});
});

describe("updateNotifyThreshold", () => {
	it("doubles the threshold", () => {
		const policy: RestartPolicy = {
			maxAttempts: 10,
			delayMs: 1000,
			attempts: 2,
			strategy: "fixed",
			maxDelayMs: 8000,
			jitterRatio: 0,
			nextNotifyAttempt: 2,
		};

		updateNotifyThreshold(policy);
		expect(policy.nextNotifyAttempt).toBe(4);

		updateNotifyThreshold(policy);
		expect(policy.nextNotifyAttempt).toBe(8);
	});

	it("does nothing when nextNotifyAttempt is undefined", () => {
		const policy: RestartPolicy = {
			maxAttempts: 5,
			delayMs: 1000,
			attempts: 2,
			strategy: "fixed",
			maxDelayMs: 8000,
			jitterRatio: 0,
		};

		updateNotifyThreshold(policy);
		expect(policy.nextNotifyAttempt).toBeUndefined();
	});
});
