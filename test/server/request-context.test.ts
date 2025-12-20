import { describe, expect, it } from "vitest";
import { parseTraceParent } from "../../src/server/request-context.js";

describe("parseTraceParent", () => {
	it("parses a valid traceparent header", () => {
		const header = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";
		const result = parseTraceParent(header);

		expect(result.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
		expect(result.parentSpanId).toBe("00f067aa0ba902b7");
	});

	it("rejects invalid traceparent values", () => {
		const header = "00-1234-00f067aa0ba902b7-01";
		const result = parseTraceParent(header);

		expect(result.traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(result.traceId).not.toBe("00000000000000000000000000000000");
		expect(result.parentSpanId).toBeUndefined();
	});
});
