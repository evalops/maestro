import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { authorizeRuntimeWebSocketSession } from "../../src/server/runtime-ws-access.js";

class FakeSocket extends EventEmitter {
	readonly writes: string[] = [];
	destroyed = false;

	write(payload: string) {
		this.writes.push(payload);
	}

	destroy() {
		this.destroyed = true;
	}
}

describe("authorizeRuntimeWebSocketSession", () => {
	const request = {} as IncomingMessage;

	it("returns the requested session id when access validation allows it", async () => {
		const socket = new FakeSocket();

		await expect(
			authorizeRuntimeWebSocketSession({
				req: request,
				socket,
				requestedSessionId: "sess_1",
				validateSessionAccess: async (_req, sessionId) =>
					sessionId === "sess_1",
			}),
		).resolves.toBe("sess_1");
		expect(socket.writes).toEqual([]);
		expect(socket.destroyed).toBe(false);
	});

	it("rejects denied session ids before upgrading the socket", async () => {
		const socket = new FakeSocket();

		await expect(
			authorizeRuntimeWebSocketSession({
				req: request,
				socket,
				requestedSessionId: "sess_private",
				validateSessionAccess: async () => false,
			}),
		).resolves.toBeNull();
		expect(socket.writes).toEqual(["HTTP/1.1 403 Forbidden\r\n\r\n"]);
		expect(socket.destroyed).toBe(true);
	});

	it("returns an HTTP failure instead of leaking access-check exceptions", async () => {
		const socket = new FakeSocket();
		const logAccessError = vi.fn();

		await expect(
			authorizeRuntimeWebSocketSession({
				req: request,
				socket,
				requestedSessionId: "sess_1",
				validateSessionAccess: async () => {
					throw new Error("session store unavailable");
				},
				logAccessError,
			}),
		).resolves.toBeNull();
		expect(socket.writes).toEqual([
			"HTTP/1.1 500 Internal Server Error\r\n\r\n",
		]);
		expect(socket.destroyed).toBe(true);
		expect(logAccessError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "session store unavailable" }),
		);
	});
});
