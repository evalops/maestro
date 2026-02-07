import { describe, expect, it } from "vitest";
import { createGovernanceMcpServer } from "../src/server.js";

describe("createGovernanceMcpServer", () => {
	it("should create a server and engine", () => {
		const { server, engine } = createGovernanceMcpServer();
		expect(server).toBeDefined();
		expect(engine).toBeDefined();
	});

	it("should accept engine configuration", () => {
		const events: unknown[] = [];
		const { engine } = createGovernanceMcpServer({
			engineConfig: {
				onAuditEvent: (event) => events.push(event),
			},
		});
		// Trigger an evaluation to verify the callback works
		engine.analyzeCommand("echo test");
		expect(events.length).toBeGreaterThan(0);
	});
});
