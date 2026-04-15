import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CircuitBreaker,
	CircuitOpenError,
	createCircuitBreaker,
	createSlackCircuitBreaker,
} from "../src/utils/circuit-breaker.js";

describe("CircuitBreaker", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("initial state", () => {
		it("starts in CLOSED state", () => {
			const breaker = new CircuitBreaker();
			expect(breaker.getState()).toBe("CLOSED");
		});

		it("allows requests when closed", () => {
			const breaker = new CircuitBreaker();
			expect(breaker.isAllowingRequests()).toBe(true);
		});

		it("initializes stats to zero", () => {
			const breaker = new CircuitBreaker();
			const stats = breaker.getStats();
			expect(stats.failures).toBe(0);
			expect(stats.successes).toBe(0);
			expect(stats.totalCalls).toBe(0);
		});
	});

	describe("execute with successful calls", () => {
		it("passes through successful calls", async () => {
			const breaker = new CircuitBreaker();

			const result = await breaker.execute(async () => "success");

			expect(result).toBe("success");
		});

		it("tracks successful calls", async () => {
			const breaker = new CircuitBreaker();

			await breaker.execute(async () => "ok");
			await breaker.execute(async () => "ok");

			const stats = breaker.getStats();
			expect(stats.totalCalls).toBe(2);
			expect(stats.totalSuccesses).toBe(2);
		});

		it("resets failure count on success", async () => {
			const breaker = new CircuitBreaker({ failureThreshold: 3 });

			// Two failures
			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});
			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});

			// One success resets
			await breaker.execute(async () => "ok");

			const stats = breaker.getStats();
			expect(stats.failures).toBe(0);
		});
	});

	describe("failure tracking and opening", () => {
		it("opens after reaching failure threshold", async () => {
			const breaker = new CircuitBreaker({ failureThreshold: 3 });

			for (let i = 0; i < 3; i++) {
				await breaker
					.execute(async () => {
						throw new Error("fail");
					})
					.catch(() => {});
			}

			expect(breaker.getState()).toBe("OPEN");
		});

		it("throws CircuitOpenError when open", async () => {
			const breaker = new CircuitBreaker({ failureThreshold: 1, name: "test" });

			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});

			await expect(breaker.execute(async () => "ok")).rejects.toThrow(
				CircuitOpenError,
			);
		});

		it("CircuitOpenError contains circuit info", async () => {
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				name: "myService",
				resetTimeoutMs: 5000,
			});

			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});

			try {
				await breaker.execute(async () => "ok");
			} catch (e) {
				expect(e).toBeInstanceOf(CircuitOpenError);
				expect((e as CircuitOpenError).circuitName).toBe("myService");
				expect((e as CircuitOpenError).resetTimeoutMs).toBe(5000);
			}
		});

		it("tracks failures correctly", async () => {
			const breaker = new CircuitBreaker({ failureThreshold: 5 });

			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});
			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});

			const stats = breaker.getStats();
			expect(stats.failures).toBe(2);
			expect(stats.totalFailures).toBe(2);
		});
	});

	describe("half-open and recovery", () => {
		it("transitions to HALF_OPEN after reset timeout", async () => {
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 1000,
			});

			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});
			expect(breaker.getState()).toBe("OPEN");

			vi.advanceTimersByTime(1000);

			// Next request should be allowed and circuit transitions
			await breaker.execute(async () => "ok");
			expect(breaker.getState()).toBe("CLOSED");
		});

		it("closes after success threshold in half-open", async () => {
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				successThreshold: 2,
				resetTimeoutMs: 1000,
			});

			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});
			vi.advanceTimersByTime(1000);

			// First success keeps half-open
			await breaker.execute(async () => "ok");
			expect(breaker.getState()).toBe("HALF_OPEN");

			// Second success closes
			await breaker.execute(async () => "ok");
			expect(breaker.getState()).toBe("CLOSED");
		});

		it("re-opens on failure in half-open", async () => {
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 1000,
			});

			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});
			vi.advanceTimersByTime(1000);

			await breaker
				.execute(async () => {
					throw new Error("still failing");
				})
				.catch(() => {});

			expect(breaker.getState()).toBe("OPEN");
		});
	});

	describe("shouldTrip configuration", () => {
		it("only trips on matching errors", async () => {
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				shouldTrip: (e) => (e as Error).message.includes("fatal"),
			});

			// Non-fatal error doesn't trip
			await breaker
				.execute(async () => {
					throw new Error("minor issue");
				})
				.catch(() => {});
			expect(breaker.getState()).toBe("CLOSED");

			// Fatal error trips
			await breaker
				.execute(async () => {
					throw new Error("fatal error");
				})
				.catch(() => {});
			expect(breaker.getState()).toBe("OPEN");
		});
	});

	describe("state change callback", () => {
		it("calls onStateChange when transitioning", async () => {
			const transitions: Array<{ from: string; to: string }> = [];
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 1000,
				onStateChange: (from, to) => transitions.push({ from, to }),
			});

			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});
			vi.advanceTimersByTime(1000);
			await breaker.execute(async () => "ok");

			expect(transitions).toEqual([
				{ from: "CLOSED", to: "OPEN" },
				{ from: "OPEN", to: "HALF_OPEN" },
				{ from: "HALF_OPEN", to: "CLOSED" },
			]);
		});
	});

	describe("manual controls", () => {
		it("trip() opens the circuit", () => {
			const breaker = new CircuitBreaker();

			breaker.trip();

			expect(breaker.getState()).toBe("OPEN");
		});

		it("reset() closes the circuit", async () => {
			const breaker = new CircuitBreaker({ failureThreshold: 1 });

			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});
			expect(breaker.getState()).toBe("OPEN");

			breaker.reset();
			expect(breaker.getState()).toBe("CLOSED");
		});

		it("halfOpen() sets half-open state", () => {
			const breaker = new CircuitBreaker();

			breaker.halfOpen();

			expect(breaker.getState()).toBe("HALF_OPEN");
		});
	});

	describe("isAllowingRequests", () => {
		it("returns true when closed", () => {
			const breaker = new CircuitBreaker();
			expect(breaker.isAllowingRequests()).toBe(true);
		});

		it("returns true when half-open", () => {
			const breaker = new CircuitBreaker();
			breaker.halfOpen();
			expect(breaker.isAllowingRequests()).toBe(true);
		});

		it("returns false when open and timeout not elapsed", async () => {
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 1000,
			});

			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});

			expect(breaker.isAllowingRequests()).toBe(false);
		});

		it("returns true when open but timeout elapsed", async () => {
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 1000,
			});

			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});
			vi.advanceTimersByTime(1000);

			expect(breaker.isAllowingRequests()).toBe(true);
		});
	});
});

describe("createCircuitBreaker", () => {
	it("creates breaker with defaults", () => {
		const breaker = createCircuitBreaker();
		expect(breaker).toBeInstanceOf(CircuitBreaker);
		expect(breaker.getState()).toBe("CLOSED");
	});

	it("creates breaker with custom config", () => {
		const breaker = createCircuitBreaker({
			name: "custom",
			failureThreshold: 10,
		});
		expect(breaker).toBeInstanceOf(CircuitBreaker);
	});
});

describe("createSlackCircuitBreaker", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("creates breaker for Slack API", () => {
		const breaker = createSlackCircuitBreaker("slack");
		expect(breaker).toBeInstanceOf(CircuitBreaker);
	});

	it("trips on rate limit errors", async () => {
		const breaker = createSlackCircuitBreaker("slack", { failureThreshold: 1 });

		await breaker
			.execute(async () => {
				throw new Error("Rate limit exceeded: 429");
			})
			.catch(() => {});

		expect(breaker.getState()).toBe("OPEN");
	});

	it("trips on server errors", async () => {
		const breaker = createSlackCircuitBreaker("slack", { failureThreshold: 1 });

		await breaker
			.execute(async () => {
				throw new Error("Server error: 503 Service Unavailable");
			})
			.catch(() => {});

		expect(breaker.getState()).toBe("OPEN");
	});

	it("trips on network errors", async () => {
		const breaker = createSlackCircuitBreaker("slack", { failureThreshold: 1 });

		await breaker
			.execute(async () => {
				throw new Error("ECONNRESET");
			})
			.catch(() => {});

		expect(breaker.getState()).toBe("OPEN");
	});

	it("does not trip on validation errors", async () => {
		const breaker = createSlackCircuitBreaker("slack", { failureThreshold: 1 });

		await breaker
			.execute(async () => {
				throw new Error("Invalid channel ID");
			})
			.catch(() => {});

		expect(breaker.getState()).toBe("CLOSED");
	});

	it("does not trip on auth errors", async () => {
		const breaker = createSlackCircuitBreaker("slack", { failureThreshold: 1 });

		await breaker
			.execute(async () => {
				throw new Error("not_authed");
			})
			.catch(() => {});

		expect(breaker.getState()).toBe("CLOSED");
	});
});
