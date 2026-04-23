import { describe, expect, it } from "vitest";
import { ConnectorsClient } from "../src/clients.js";
import type { EvalOpsTransportOptions } from "../src/http.js";
import type { ConnectorListResponse } from "../src/types.js";

class CapturingTransport {
	lastRequest?: EvalOpsTransportOptions;

	request<T>(options: EvalOpsTransportOptions<T>): Promise<T> {
		this.lastRequest = options;
		return Promise.resolve({ connectors: [] } as T);
	}
}

describe("consumer SDK service paths", () => {
	it("uses the Platform connector list RPC", async () => {
		const transport = new CapturingTransport();
		const client = new ConnectorsClient(
			transport as unknown as ConstructorParameters<typeof ConnectorsClient>[0],
		);

		await expect(client.list()).resolves.toEqual({
			connectors: [],
		} satisfies ConnectorListResponse);
		expect(transport.lastRequest?.path).toBe(
			"/connectors.v1.ConnectorService/ListConnections",
		);
	});
});
