import { describe, expect, it, vi } from "vitest";
import { LspClientManager } from "../src/lsp/manager.js";
import type { RootResolver } from "../src/lsp/types.js";

describe("LspClientManager root resolver", () => {
	it("should await async root resolver", async () => {
		const manager = new LspClientManager({ rootResolverTimeoutMs: 1000 });
		const resolver = vi.fn<RootResolver>(async (file: string) => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return "/tmp/root";
		});

		manager.configureRootResolver(resolver);

		const file = "/project/src/file.ts";

		const resolved = await manager.resolveRootSafe(resolver, file, "test");

		expect(resolved).toBe("/tmp/root");
		expect(resolver).toHaveBeenCalledWith(file);
	});

	it("should handle resolver timeout", async () => {
		const manager = new LspClientManager({ rootResolverTimeoutMs: 5 });
		const resolver = vi.fn<RootResolver>(
			async (file: string) =>
				new Promise((resolve) => setTimeout(() => resolve("/tmp/slow"), 20)),
		);

		const result = await manager.resolveRootSafe(
			resolver,
			"/project/slow.ts",
			"timeout-test",
		);

		expect(result).toBeUndefined();
		expect(resolver).toHaveBeenCalled();
	});

	it("should handle resolver rejection", async () => {
		const manager = new LspClientManager({ rootResolverTimeoutMs: 100 });
		const resolver = vi.fn<RootResolver>(async (file: string) => {
			throw new Error("boom");
		});

		const result = await manager.resolveRootSafe(
			resolver,
			"/project/error.ts",
			"error-test",
		);

		expect(result).toBeUndefined();
		expect(resolver).toHaveBeenCalled();
	});
});
