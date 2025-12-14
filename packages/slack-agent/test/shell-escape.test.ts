import { describe, expect, it } from "vitest";
import { shellEscape } from "../src/utils/shell-escape.js";

describe("shellEscape", () => {
	it("wraps simple strings in single quotes", () => {
		expect(shellEscape("hello")).toBe("'hello'");
	});

	it("escapes single quotes", () => {
		expect(shellEscape("it's")).toBe("'it'\\''s'");
	});

	it("handles multiple single quotes", () => {
		expect(shellEscape("'a'b'c'")).toBe("''\\''a'\\''b'\\''c'\\'''");
	});

	it("handles empty strings", () => {
		expect(shellEscape("")).toBe("''");
	});

	it("handles strings with spaces", () => {
		expect(shellEscape("hello world")).toBe("'hello world'");
	});

	it("handles special shell characters safely", () => {
		expect(shellEscape("$HOME")).toBe("'$HOME'");
		expect(shellEscape("`whoami`")).toBe("'`whoami`'");
		expect(shellEscape("$(echo test)")).toBe("'$(echo test)'");
		expect(shellEscape("a; rm -rf /")).toBe("'a; rm -rf /'");
		expect(shellEscape("a && b")).toBe("'a && b'");
		expect(shellEscape("a | b")).toBe("'a | b'");
	});

	it("handles newlines", () => {
		expect(shellEscape("line1\nline2")).toBe("'line1\nline2'");
	});

	it("handles tabs", () => {
		expect(shellEscape("col1\tcol2")).toBe("'col1\tcol2'");
	});
});
