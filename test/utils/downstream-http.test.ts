import { describe, expect, it, vi } from "vitest";
import { fetchDownstream } from "../../src/utils/downstream-http.js";
import type { DownstreamHttpError } from "../../src/utils/downstream-http.js";

describe("fetchDownstream", () => {
	it("retries retryable status responses and honors Retry-After-Ms", async () => {
		let calls = 0;
		const delays: number[] = [];
		const fetchImpl: typeof fetch = async () => {
			calls += 1;
			if (calls === 1) {
				return new Response("try again", {
					status: 503,
					headers: { "Retry-After-Ms": "75" },
				});
			}
			return new Response("ok", { status: 200 });
		};

		const response = await fetchDownstream(
			"http://service.test/resolve",
			{ method: "GET" },
			{
				serviceName: "test service",
				failureMode: "optional",
				timeoutMs: 1_000,
				maxAttempts: 2,
				fetchImpl,
				sleepMs: async (delayMs) => {
					delays.push(delayMs);
				},
			},
		);

		expect(await response.text()).toBe("ok");
		expect(calls).toBe(2);
		expect(delays).toEqual([75]);
	});

	it("does not retry non-retryable status responses", async () => {
		let calls = 0;
		const fetchImpl: typeof fetch = async () => {
			calls += 1;
			return new Response("bad request", { status: 400 });
		};

		const response = await fetchDownstream(
			"http://service.test/resolve",
			{ method: "GET" },
			{
				serviceName: "test service",
				failureMode: "optional",
				timeoutMs: 1_000,
				maxAttempts: 3,
				fetchImpl,
				sleepMs: async () => undefined,
			},
		);

		expect(response.status).toBe(400);
		expect(calls).toBe(1);
	});

	it("wraps request timeouts with downstream failure metadata", async () => {
		vi.useFakeTimers();
		try {
			const fetchImpl: typeof fetch = async (_input, init) =>
				new Promise<Response>((_, reject) => {
					init?.signal?.addEventListener("abort", () => {
						const error = new Error("aborted");
						error.name = "AbortError";
						reject(error);
					});
				});

			const request = fetchDownstream(
				"http://service.test/resolve",
				{ method: "GET" },
				{
					serviceName: "test service",
					failureMode: "required",
					timeoutMs: 5,
					maxAttempts: 1,
					fetchImpl,
				},
			);
			const assertion = expect(request).rejects.toMatchObject({
				name: "DownstreamHttpError",
				serviceName: "test service",
				failureMode: "required",
				retryable: true,
				timeoutMs: 5,
			} satisfies Partial<DownstreamHttpError>);

			await vi.advanceTimersByTimeAsync(10);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});
});
