import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFreshAnthropicOAuthCredential } from "../../src/providers/anthropic-auth.js";
import { createAuthResolver } from "../../src/providers/auth.js";
import { getFreshOpenAIOAuthCredential } from "../../src/providers/openai-auth.js";

vi.mock("../../src/providers/anthropic-auth.js", () => ({
	getFreshAnthropicOAuthCredential: vi.fn(),
}));

vi.mock("../../src/providers/openai-auth.js", () => ({
	getFreshOpenAIOAuthCredential: vi.fn(),
}));

describe("auth resolver", () => {
	const originalAnthropic = process.env.ANTHROPIC_API_KEY;
	const originalOpenAI = process.env.OPENAI_API_KEY;
	const originalClaude = process.env.CLAUDE_CODE_TOKEN;
	const originalCodex = process.env.CODEX_API_KEY;

	beforeEach(() => {
		// biome-ignore lint/performance/noDelete: resetting env vars for isolated tests
		delete process.env.ANTHROPIC_API_KEY;
		// biome-ignore lint/performance/noDelete: resetting env vars for isolated tests
		delete process.env.OPENAI_API_KEY;
		// biome-ignore lint/performance/noDelete: resetting env vars for isolated tests
		delete process.env.CLAUDE_CODE_TOKEN;
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
		if (originalClaude === undefined) {
			// biome-ignore lint/performance/noDelete: restoring env var state
			delete process.env.CLAUDE_CODE_TOKEN;
		} else {
			process.env.CLAUDE_CODE_TOKEN = originalClaude;
		}
		if (originalCodex === undefined) {
			// biome-ignore lint/performance/noDelete: restoring env var state
			delete process.env.CODEX_API_KEY;
		} else {
			process.env.CODEX_API_KEY = originalCodex;
		}
		vi.clearAllMocks();
	});

	it("prefers explicit API key when provided", async () => {
		const resolver = createAuthResolver({
			mode: "auto",
			explicitApiKey: "cli-key",
		});
		const credential = await resolver("openai");
		expect(credential).toBeDefined();
		expect(credential?.token).toBe("cli-key");
		expect(credential?.type).toBe("api-key");
	});

	it("falls back to provider env vars in api-key mode", async () => {
		process.env.ANTHROPIC_API_KEY = "anthropic-env";
		const resolver = createAuthResolver({ mode: "api-key" });
		const credential = await resolver("anthropic");
		expect(credential).toBeDefined();
		expect(credential?.token).toBe("anthropic-env");
		expect(credential?.type).toBe("api-key");
	});

	it("ignores Codex subscription tokens", async () => {
		vi.mocked(getFreshOpenAIOAuthCredential).mockResolvedValue(null);
		process.env.CODEX_API_KEY = "codex-token";
		const resolver = createAuthResolver({ mode: "auto" });
		const credential = await resolver("openai");
		expect(credential).toBeUndefined();
		// biome-ignore lint/performance/noDelete: resetting env var state
		delete process.env.CODEX_API_KEY;
	});

	it("returns undefined when credentials are missing", async () => {
		const resolver = createAuthResolver({ mode: "auto" });
		const credential = await resolver("openai");
		expect(credential).toBeUndefined();
	});

	it("prefers stored anthropic oauth token in claude mode", async () => {
		const mocked = vi.mocked(getFreshAnthropicOAuthCredential);
		mocked.mockResolvedValue({
			accessToken: "oauth-token",
			refreshToken: "ref",
			expiresAt: Date.now() + 60_000,
			mode: "pro",
		});
		const resolver = createAuthResolver({ mode: "claude" });
		const credential = await resolver("anthropic");
		expect(credential).toBeDefined();
		expect(credential?.type).toBe("anthropic-oauth");
		expect(credential?.token).toBe("oauth-token");
		mocked.mockReset();
	});

	it("reads env claude token ahead of file", async () => {
		process.env.CLAUDE_CODE_TOKEN = "env-token";
		const resolver = createAuthResolver({ mode: "claude" });
		const credential = await resolver("anthropic");
		expect(credential).toBeDefined();
		expect(credential?.token).toBe("env-token");
		expect(credential?.type).toBe("anthropic-oauth");
		// biome-ignore lint/performance/noDelete: resetting env var state
		delete process.env.CLAUDE_CODE_TOKEN;
	});

	it("fails when claude mode lacks oauth tokens", async () => {
		const resolver = createAuthResolver({ mode: "claude" });
		const credential = await resolver("anthropic");
		expect(credential).toBeUndefined();
	});
});
