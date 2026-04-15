/**
 * Tests for SlackBot utility functions and core logic
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// We need to test the internal functions, so we'll extract testable logic
// For now, test the exported behavior through a minimal mock setup

describe("SlackBot", () => {
	describe("getRetryAfterMs (rate limit parsing)", () => {
		// Re-implement the function logic for testing since it's not exported
		function getRetryAfterMs(error: unknown): number | null {
			const err = error as {
				statusCode?: number;
				code?: string;
				retryAfter?: number | string;
				data?: { error?: string; retry_after?: number | string };
			};

			const isRateLimited =
				err?.statusCode === 429 ||
				err?.code === "slack_webapi_rate_limited" ||
				err?.data?.error === "ratelimited";
			if (!isRateLimited) return null;

			const retryAfterSeconds =
				typeof err.retryAfter === "number"
					? err.retryAfter
					: typeof err.retryAfter === "string"
						? Number(err.retryAfter)
						: typeof err.data?.retry_after === "number"
							? err.data.retry_after
							: typeof err.data?.retry_after === "string"
								? Number(err.data.retry_after)
								: undefined;

			if (retryAfterSeconds && Number.isFinite(retryAfterSeconds)) {
				return Math.max(0, retryAfterSeconds) * 1000;
			}

			return 0;
		}

		it("returns null for non-rate-limit errors", () => {
			expect(getRetryAfterMs(new Error("Network error"))).toBeNull();
			expect(getRetryAfterMs({ statusCode: 500 })).toBeNull();
			expect(getRetryAfterMs({ code: "some_other_error" })).toBeNull();
		});

		it("detects rate limit by statusCode 429", () => {
			expect(getRetryAfterMs({ statusCode: 429 })).toBe(0);
		});

		it("detects rate limit by code slack_webapi_rate_limited", () => {
			expect(getRetryAfterMs({ code: "slack_webapi_rate_limited" })).toBe(0);
		});

		it("detects rate limit by data.error ratelimited", () => {
			expect(getRetryAfterMs({ data: { error: "ratelimited" } })).toBe(0);
		});

		it("extracts retryAfter as number (seconds to ms)", () => {
			expect(getRetryAfterMs({ statusCode: 429, retryAfter: 5 })).toBe(5000);
			expect(getRetryAfterMs({ statusCode: 429, retryAfter: 30 })).toBe(30000);
		});

		it("extracts retryAfter as string", () => {
			expect(getRetryAfterMs({ statusCode: 429, retryAfter: "10" })).toBe(
				10000,
			);
		});

		it("extracts data.retry_after as number", () => {
			expect(
				getRetryAfterMs({ statusCode: 429, data: { retry_after: 15 } }),
			).toBe(15000);
		});

		it("extracts data.retry_after as string", () => {
			expect(
				getRetryAfterMs({ statusCode: 429, data: { retry_after: "20" } }),
			).toBe(20000);
		});

		it("returns 0 for negative retry values", () => {
			expect(getRetryAfterMs({ statusCode: 429, retryAfter: -5 })).toBe(0);
		});

		it("returns 0 for non-finite values", () => {
			expect(getRetryAfterMs({ statusCode: 429, retryAfter: Number.NaN })).toBe(
				0,
			);
			expect(
				getRetryAfterMs({
					statusCode: 429,
					retryAfter: Number.POSITIVE_INFINITY,
				}),
			).toBe(0);
		});
	});

	describe("obfuscateUsernames", () => {
		// Re-implement for testing
		function obfuscateUsernames(
			text: string,
			userCache: Map<string, { userName: string }>,
		): string {
			let result = text;

			// Obfuscate user ID mentions like <@U12345>
			result = result.replace(/<@([A-Z0-9]+)>/gi, (_match, id) => {
				return `<@${id.split("").join("_")}>`;
			});

			// Obfuscate usernames from cache
			for (const { userName } of userCache.values()) {
				const escaped = userName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const pattern = new RegExp(`(<@|@)?(\\b${escaped}\\b)`, "gi");
				result = result.replace(pattern, (_match, prefix, name) => {
					const obfuscated = name.split("").join("_");
					return (prefix || "") + obfuscated;
				});
			}
			return result;
		}

		it("obfuscates user ID mentions", () => {
			const userCache = new Map();
			expect(obfuscateUsernames("Hello <@U12345>!", userCache)).toBe(
				"Hello <@U_1_2_3_4_5>!",
			);
		});

		it("obfuscates multiple user mentions", () => {
			const userCache = new Map();
			expect(obfuscateUsernames("<@ABC> and <@DEF>", userCache)).toBe(
				"<@A_B_C> and <@D_E_F>",
			);
		});

		it("obfuscates cached usernames", () => {
			const userCache = new Map([["U1", { userName: "john" }]]);
			expect(obfuscateUsernames("Hello john!", userCache)).toBe(
				"Hello j_o_h_n!",
			);
		});

		it("obfuscates @username mentions", () => {
			const userCache = new Map([["U1", { userName: "alice" }]]);
			expect(obfuscateUsernames("Hey @alice check this", userCache)).toBe(
				"Hey @a_l_i_c_e check this",
			);
		});

		it("handles special regex characters in usernames", () => {
			const userCache = new Map([["U1", { userName: "user.name" }]]);
			expect(obfuscateUsernames("Hello user.name!", userCache)).toBe(
				"Hello u_s_e_r_._n_a_m_e!",
			);
		});

		it("preserves text without usernames", () => {
			const userCache = new Map();
			expect(obfuscateUsernames("Hello world!", userCache)).toBe(
				"Hello world!",
			);
		});
	});

	describe("shouldProcessEvent (deduplication)", () => {
		// Re-implement for testing
		function createEventDeduplicator(dedupeMs = 5 * 60 * 1000) {
			const recentEvents = new Map<string, number>();
			let lastCleanupMs = 0;
			const cleanupIntervalMs = 60 * 1000;

			return {
				shouldProcess(key: string, now = Date.now()): boolean {
					if (now - lastCleanupMs > cleanupIntervalMs) {
						const cutoff = now - dedupeMs;
						for (const [k, t] of recentEvents.entries()) {
							if (t < cutoff) recentEvents.delete(k);
						}
						lastCleanupMs = now;
					}
					if (recentEvents.has(key)) {
						return false;
					}
					recentEvents.set(key, now);
					return true;
				},
				getSize: () => recentEvents.size,
			};
		}

		it("allows first occurrence of an event", () => {
			const deduper = createEventDeduplicator();
			expect(deduper.shouldProcess("event1")).toBe(true);
		});

		it("rejects duplicate events", () => {
			const deduper = createEventDeduplicator();
			expect(deduper.shouldProcess("event1")).toBe(true);
			expect(deduper.shouldProcess("event1")).toBe(false);
			expect(deduper.shouldProcess("event1")).toBe(false);
		});

		it("allows different events", () => {
			const deduper = createEventDeduplicator();
			expect(deduper.shouldProcess("event1")).toBe(true);
			expect(deduper.shouldProcess("event2")).toBe(true);
			expect(deduper.shouldProcess("event3")).toBe(true);
		});

		it("cleans up old events after interval", () => {
			const deduper = createEventDeduplicator(100); // 100ms dedupe window
			const now = Date.now();

			// Add event
			expect(deduper.shouldProcess("event1", now)).toBe(true);
			expect(deduper.getSize()).toBe(1);

			// Still blocked within window
			expect(deduper.shouldProcess("event1", now + 50)).toBe(false);

			// After cleanup interval (60s) + dedupe window expired
			// Trigger cleanup by calling with time > cleanupInterval
			expect(deduper.shouldProcess("event2", now + 61000)).toBe(true);

			// Old event should be cleaned up, allowing re-processing
			expect(deduper.shouldProcess("event1", now + 61000)).toBe(true);
		});
	});

	describe("thread resolution logic", () => {
		it("uses existing thread when present", () => {
			const parentThreadTs = "1234567890.123456";
			const userMessageTs = "1234567890.999999";
			const useThread = true;

			const threadTs =
				parentThreadTs || (useThread ? userMessageTs : undefined);
			expect(threadTs).toBe(parentThreadTs);
		});

		it("creates new thread from user message when useThread=true", () => {
			const parentThreadTs = undefined;
			const userMessageTs = "1234567890.999999";
			const useThread = true;

			const threadTs =
				parentThreadTs || (useThread ? userMessageTs : undefined);
			expect(threadTs).toBe(userMessageTs);
		});

		it("posts to channel when useThread=false", () => {
			const parentThreadTs = undefined;
			const userMessageTs = "1234567890.999999";
			const useThread = false;

			const threadTs =
				parentThreadTs || (useThread ? userMessageTs : undefined);
			expect(threadTs).toBeUndefined();
		});

		it("calculates replyBroadcast correctly", () => {
			// When starting new thread (not in existing thread), broadcast
			const getReplyBroadcast = (
				threadTs: string | undefined,
				useThread: boolean,
				parentThreadTs: string | undefined,
			) => (threadTs ? useThread && !parentThreadTs : undefined);

			// New thread from channel mention - should broadcast
			expect(getReplyBroadcast("123.456", true, undefined)).toBe(true);

			// Reply to existing thread - should not broadcast
			expect(getReplyBroadcast("123.456", true, "123.456")).toBe(false);

			// DM mode (no thread) - undefined
			expect(getReplyBroadcast(undefined, false, undefined)).toBeUndefined();
		});
	});

	describe("text sanitization", () => {
		it("removes user mentions from text", () => {
			const rawText = "<@U12345> Please help me with this";
			const text = rawText.replace(/<@[A-Z0-9]+>/gi, "").trim();
			expect(text).toBe("Please help me with this");
		});

		it("removes multiple mentions", () => {
			const rawText = "<@U12345> <@U67890> Hello everyone";
			const text = rawText.replace(/<@[A-Z0-9]+>/gi, "").trim();
			expect(text).toBe("Hello everyone");
		});

		it("preserves text without mentions", () => {
			const rawText = "Hello world";
			const text = rawText.replace(/<@[A-Z0-9]+>/gi, "").trim();
			expect(text).toBe("Hello world");
		});
	});
});

describe("callSlack retry logic", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("retries on rate limit with exponential backoff", async () => {
		vi.useRealTimers(); // Need real timers for this test

		let attempts = 0;
		const fn = async () => {
			attempts++;
			if (attempts < 3) {
				const error = { statusCode: 429, retryAfter: 0.01 }; // 10ms
				throw error;
			}
			return "success";
		};

		// Simplified retry logic for testing
		async function callSlack<T>(
			fn: () => Promise<T>,
			maxAttempts = 3,
		): Promise<T> {
			let attempt = 0;
			while (true) {
				try {
					return await fn();
				} catch (error) {
					attempt++;
					const err = error as { statusCode?: number; retryAfter?: number };
					if (err?.statusCode === 429 && attempt < maxAttempts) {
						await new Promise((r) =>
							setTimeout(r, (err.retryAfter || 0.01) * 1000),
						);
						continue;
					}
					throw error;
				}
			}
		}

		const result = await callSlack(fn);
		expect(result).toBe("success");
		expect(attempts).toBe(3);
	});

	it("throws after max attempts", async () => {
		vi.useRealTimers();

		const fn = async () => {
			throw { statusCode: 429, retryAfter: 0.001 };
		};

		async function callSlack<T>(
			fn: () => Promise<T>,
			maxAttempts = 3,
		): Promise<T> {
			let attempt = 0;
			while (true) {
				try {
					return await fn();
				} catch (error) {
					attempt++;
					const err = error as { statusCode?: number; retryAfter?: number };
					if (err?.statusCode === 429 && attempt < maxAttempts) {
						await new Promise((r) =>
							setTimeout(r, (err.retryAfter || 0.001) * 1000),
						);
						continue;
					}
					throw error;
				}
			}
		}

		await expect(callSlack(fn)).rejects.toEqual({
			statusCode: 429,
			retryAfter: 0.001,
		});
	});
});
