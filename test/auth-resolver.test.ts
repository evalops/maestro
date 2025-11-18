import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthResolver } from "../src/providers/auth.js";

describe("auth resolver", () => {
	const originalAnthropic = process.env.ANTHROPIC_API_KEY;
	const originalOpenAI = process.env.OPENAI_API_KEY;

	beforeEach(() => {
		// biome-ignore lint/performance/noDelete: resetting env vars for isolated tests
		delete process.env.ANTHROPIC_API_KEY;
		// biome-ignore lint/performance/noDelete: resetting env vars for isolated tests
		delete process.env.OPENAI_API_KEY;
		// biome-ignore lint/performance/noDelete: resetting env vars for isolated tests
		delete process.env.CODEX_API_KEY;
	});

	afterEach(() => {
		if (originalAnthropic === undefined) {
			// biome-ignore lint/performance/noDelete: restoring env var state
			delete process.env.ANTHROPIC_API_KEY;
		} else {
			process.env.ANTHROPIC_API_KEY = originalAnthropic;
		}
		if (originalOpenAI === undefined) {
			// biome-ignore lint/performance/noDelete: restoring env var state
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = originalOpenAI;
		}
	});

	it("prefers explicit API key when provided", () => {
		const resolver = createAuthResolver({
			mode: "chatgpt",
			explicitApiKey: "cli-key",
			codexApiKey: "codex-key",
			codexSource: "flag",
		});
		const credential = resolver("openai");
		expect(credential).toBeDefined();
		expect(credential?.token).toBe("cli-key");
		expect(credential?.type).toBe("api-key");
	});

	it("uses Codex token in chatgpt mode for OpenAI", () => {
		const resolver = createAuthResolver({
			mode: "chatgpt",
			codexApiKey: "codex-token",
			codexSource: "env",
		});
		const credential = resolver("openai");
		expect(credential).toBeDefined();
		expect(credential?.token).toBe("codex-token");
		expect(credential?.type).toBe("chatgpt");
	});

	it("falls back to provider env vars in api-key mode", () => {
		process.env.ANTHROPIC_API_KEY = "anthropic-env";
		const resolver = createAuthResolver({ mode: "api-key" });
		const credential = resolver("anthropic");
		expect(credential).toBeDefined();
		expect(credential?.token).toBe("anthropic-env");
		expect(credential?.type).toBe("api-key");
	});

	it("returns undefined when credentials are missing", () => {
		const resolver = createAuthResolver({ mode: "auto" });
		const credential = resolver("openai");
		expect(credential).toBeUndefined();
	});
});
