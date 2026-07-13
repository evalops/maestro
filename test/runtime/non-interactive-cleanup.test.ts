import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	disconnectAll: vi.fn(),
	shutdownAll: vi.fn(),
}));

vi.mock("../../src/mcp/manager.js", () => ({
	mcpManager: {
		disconnectAll: mocks.disconnectAll,
	},
}));

vi.mock("../../src/lsp/manager.js", () => ({
	lspManager: {
		shutdownAll: mocks.shutdownAll,
	},
}));

import { cleanupNonInteractiveRuntimeResources } from "../../src/runtime/non-interactive-cleanup.js";

function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("cleanupNonInteractiveRuntimeResources", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mocks.disconnectAll.mockReset();
		mocks.shutdownAll.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns after the grace timer even if teardown is still pending", async () => {
		const mcpCleanup = createDeferred();
		const lspCleanup = createDeferred();
		mocks.disconnectAll.mockReturnValue(mcpCleanup.promise);
		mocks.shutdownAll.mockReturnValue(lspCleanup.promise);

		let finished = false;
		const cleanupPromise = cleanupNonInteractiveRuntimeResources().then(() => {
			finished = true;
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mocks.shutdownAll).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(5_000);
		await cleanupPromise;
		expect(finished).toBe(true);
	});

	it("waits for teardown when it finishes before the grace timer", async () => {
		mocks.disconnectAll.mockResolvedValue(undefined);
		mocks.shutdownAll.mockResolvedValue(undefined);

		await cleanupNonInteractiveRuntimeResources();

		expect(mocks.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mocks.shutdownAll).toHaveBeenCalledTimes(1);
	});
});
