import { describe, expect, it } from "vitest";
import { runRpcMode } from "../../src/cli/rpc-mode.js";

describe("runRpcMode", () => {
	it("throws a removal error directing callers to native headless", async () => {
		await expect(runRpcMode({} as never, {} as never)).rejects.toThrow(
			/TypeScript runRpcMode has been removed/,
		);
		await expect(runRpcMode({} as never, {} as never)).rejects.toThrow(
			/maestro-tui --headless/,
		);
	});
});
