import {
	type IncomingMessage,
	type Server,
	type ServerResponse,
	createServer,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchWithPinnedAddress } from "../../src/utils/fetch-with-pinned-address.js";

async function startSlowServer(): Promise<{
	close: () => Promise<void>;
	url: string;
}> {
	let pendingResponse:
		| {
				endTimer: ReturnType<typeof setTimeout>;
				response: ServerResponse<IncomingMessage>;
		  }
		| undefined;
	const server: Server = createServer((_req: IncomingMessage, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.write("partial");
		const endTimer = setTimeout(() => {
			res.end("-body");
		}, 100);
		pendingResponse = { endTimer, response: res };
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});

	return {
		close: async () => {
			if (pendingResponse) {
				clearTimeout(pendingResponse.endTimer);
				if (
					!pendingResponse.response.writableEnded &&
					!pendingResponse.response.destroyed
				) {
					pendingResponse.response.end("-cleanup");
				}
				pendingResponse = undefined;
			}
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		},
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/slow-body`,
	};
}

describe("fetchWithPinnedAddress", () => {
	const cleanupServers: Array<() => Promise<void>> = [];

	afterEach(async () => {
		for (const close of cleanupServers.splice(0)) {
			await close();
		}
	});

	it("keeps aborting the response body after headers arrive", async () => {
		const server = await startSlowServer();
		cleanupServers.push(server.close);
		const controller = new AbortController();

		const response = await fetchWithPinnedAddress(
			server.url,
			{ signal: controller.signal },
			{ resolvedAddress: "127.0.0.1" },
		);
		const bodyPromise = response.arrayBuffer();

		controller.abort();

		await expect(bodyPromise).rejects.toMatchObject({ name: "AbortError" });
	});
});
