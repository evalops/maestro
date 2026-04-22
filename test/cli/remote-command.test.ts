import { describe, expect, it } from "vitest";
import { parseRemoteDurationMinutes } from "../../src/cli/commands/remote.js";

describe("remote command helpers", () => {
	it("parses runner TTL values as whole minutes", () => {
		expect(parseRemoteDurationMinutes("90m", 1)).toBe(90);
		expect(parseRemoteDurationMinutes("2h", 1)).toBe(120);
		expect(parseRemoteDurationMinutes("45", 1)).toBe(45);
		expect(parseRemoteDurationMinutes(undefined, 30)).toBe(30);
	});

	it("rejects sub-minute or fractional-minute TTL values", () => {
		expect(() => parseRemoteDurationMinutes("1.5m", 1)).toThrow(
			"whole minutes",
		);
		expect(() => parseRemoteDurationMinutes("soon", 1)).toThrow(
			"Invalid duration",
		);
	});
});
