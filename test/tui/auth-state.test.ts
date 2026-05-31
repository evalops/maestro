import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	hasCodexAppServerAccount: vi.fn(),
	listOAuthProviders: vi.fn(),
	loadOAuthCredentials: vi.fn(),
}));

vi.mock("../../src/codex/auth.js", () => ({
	hasOpenAICodexAppServerAccount: mocks.hasCodexAppServerAccount,
}));

vi.mock("../../src/oauth/storage.js", () => ({
	listOAuthProviders: mocks.listOAuthProviders,
	loadOAuthCredentials: mocks.loadOAuthCredentials,
}));

const { getTuiAuthState } = await import("../../src/cli-tui/auth-state.js");

describe("TUI auth state", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.hasCodexAppServerAccount.mockResolvedValue(false);
		mocks.listOAuthProviders.mockReturnValue([]);
		mocks.loadOAuthCredentials.mockReturnValue(null);
	});

	it("reports Codex app-server accounts without stored OAuth credentials", async () => {
		mocks.hasCodexAppServerAccount.mockResolvedValueOnce(true);

		await expect(getTuiAuthState("openai-codex")).resolves.toEqual({
			authenticated: true,
			provider: "openai-codex",
			mode: "app-server",
		});
	});

	it("prefers the current Codex provider when app-server auth exists alongside stored OAuth", async () => {
		mocks.hasCodexAppServerAccount.mockResolvedValueOnce(true);
		mocks.listOAuthProviders.mockReturnValue(["openai"]);
		mocks.loadOAuthCredentials.mockReturnValue(null);

		await expect(getTuiAuthState("openai-codex")).resolves.toEqual({
			authenticated: true,
			provider: "openai-codex",
			mode: "app-server",
		});
	});

	it("preserves stored provider metadata when no Codex app-server account exists", async () => {
		mocks.listOAuthProviders.mockReturnValue(["openai"]);
		mocks.loadOAuthCredentials.mockReturnValue({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 1000,
			metadata: { mode: "pro" },
		});

		await expect(getTuiAuthState("openai")).resolves.toEqual({
			authenticated: true,
			provider: "openai",
			mode: "pro",
		});
	});

	it("does not probe Codex app-server status when reporting a stored non-Codex provider", async () => {
		mocks.listOAuthProviders.mockReturnValue(["anthropic"]);
		mocks.loadOAuthCredentials.mockReturnValue({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 1000,
			metadata: { mode: "oauth" },
		});

		await expect(getTuiAuthState("anthropic")).resolves.toEqual({
			authenticated: true,
			provider: "anthropic",
			mode: "oauth",
		});
		expect(mocks.hasCodexAppServerAccount).not.toHaveBeenCalled();
	});

	it("uses stored Codex metadata without probing the app-server", async () => {
		mocks.listOAuthProviders.mockReturnValue(["openai-codex"]);
		mocks.loadOAuthCredentials.mockReturnValue({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 1000,
			metadata: { mode: "responses" },
		});

		await expect(getTuiAuthState("openai-codex")).resolves.toEqual({
			authenticated: true,
			provider: "openai-codex",
			mode: "responses",
		});
		expect(mocks.hasCodexAppServerAccount).not.toHaveBeenCalled();
	});
});
