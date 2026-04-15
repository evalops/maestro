/**
 * TDD tests for restart policy — verify backoff, jitter,
 * and attempt tracking for background task restarts.
 */
import { describe, expect, it } from "vitest";

import {
	canRestart,
	computeRestartDelay,
	createRestartPolicy,
	incrementAttempts,
} from "../../../packages/core/src/index.js";

describe("RestartPolicy", () => {
	describe("createRestartPolicy", () => {
		it("creates a fixed strategy policy", () => {
			const policy = createRestartPolicy({
				maxAttempts: 3,
				delayMs: 1000,
				strategy: "fixed",
			});
			expect(policy).toBeDefined();
		});

		it("creates an exponential strategy policy", () => {
			const policy = createRestartPolicy({
				maxAttempts: 5,
				delayMs: 100,
				strategy: "exponential",
			});
			expect(policy).toBeDefined();
		});
	});

	describe("canRestart", () => {
		it("allows restart when attempts remain", () => {
			const policy = createRestartPolicy({
				maxAttempts: 3,
				delayMs: 100,
				strategy: "fixed",
			});
			expect(canRestart(policy!)).toBe(true);
		});

		it("denies restart after max attempts", () => {
			const policy = createRestartPolicy({
				maxAttempts: 2,
				delayMs: 100,
				strategy: "fixed",
			});
			incrementAttempts(policy!);
			incrementAttempts(policy!);
			expect(canRestart(policy!)).toBe(false);
		});

		it("returns false for undefined policy", () => {
			expect(canRestart(undefined)).toBe(false);
		});

		it("allows exactly maxAttempts restarts", () => {
			const policy = createRestartPolicy({
				maxAttempts: 3,
				delayMs: 100,
				strategy: "fixed",
			});
			incrementAttempts(policy!); // 1
			expect(canRestart(policy!)).toBe(true);
			incrementAttempts(policy!); // 2
			expect(canRestart(policy!)).toBe(true);
			incrementAttempts(policy!); // 3
			expect(canRestart(policy!)).toBe(false);
		});
	});

	describe("computeRestartDelay — fixed strategy", () => {
		it("returns constant delay", () => {
			const policy = createRestartPolicy({
				maxAttempts: 5,
				delayMs: 500,
				strategy: "fixed",
			});
			incrementAttempts(policy!);
			const d1 = computeRestartDelay(policy!);
			incrementAttempts(policy!);
			const d2 = computeRestartDelay(policy!);
			// Fixed strategy: delays should be roughly the same (with jitter)
			expect(Math.abs(d1 - d2)).toBeLessThan(d1); // within 100% variance from jitter
		});
	});

	describe("computeRestartDelay — exponential strategy", () => {
		it("increases delay with each attempt", () => {
			const policy = createRestartPolicy({
				maxAttempts: 5,
				delayMs: 100,
				strategy: "exponential",
				jitterRatio: 0, // disable jitter for predictable testing
			});
			incrementAttempts(policy!);
			const d1 = computeRestartDelay(policy!);
			incrementAttempts(policy!);
			const d2 = computeRestartDelay(policy!);
			incrementAttempts(policy!);
			const d3 = computeRestartDelay(policy!);
			// Exponential: each delay should be roughly 2x the previous
			expect(d2).toBeGreaterThan(d1);
			expect(d3).toBeGreaterThan(d2);
		});

		it("caps delay at maxDelayMs", () => {
			const policy = createRestartPolicy({
				maxAttempts: 10,
				delayMs: 100,
				strategy: "exponential",
				maxDelayMs: 500,
				jitterRatio: 0,
			});
			// Many attempts to hit the cap
			for (let i = 0; i < 8; i++) {
				incrementAttempts(policy!);
			}
			const delay = computeRestartDelay(policy!);
			expect(delay).toBeLessThanOrEqual(500);
		});
	});

	describe("incrementAttempts", () => {
		it("increments the attempt counter", () => {
			const policy = createRestartPolicy({
				maxAttempts: 5,
				delayMs: 100,
				strategy: "fixed",
			});
			expect(policy!.attempts).toBe(0);
			incrementAttempts(policy!);
			expect(policy!.attempts).toBe(1);
			incrementAttempts(policy!);
			expect(policy!.attempts).toBe(2);
		});
	});
});
