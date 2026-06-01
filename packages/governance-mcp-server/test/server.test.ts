import { describe, expect, it, vi } from "vitest";
import { createGovernanceMcpServer } from "../src/server.js";

describe("createGovernanceMcpServer", () => {
	it("should create a server and engine", () => {
		const { server, engine } = createGovernanceMcpServer();
		expect(server).toBeDefined();
		expect(engine).toBeDefined();
	});

	it("should accept engine configuration", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					evaluation: {
						decision: "ACTION_DECISION_ALLOW",
						matchedRules: [],
						reasons: [],
					},
				}),
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const events: unknown[] = [];
		const { engine } = createGovernanceMcpServer({
			engineConfig: {
				service: {
					baseUrl: "https://platform.test",
					maxAttempts: 1,
					timeoutMs: 500,
					workspaceId: "workspace-1",
				},
				onAuditEvent: (event) => events.push(event),
			},
		});
		await engine.evaluate({ args: { command: "echo test" }, toolName: "bash" });
		expect(events.length).toBeGreaterThan(0);
		vi.unstubAllGlobals();
	});
});
