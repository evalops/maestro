import { describe, expect, it } from "vitest";
import { RpcClient } from "../../src/rpc/rpc-client.js";

describe("RpcClient", () => {
	it("defaults to the maestro CLI binary", () => {
		const client = new RpcClient();
		const internals = client as unknown as {
			options: { cliPath: string };
		};

		expect(internals.options.cliPath).toBe("maestro");
		expect(internals.options.cliPath).not.toBe("composer");
	});

	it("preserves custom CLI path overrides", () => {
		const client = new RpcClient({ cliPath: "/usr/local/bin/maestro-dev" });
		const internals = client as unknown as {
			options: { cliPath: string };
		};

		expect(internals.options.cliPath).toBe("/usr/local/bin/maestro-dev");
	});
});
