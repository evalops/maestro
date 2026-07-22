/**
 * Tests for validateCodexFlags().
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { validateCodexFlags } from "../../src/bootstrap/auth-setup.js";

describe("validateCodexFlags", () => {
	const originalEnv = process.env.CODEX_API_KEY;

	afterEach(() => {
		if (originalEnv === undefined) {
			Reflect.deleteProperty(process.env, "CODEX_API_KEY");
		} else {
			process.env.CODEX_API_KEY = originalEnv;
		}
	});

	it("throws on --codex-api-key flag", () => {
		expect(() => validateCodexFlags(["--codex-api-key", "key123"])).toThrow(
			/no longer supported/,
		);
	});

	it("throws on --codex-api-key=value form", () => {
		expect(() => validateCodexFlags(["--codex-api-key=key123"])).toThrow(
			/no longer supported/,
		);
	});

	it("throws on --auth chatgpt", () => {
		expect(() => validateCodexFlags(["--auth", "chatgpt"])).toThrow(
			/no longer supported/,
		);
	});

	it("throws on --auth=chatgpt", () => {
		expect(() => validateCodexFlags(["--auth=chatgpt"])).toThrow(
			/no longer supported/,
		);
	});

	it("throws on --auth claude", () => {
		expect(() => validateCodexFlags(["--auth", "claude"])).toThrow(
			/no longer supported/,
		);
	});

	it("throws on --auth=claude", () => {
		expect(() => validateCodexFlags(["--auth=claude"])).toThrow(
			/no longer supported/,
		);
	});

	it("allows legacy flags under help command", () => {
		expect(() =>
			validateCodexFlags(["--codex-api-key", "key123"], "help"),
		).not.toThrow();
	});

	it("allows legacy flags under config command", () => {
		expect(() =>
			validateCodexFlags(["--codex-api-key", "key123"], "config"),
		).not.toThrow();
	});

	it("allows unrelated flags", () => {
		expect(() =>
			validateCodexFlags(["--model", "claude-sonnet-4-5"]),
		).not.toThrow();
	});

	it("does not warn about supported CODEX_API_KEY env var", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		process.env.CODEX_API_KEY = "some-key";

		validateCodexFlags([]);

		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});
