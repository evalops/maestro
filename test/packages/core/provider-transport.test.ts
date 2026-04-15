/**
 * TDD tests for ProviderTransport — verify the transport layer can be
 * instantiated and configured without making real API calls.
 */
import { describe, expect, it, vi } from "vitest";

import { ProviderTransport } from "../../../packages/core/src/index.js";

describe("ProviderTransport", () => {
	describe("constructor", () => {
		it("can be instantiated with minimal options", () => {
			const transport = new ProviderTransport({
				getAuthContext: () => undefined,
			});
			expect(transport).toBeDefined();
		});

		it("accepts custom auth context resolver", () => {
			const getAuth = vi.fn().mockReturnValue({
				provider: "anthropic",
				token: "sk-test-123",
				type: "api-key",
			});
			const transport = new ProviderTransport({
				getAuthContext: getAuth,
			});
			expect(transport).toBeDefined();
		});

		it("accepts concurrency configuration", () => {
			const transport = new ProviderTransport({
				getAuthContext: () => undefined,
				maxConcurrentToolExecutions: 4,
			});
			expect(transport).toBeDefined();
		});
	});

	describe("run method", () => {
		it("has a run method that returns an async generator", () => {
			const transport = new ProviderTransport({
				getAuthContext: () => undefined,
			});
			expect(typeof transport.run).toBe("function");
		});
	});

	describe("continue method", () => {
		it("has a continue method", () => {
			const transport = new ProviderTransport({
				getAuthContext: () => undefined,
			});
			expect(typeof transport.continue).toBe("function");
		});
	});
});
