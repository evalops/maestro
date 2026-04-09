/**
 * Tests for validateCodexFlags() and createAuthSetup().
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/models/registry.js", () => ({
	getCustomProviderMetadata: vi.fn().mockReturnValue(null),
}));

vi.mock("../../src/providers/api-keys.js", () => ({
	getEnvVarsForProvider: vi.fn().mockReturnValue(["ANTHROPIC_API_KEY"]),
}));

vi.mock("../../src/providers/auth.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../src/providers/auth.js")>();
	return {
		...actual,
		createAuthResolver: vi
			.fn()
			.mockReturnValue(vi.fn().mockResolvedValue(null)),
	};
});

import {
	createAuthSetup,
	validateCodexFlags,
} from "../../src/bootstrap/auth-setup.js";
import { getCustomProviderMetadata } from "../../src/models/registry.js";
import { getEnvVarsForProvider } from "../../src/providers/api-keys.js";
import { createAuthResolver } from "../../src/providers/auth.js";

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

	it("throws on --codex-api-key= format", () => {
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

	it("does not throw for help command even with codex flags", () => {
		expect(() =>
			validateCodexFlags(["--codex-api-key", "key123"], "help"),
		).not.toThrow();
	});

	it("does not throw for config command even with codex flags", () => {
		expect(() =>
			validateCodexFlags(["--codex-api-key", "key123"], "config"),
		).not.toThrow();
	});

	it("does not throw when no codex flags present", () => {
		expect(() =>
			validateCodexFlags(["--model", "claude-sonnet-4-5"]),
		).not.toThrow();
	});

	it("warns about CODEX_API_KEY env var", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		process.env.CODEX_API_KEY = "some-key";

		validateCodexFlags([]);

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("CODEX_API_KEY"),
		);
		warnSpy.mockRestore();
	});
});

describe("createAuthSetup", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns requireCredential and buildMissingAuthLines", () => {
		const result = createAuthSetup({ authMode: "api-key" });

		expect(typeof result.requireCredential).toBe("function");
		expect(typeof result.buildMissingAuthLines).toBe("function");
	});

	it("buildMissingAuthLines includes error message for provider", () => {
		const result = createAuthSetup({ authMode: "api-key" });
		const lines = result.buildMissingAuthLines("anthropic");

		expect(lines.length).toBeGreaterThan(0);
		const firstLine = lines[0]!;
		expect(firstLine.plain).toContain("No credentials found");
		expect(firstLine.plain).toContain("anthropic");
	});

	it("buildMissingAuthLines includes login hint for non-api-key mode", () => {
		const result = createAuthSetup({ authMode: "claude" });
		const lines = result.buildMissingAuthLines("anthropic");

		const allPlain = lines.map((l) => l.plain).join("\n");
		expect(allPlain).toContain("login");
	});

	it("buildMissingAuthLines reuses evalops login hint for managed aliases", () => {
		const result = createAuthSetup({ authMode: "auto" });
		const lines = result.buildMissingAuthLines("evalops-openrouter");

		const allPlain = lines.map((l) => l.plain).join("\n");
		expect(allPlain).toContain("/login evalops");
	});

	it("buildMissingAuthLines reuses evalops login hint for managed anthropic aliases", () => {
		const result = createAuthSetup({ authMode: "auto" });
		const lines = result.buildMissingAuthLines("evalops-anthropic");

		const allPlain = lines.map((l) => l.plain).join("\n");
		expect(allPlain).toContain("/login evalops");
	});

	it("buildMissingAuthLines reuses evalops login hint for managed Azure aliases", () => {
		const result = createAuthSetup({ authMode: "auto" });
		const lines = result.buildMissingAuthLines("evalops-azure-openai");

		const allPlain = lines.map((l) => l.plain).join("\n");
		expect(allPlain).toContain("/login evalops");
	});

	it("buildMissingAuthLines reuses evalops login hint for managed Cohere aliases", () => {
		const result = createAuthSetup({ authMode: "auto" });
		const lines = result.buildMissingAuthLines("evalops-cohere");

		const allPlain = lines.map((l) => l.plain).join("\n");
		expect(allPlain).toContain("/login evalops");
	});

	it("buildMissingAuthLines reuses evalops login hint for managed Fireworks aliases", () => {
		const result = createAuthSetup({ authMode: "auto" });
		const lines = result.buildMissingAuthLines("evalops-fireworks");

		const allPlain = lines.map((l) => l.plain).join("\n");
		expect(allPlain).toContain("/login evalops");
	});

	it("buildMissingAuthLines reuses evalops login hint for managed Google aliases", () => {
		const result = createAuthSetup({ authMode: "auto" });
		const lines = result.buildMissingAuthLines("evalops-google");

		const allPlain = lines.map((l) => l.plain).join("\n");
		expect(allPlain).toContain("/login evalops");
	});

	it("buildMissingAuthLines reuses evalops login hint for managed Groq aliases", () => {
		const result = createAuthSetup({ authMode: "auto" });
		const lines = result.buildMissingAuthLines("evalops-groq");

		const allPlain = lines.map((l) => l.plain).join("\n");
		expect(allPlain).toContain("/login evalops");
	});

	it("buildMissingAuthLines reuses evalops login hint for managed Databricks aliases", () => {
		const result = createAuthSetup({ authMode: "auto" });
		const lines = result.buildMissingAuthLines("evalops-databricks");

		const allPlain = lines.map((l) => l.plain).join("\n");
		expect(allPlain).toContain("/login evalops");
	});

	it("buildMissingAuthLines reuses evalops login hint for managed Perplexity aliases", () => {
		const result = createAuthSetup({ authMode: "auto" });
		const lines = result.buildMissingAuthLines("evalops-perplexity");

		const allPlain = lines.map((l) => l.plain).join("\n");
		expect(allPlain).toContain("/login evalops");
	});

	it("buildMissingAuthLines reuses evalops login hint for managed Together aliases", () => {
		const result = createAuthSetup({ authMode: "auto" });
		const lines = result.buildMissingAuthLines("evalops-together");

		const allPlain = lines.map((l) => l.plain).join("\n");
		expect(allPlain).toContain("/login evalops");
	});

	it("buildMissingAuthLines reuses evalops login hint for managed Mistral aliases", () => {
		const result = createAuthSetup({ authMode: "auto" });
		const lines = result.buildMissingAuthLines("evalops-mistral");

		const allPlain = lines.map((l) => l.plain).join("\n");
		expect(allPlain).toContain("/login evalops");
	});

	it("buildMissingAuthLines reuses evalops login hint for managed xAI aliases", () => {
		const result = createAuthSetup({ authMode: "auto" });
		const lines = result.buildMissingAuthLines("evalops-xai");

		const allPlain = lines.map((l) => l.plain).join("\n");
		expect(allPlain).toContain("/login evalops");
	});

	it("buildMissingAuthLines includes env var hint", () => {
		(getEnvVarsForProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce([
			"OPENAI_API_KEY",
		]);
		const result = createAuthSetup({ authMode: "api-key" });
		const lines = result.buildMissingAuthLines("openai");

		const allPlain = lines.map((l) => l.plain).join("\n");
		expect(allPlain).toContain("OPENAI_API_KEY");
	});

	it("buildMissingAuthLines uses custom provider metadata env var", () => {
		(getEnvVarsForProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
		(getCustomProviderMetadata as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			{
				apiKeyEnv: "CUSTOM_KEY",
			},
		);
		const result = createAuthSetup({ authMode: "api-key" });
		const lines = result.buildMissingAuthLines("custom-provider");

		const allPlain = lines.map((l) => l.plain).join("\n");
		expect(allPlain).toContain("CUSTOM_KEY");
	});

	it("requireCredential returns credential when resolver succeeds", async () => {
		const mockResolver = vi.fn().mockResolvedValue({ apiKey: "found-key" });
		(createAuthResolver as ReturnType<typeof vi.fn>).mockReturnValue(
			mockResolver,
		);

		const result = createAuthSetup({ authMode: "api-key" });
		const credential = await result.requireCredential("anthropic", false);

		expect(credential).toEqual({ apiKey: "found-key" });
	});

	it("requireCredential throws when no credential and fatal=false", async () => {
		const mockResolver = vi.fn().mockResolvedValue(null);
		(createAuthResolver as ReturnType<typeof vi.fn>).mockReturnValue(
			mockResolver,
		);

		const result = createAuthSetup({ authMode: "api-key" });

		await expect(result.requireCredential("anthropic", false)).rejects.toThrow(
			/No credentials found/,
		);
	});

	it("requireCredential exits process when fatal=true", async () => {
		const mockResolver = vi.fn().mockResolvedValue(null);
		(createAuthResolver as ReturnType<typeof vi.fn>).mockReturnValue(
			mockResolver,
		);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit called");
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = createAuthSetup({ authMode: "api-key" });

		await expect(result.requireCredential("anthropic", true)).rejects.toThrow(
			"process.exit called",
		);

		expect(exitSpy).toHaveBeenCalledWith(1);
		exitSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("passes explicitApiKey to createAuthResolver", () => {
		createAuthSetup({
			authMode: "api-key",
			explicitApiKey: "my-explicit-key",
		});

		expect(createAuthResolver).toHaveBeenCalledWith({
			mode: "api-key",
			explicitApiKey: "my-explicit-key",
		});
	});
});
