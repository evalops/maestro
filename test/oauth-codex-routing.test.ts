import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	appServerLogin: vi.fn(),
	appServerLogout: vi.fn(),
	hasAppServerAccount: vi.fn(),
	loadOAuthCredentials: vi.fn(),
	legacyResponsesLogin: vi.fn(),
	removeOAuthCredentials: vi.fn(),
	refreshLegacyResponsesToken: vi.fn(),
	syncStoredOAuthProviderConnection: vi.fn(),
}));

vi.mock("../src/codex/auth.js", () => ({
	hasOpenAICodexAppServerAccount: mocks.hasAppServerAccount,
	loginOpenAICodexAppServer: mocks.appServerLogin,
	logoutOpenAICodexAppServer: mocks.appServerLogout,
}));

vi.mock("../src/oauth/openai-codex.js", () => ({
	loginOpenAICodex: mocks.legacyResponsesLogin,
	refreshOpenAICodexToken: mocks.refreshLegacyResponsesToken,
}));

vi.mock("../src/oauth/connectors.js", () => ({
	revokeOAuthProviderConnection: vi.fn(),
	syncOAuthProviderConnection: vi.fn(
		async (_provider, credentials) => credentials,
	),
	syncStoredOAuthProviderConnection: mocks.syncStoredOAuthProviderConnection,
}));

vi.mock("../src/oauth/storage.js", () => ({
	listOAuthProviders: vi.fn(() => []),
	loadOAuthCredentials: mocks.loadOAuthCredentials,
	removeOAuthCredentials: mocks.removeOAuthCredentials,
	saveOAuthCredentials: vi.fn(),
}));

const { login, logout } = await import("../src/oauth/index.js");

describe("OpenAI Codex OAuth routing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.appServerLogin.mockResolvedValue(undefined);
		mocks.legacyResponsesLogin.mockResolvedValue(undefined);
		mocks.hasAppServerAccount.mockResolvedValue(false);
		mocks.loadOAuthCredentials.mockReturnValue(null);
		mocks.removeOAuthCredentials.mockImplementation(() => {});
		mocks.syncStoredOAuthProviderConnection.mockResolvedValue(undefined);
	});

	it("uses Codex app-server auth by default", async () => {
		const onAuthUrl = vi.fn();

		await login("openai-codex", { onAuthUrl });

		expect(mocks.appServerLogin).toHaveBeenCalledWith(
			onAuthUrl,
			undefined,
			undefined,
		);
		expect(mocks.legacyResponsesLogin).not.toHaveBeenCalled();
		expect(mocks.syncStoredOAuthProviderConnection).not.toHaveBeenCalled();
	});

	it("preserves credential-producing auth for legacy Codex Responses models", async () => {
		const onAuthUrl = vi.fn();
		const onPromptCode = vi.fn();
		const onStatus = vi.fn();

		await login("openai-codex", {
			mode: "responses",
			onAuthUrl,
			onPromptCode,
			onStatus,
		});

		expect(mocks.legacyResponsesLogin).toHaveBeenCalledWith(
			onAuthUrl,
			onPromptCode,
			onStatus,
		);
		expect(mocks.appServerLogin).not.toHaveBeenCalled();
		expect(mocks.syncStoredOAuthProviderConnection).toHaveBeenCalledWith(
			"openai-codex",
		);
	});

	it("surfaces app-server logout failures when no legacy Codex credentials exist", async () => {
		mocks.appServerLogout.mockRejectedValueOnce(new Error("codex offline"));

		await expect(logout("openai-codex")).rejects.toThrow(
			"Failed to sign out of Codex app-server: codex offline",
		);

		expect(mocks.removeOAuthCredentials).not.toHaveBeenCalled();
	});

	it("skips app-server logout when only legacy Codex credentials exist", async () => {
		mocks.loadOAuthCredentials.mockReturnValue({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 1000,
		});

		await logout("openai-codex");

		expect(mocks.hasAppServerAccount).toHaveBeenCalledOnce();
		expect(mocks.appServerLogout).not.toHaveBeenCalled();
		expect(mocks.removeOAuthCredentials).toHaveBeenCalledWith("openai-codex");
	});

	it("surfaces partial app-server logout failures after removing legacy Codex credentials", async () => {
		mocks.hasAppServerAccount.mockResolvedValueOnce(true);
		mocks.loadOAuthCredentials.mockReturnValue({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 1000,
		});
		mocks.appServerLogout.mockRejectedValueOnce(new Error("codex offline"));

		await expect(logout("openai-codex")).rejects.toThrow(
			"Failed to sign out of Codex app-server; legacy OAuth credentials were removed: codex offline",
		);

		expect(mocks.removeOAuthCredentials).toHaveBeenCalledWith("openai-codex");
	});
});
