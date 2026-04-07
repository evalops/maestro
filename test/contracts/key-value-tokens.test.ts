import { parseKeyValueTokens } from "@evalops/contracts";
import { describe, expect, it } from "vitest";

describe("parseKeyValueTokens", () => {
	it("parses KEY=value tokens into a string record", () => {
		expect(
			parseKeyValueTokens(["topic=MCP auth flow", "format=brief"], "invalid"),
		).toEqual({
			values: {
				topic: "MCP auth flow",
				format: "brief",
			},
		});
	});

	it("returns the provided error for invalid tokens", () => {
		expect(parseKeyValueTokens(["invalid-token"], "invalid")).toEqual({
			error: "invalid",
		});
	});
});
