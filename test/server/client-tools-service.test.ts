import { afterEach, describe, expect, it } from "vitest";
import { ClientToolService } from "../../src/server/client-tools-service.js";
import { serverRequestManager } from "../../src/server/server-request-manager.js";

describe("ClientToolService", () => {
	afterEach(() => {
		for (const request of serverRequestManager.listPending()) {
			serverRequestManager.cancel(request.id, "test cleanup");
		}
	});

	it("resolves the session id lazily for each client tool request", async () => {
		let sessionId = "session-1";
		const service = new ClientToolService();
		const boundService = service.forSession(() => sessionId);

		const firstPromise = boundService.requestExecution(
			"client-tool-1",
			"client_tool",
			{ value: 1 },
		);
		expect(serverRequestManager.get("client-tool-1")?.sessionId).toBe(
			"session-1",
		);
		expect(
			service.resolve("client-tool-1", [{ type: "text", text: "ok" }], false),
		).toBe(true);
		await expect(firstPromise).resolves.toEqual({
			content: [{ type: "text", text: "ok" }],
			isError: false,
		});

		sessionId = "session-2";

		const secondPromise = boundService.requestExecution(
			"client-tool-2",
			"ask_user",
			{ prompt: "continue?" },
		);
		expect(serverRequestManager.get("client-tool-2")?.sessionId).toBe(
			"session-2",
		);
		expect(
			service.resolve(
				"client-tool-2",
				[{ type: "text", text: "cancelled" }],
				true,
			),
		).toBe(true);
		await expect(secondPromise).resolves.toEqual({
			content: [{ type: "text", text: "cancelled" }],
			isError: true,
		});
	});
});
