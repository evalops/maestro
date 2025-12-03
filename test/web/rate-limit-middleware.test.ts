import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { compose } from "../../src/web/middleware.js";
import { RateLimiter, TieredRateLimiter } from "../../src/web/rate-limiter.js";
import { createRateLimitMiddleware } from "../../src/web/server-middlewares.js";

interface MockRequest {
	url: string;
	socket: { remoteAddress: string };
	headers: Record<string, string>;
}

interface MockResponse {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
	headersSent: boolean;
	writableEnded: boolean;
	writeHead(status: number, headers?: Record<string, string>): void;
	setHeader(name: string, value: string): void;
	end(chunk?: string): void;
}

function makeReq(overrides: Partial<MockRequest> = {}): IncomingMessage {
	return {
		url: "/api/test",
		socket: { remoteAddress: "192.168.1.1" },
		headers: {},
		...overrides,
	} as unknown as IncomingMessage;
}

function makeRes(): MockResponse & ServerResponse {
	const res: MockResponse = {
		statusCode: 200,
		headers: {} as Record<string, string>,
		body: "",
		headersSent: false,
		writableEnded: false,
		writeHead(status: number, headers?: Record<string, string>) {
			this.statusCode = status;
			Object.assign(this.headers, headers);
			this.headersSent = true;
		},
		setHeader(name: string, value: string) {
			this.headers[name] = value;
		},
		end(chunk?: string) {
			if (chunk) this.body = chunk;
			this.writableEnded = true;
		},
	};
	return res as MockResponse & ServerResponse;
}

const corsHeaders = { "Access-Control-Allow-Origin": "*" };

describe("createRateLimitMiddleware", () => {
	describe("IP extraction without trustProxy", () => {
		it("uses socket.remoteAddress when trustProxy is false", () => {
			const limiter = new RateLimiter({ windowMs: 60000, max: 100 });
			const middleware = createRateLimitMiddleware(limiter, corsHeaders, false);

			const req = makeReq({
				headers: { "x-forwarded-for": "10.0.0.1, 10.0.0.2" },
			});
			const res = makeRes();
			let nextCalled = false;

			middleware(req, res, () => {
				nextCalled = true;
			});

			expect(nextCalled).toBe(true);
			expect(res.headers["X-RateLimit-Remaining"]).toBeDefined();
		});

		it("ignores X-Forwarded-For when trustProxy is false", () => {
			const limiter = new RateLimiter({ windowMs: 60000, max: 2 });
			const middleware = createRateLimitMiddleware(limiter, corsHeaders, false);

			// First request from "attacker" spoofing X-Forwarded-For
			const req1 = makeReq({
				socket: { remoteAddress: "192.168.1.100" },
				headers: { "x-forwarded-for": "1.2.3.4" },
			});
			middleware(req1, makeRes(), () => {});

			// Second request from same socket but different spoofed IP
			const req2 = makeReq({
				socket: { remoteAddress: "192.168.1.100" },
				headers: { "x-forwarded-for": "5.6.7.8" },
			});
			middleware(req2, makeRes(), () => {});

			// Third request should be rate limited (same socket IP)
			const req3 = makeReq({
				socket: { remoteAddress: "192.168.1.100" },
				headers: { "x-forwarded-for": "9.10.11.12" },
			});
			const res3 = makeRes();
			let nextCalled = false;
			middleware(req3, res3, () => {
				nextCalled = true;
			});

			expect(nextCalled).toBe(false);
			expect(res3.statusCode).toBe(429);
		});
	});

	describe("IP extraction with trustProxy", () => {
		it("uses X-Forwarded-For when trustProxy is true", () => {
			const limiter = new RateLimiter({ windowMs: 60000, max: 100 });
			const middleware = createRateLimitMiddleware(
				limiter,
				corsHeaders,
				true,
				1,
			);

			const req = makeReq({
				socket: { remoteAddress: "127.0.0.1" },
				headers: { "x-forwarded-for": "203.0.113.50" },
			});
			const res = makeRes();
			let nextCalled = false;

			middleware(req, res, () => {
				nextCalled = true;
			});

			expect(nextCalled).toBe(true);
		});

		it("extracts client IP with 1 proxy hop", () => {
			const limiter = new RateLimiter({ windowMs: 60000, max: 2 });

			// With 1 hop (nginx), we skip 1 IP from the right
			// "client, nginx" -> targetIndex = max(0, 2 - 1 - 1) = 0 -> "client"
			const middleware = createRateLimitMiddleware(
				limiter,
				corsHeaders,
				true,
				1,
			);

			// Make 2 requests with same "nginx" IP but different "client" IPs
			// These should be tracked separately since we use the client IP
			const req1 = makeReq({
				socket: { remoteAddress: "127.0.0.1" },
				headers: { "x-forwarded-for": "client1, nginx" },
			});
			middleware(req1, makeRes(), () => {});

			const req2 = makeReq({
				socket: { remoteAddress: "127.0.0.1" },
				headers: { "x-forwarded-for": "client2, nginx" },
			});
			middleware(req2, makeRes(), () => {});

			// Third request from client1 should still work (different bucket from client2)
			const req3 = makeReq({
				socket: { remoteAddress: "127.0.0.1" },
				headers: { "x-forwarded-for": "client1, nginx" },
			});
			const res3 = makeRes();
			let nextCalled = false;
			middleware(req3, res3, () => {
				nextCalled = true;
			});

			// client1 only has 1 request, so should still be allowed
			expect(nextCalled).toBe(true);
		});

		it("extracts client IP with 2 proxy hops", () => {
			const limiter = new RateLimiter({ windowMs: 60000, max: 2 });

			// With 2 hops (CDN + nginx), we skip 2 IPs from the right
			// "client, cdn, nginx" -> targetIndex = max(0, 3 - 2 - 1) = 0 -> "client"
			const middleware = createRateLimitMiddleware(
				limiter,
				corsHeaders,
				true,
				2,
			);

			const req1 = makeReq({
				socket: { remoteAddress: "127.0.0.1" },
				headers: { "x-forwarded-for": "real-client, cdn-ip, nginx-ip" },
			});
			middleware(req1, makeRes(), () => {});

			const req2 = makeReq({
				socket: { remoteAddress: "127.0.0.1" },
				headers: { "x-forwarded-for": "real-client, cdn-ip, nginx-ip" },
			});
			middleware(req2, makeRes(), () => {});

			// Third request from same client should be rate limited
			const req3 = makeReq({
				socket: { remoteAddress: "127.0.0.1" },
				headers: { "x-forwarded-for": "real-client, cdn-ip, nginx-ip" },
			});
			const res3 = makeRes();
			let nextCalled = false;
			middleware(req3, res3, () => {
				nextCalled = true;
			});

			expect(nextCalled).toBe(false);
			expect(res3.statusCode).toBe(429);
		});

		it("clamps to first IP when hops exceed header length", () => {
			const limiter = new RateLimiter({ windowMs: 60000, max: 100 });

			// With 5 hops but only 2 IPs, should use index 0 (first IP)
			const middleware = createRateLimitMiddleware(
				limiter,
				corsHeaders,
				true,
				5,
			);

			const req = makeReq({
				socket: { remoteAddress: "127.0.0.1" },
				headers: { "x-forwarded-for": "client, proxy" },
			});
			const res = makeRes();
			let nextCalled = false;

			middleware(req, res, () => {
				nextCalled = true;
			});

			expect(nextCalled).toBe(true);
		});

		it("handles empty X-Forwarded-For gracefully", () => {
			const limiter = new RateLimiter({ windowMs: 60000, max: 100 });
			const middleware = createRateLimitMiddleware(
				limiter,
				corsHeaders,
				true,
				1,
			);

			const req = makeReq({
				socket: { remoteAddress: "192.168.1.1" },
				headers: { "x-forwarded-for": "" },
			});
			const res = makeRes();
			let nextCalled = false;

			middleware(req, res, () => {
				nextCalled = true;
			});

			expect(nextCalled).toBe(true);
		});

		it("handles whitespace-only X-Forwarded-For gracefully", () => {
			const limiter = new RateLimiter({ windowMs: 60000, max: 100 });
			const middleware = createRateLimitMiddleware(
				limiter,
				corsHeaders,
				true,
				1,
			);

			const req = makeReq({
				socket: { remoteAddress: "192.168.1.1" },
				headers: { "x-forwarded-for": "  ,  ,  " },
			});
			const res = makeRes();
			let nextCalled = false;

			middleware(req, res, () => {
				nextCalled = true;
			});

			expect(nextCalled).toBe(true);
		});
	});

	describe("IPv6 normalization", () => {
		it("normalizes IPv4-mapped IPv6 addresses", () => {
			const limiter = new RateLimiter({ windowMs: 60000, max: 2 });
			const middleware = createRateLimitMiddleware(limiter, corsHeaders, false);

			// Request from ::ffff:192.168.1.1
			const req1 = makeReq({
				socket: { remoteAddress: "::ffff:192.168.1.1" },
			});
			middleware(req1, makeRes(), () => {});

			// Request from plain 192.168.1.1 should share the same bucket
			const req2 = makeReq({
				socket: { remoteAddress: "192.168.1.1" },
			});
			middleware(req2, makeRes(), () => {});

			// Third request should be rate limited
			const req3 = makeReq({
				socket: { remoteAddress: "::ffff:192.168.1.1" },
			});
			const res3 = makeRes();
			let nextCalled = false;
			middleware(req3, res3, () => {
				nextCalled = true;
			});

			expect(nextCalled).toBe(false);
			expect(res3.statusCode).toBe(429);
		});
	});

	describe("non-API paths", () => {
		it("skips rate limiting for non-API paths", () => {
			const limiter = new RateLimiter({ windowMs: 60000, max: 1 });
			const middleware = createRateLimitMiddleware(limiter, corsHeaders, false);

			// Exhaust rate limit on API path
			const apiReq = makeReq({ url: "/api/test" });
			middleware(apiReq, makeRes(), () => {});

			// Static asset should still work
			const staticReq = makeReq({ url: "/static/app.js" });
			const staticRes = makeRes();
			let nextCalled = false;
			middleware(staticReq, staticRes, () => {
				nextCalled = true;
			});

			expect(nextCalled).toBe(true);
			expect(staticRes.statusCode).toBe(200);
		});

		it("skips rate limiting for /api/metrics endpoint", () => {
			const limiter = new RateLimiter({ windowMs: 60000, max: 1 });
			const middleware = createRateLimitMiddleware(limiter, corsHeaders, false);

			// Exhaust rate limit on regular API path
			const apiReq = makeReq({ url: "/api/test" });
			middleware(apiReq, makeRes(), () => {});

			// /api/metrics should still work (critical endpoint)
			const metricsReq = makeReq({ url: "/api/metrics" });
			const metricsRes = makeRes();
			let nextCalled = false;
			middleware(metricsReq, metricsRes, () => {
				nextCalled = true;
			});

			expect(nextCalled).toBe(true);
			expect(metricsRes.statusCode).toBe(200);
		});

		it("skips rate limiting for /healthz endpoint", () => {
			const limiter = new RateLimiter({ windowMs: 60000, max: 1 });
			const middleware = createRateLimitMiddleware(limiter, corsHeaders, false);

			// Exhaust rate limit on regular API path
			const apiReq = makeReq({ url: "/api/test" });
			middleware(apiReq, makeRes(), () => {});

			// /healthz should still work (critical endpoint)
			const healthReq = makeReq({ url: "/healthz" });
			const healthRes = makeRes();
			let nextCalled = false;
			middleware(healthReq, healthRes, () => {
				nextCalled = true;
			});

			expect(nextCalled).toBe(true);
			expect(healthRes.statusCode).toBe(200);
		});
	});

	describe("error handling integration", () => {
		it("middleware chain error can be caught by caller", async () => {
			const limiter = new RateLimiter({ windowMs: 60000, max: 100 });
			const errorMiddleware = async () => {
				throw new Error("Simulated middleware error");
			};

			const app = compose([
				createRateLimitMiddleware(limiter, corsHeaders, false),
				errorMiddleware,
			]);

			const req = makeReq({ url: "/api/test" });
			const res = makeRes();

			// The composed middleware should propagate the error
			await expect(app(req, res, () => {})).rejects.toThrow(
				"Simulated middleware error",
			);
		});

		it("error handling wrapper catches middleware errors", async () => {
			const limiter = new RateLimiter({ windowMs: 60000, max: 100 });
			const errorMiddleware = async () => {
				throw new Error("Simulated middleware error");
			};

			const app = compose([
				createRateLimitMiddleware(limiter, corsHeaders, false),
				errorMiddleware,
			]);

			const req = makeReq({ url: "/api/test" });
			const res = makeRes();

			// Simulate the error handling pattern used in handleRequest
			try {
				await app(req, res, () => {});
			} catch (error) {
				// Error caught - send 500 response
				if (!res.headersSent && !res.writableEnded) {
					res.writeHead(500, {
						"Content-Type": "application/json",
						...corsHeaders,
					});
					res.end(JSON.stringify({ error: "Internal server error" }));
				}
			}

			expect(res.statusCode).toBe(500);
			expect(res.body).toContain("Internal server error");
		});
	});
});

describe("TieredRateLimiter", () => {
	describe("token leak prevention", () => {
		it("does not consume global tokens when endpoint limit rejects", () => {
			const tiered = new TieredRateLimiter(
				{ windowMs: 60000, max: 100 }, // Global: 100 req/min
				{
					"/api/chat": { windowMs: 60000, max: 3 }, // Endpoint: only 3 req/min
				},
			);

			// Exhaust the endpoint limit
			for (let i = 0; i < 3; i++) {
				const result = tiered.check("192.168.1.1", "/api/chat");
				expect(result.allowed).toBe(true);
			}

			// Fourth request should be blocked by endpoint limit
			const blocked = tiered.check("192.168.1.1", "/api/chat");
			expect(blocked.allowed).toBe(false);

			// Global limit should still have ~97 tokens remaining (only 3 consumed)
			// Test by hitting a non-endpoint-limited path
			const globalResult = tiered.check("192.168.1.1", "/api/other");
			expect(globalResult.allowed).toBe(true);
			// Should have 96 remaining (100 - 3 - 1)
			expect(globalResult.remaining).toBe(96);
		});

		it("consumes tokens from both limits when both allow", () => {
			const tiered = new TieredRateLimiter(
				{ windowMs: 60000, max: 10 },
				{
					"/api/test": { windowMs: 60000, max: 5 },
				},
			);

			// First request
			const result = tiered.check("192.168.1.2", "/api/test");
			expect(result.allowed).toBe(true);

			// Check that the lower remaining is returned (from endpoint limit)
			// Endpoint: 5 - 1 = 4, Global: 10 - 1 = 9
			expect(result.remaining).toBe(4);
		});

		it("respects global limit even when endpoint limit is not exceeded", () => {
			const tiered = new TieredRateLimiter(
				{ windowMs: 60000, max: 5 }, // Very strict global
				{
					"/api/test": { windowMs: 60000, max: 100 }, // Lenient endpoint
				},
			);

			// Use up global limit
			for (let i = 0; i < 5; i++) {
				const result = tiered.check("192.168.1.3", "/api/test");
				expect(result.allowed).toBe(true);
			}

			// Should be blocked by global limit
			const blocked = tiered.check("192.168.1.3", "/api/test");
			expect(blocked.allowed).toBe(false);
		});

		it("shares bucket across sub-routes with prefix matching", () => {
			const tiered = new TieredRateLimiter(
				{ windowMs: 60000, max: 1000 },
				{
					"/api/chat": { windowMs: 60000, max: 3 }, // Only 3 requests allowed
				},
			);

			// Hit different sub-routes - they should all share the /api/chat bucket
			tiered.check("192.168.1.5", "/api/chat");
			tiered.check("192.168.1.5", "/api/chat/approval");
			tiered.check("192.168.1.5", "/api/chat/client-tool-result");

			// Fourth request to any sub-route should be blocked
			const blocked = tiered.check("192.168.1.5", "/api/chat/stream");
			expect(blocked.allowed).toBe(false);

			// But a different endpoint pattern should still work
			const tieredWithFiles = new TieredRateLimiter(
				{ windowMs: 60000, max: 1000 },
				{
					"/api/chat": { windowMs: 60000, max: 3 },
					"/api/files": { windowMs: 60000, max: 100 },
				},
			);

			// Exhaust /api/chat
			for (let i = 0; i < 3; i++) {
				tieredWithFiles.check("192.168.1.6", `/api/chat/route${i}`);
			}

			// /api/files should still work
			const filesResult = tieredWithFiles.check(
				"192.168.1.6",
				"/api/files/read",
			);
			expect(filesResult.allowed).toBe(true);
		});
	});

	describe("peek method", () => {
		it("does not consume tokens", () => {
			const limiter = new RateLimiter({ windowMs: 60000, max: 3 });

			// Peek multiple times
			for (let i = 0; i < 10; i++) {
				const result = limiter.peek("192.168.1.4");
				expect(result.allowed).toBe(true);
				expect(result.remaining).toBe(2); // Would have 2 left after consuming
			}

			// Now actually consume
			const consumed = limiter.check("192.168.1.4");
			expect(consumed.allowed).toBe(true);
			expect(consumed.remaining).toBe(2); // Still 2 remaining after first consume
		});
	});
});
