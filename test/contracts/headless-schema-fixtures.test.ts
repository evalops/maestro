import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { headlessProtocolVersion } from "../../packages/contracts/src/headless-protocol-generated.js";

describe("headless schema fixtures", () => {
	it("publishes protocol and payload fixtures for drift review", async () => {
		const protocol = JSON.parse(
			await readFile(
				"packages/contracts/schema/headless/protocol.json",
				"utf8",
			),
		) as {
			protocolVersion: string;
			executorTypes: string[];
			fromAgentMessageTypes: string[];
			serverRequestTypes: string[];
		};
		const payloads = JSON.parse(
			await readFile(
				"packages/contracts/schema/headless/payload-schemas.json",
				"utf8",
			),
		) as { fromAgentSchemas: Record<string, unknown> };

		expect(protocol.protocolVersion).toBe(headlessProtocolVersion);
		expect(protocol.executorTypes).toEqual(["live", "replay"]);
		expect(protocol.fromAgentMessageTypes).toContain("server_request");
		expect(protocol.serverRequestTypes).toEqual([
			"approval",
			"client_tool",
			"mcp_elicitation",
			"user_input",
			"tool_retry",
		]);
		expect(payloads.fromAgentSchemas).toHaveProperty(
			"HeadlessServerRequestMessageSchema",
		);
	});
});
