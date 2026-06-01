import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	client: {
		initialize: vi.fn(),
		readAccount: vi.fn(),
		startChatGptLogin: vi.fn(),
		waitForLoginCompletion: vi.fn(),
		logout: vi.fn(),
		close: vi.fn(),
	},
}));

vi.mock("../../src/codex/app-server-client.js", () => ({
	createCodexAppServerClient: () => mocks.client,
}));

const {
	hasOpenAICodexAppServerAccount,
	loginOpenAICodexAppServer,
	logoutOpenAICodexAppServer,
} = await import("../../src/codex/auth.js");

describe("Codex app-server auth bridge", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.client.initialize.mockResolvedValue({});
		mocks.client.readAccount.mockResolvedValue({
			account: {
				type: "chatgpt",
				email: "dev@example.com",
				planType: "pro",
			},
			requiresOpenaiAuth: false,
		});
		mocks.client.startChatGptLogin.mockResolvedValue({
			type: "chatgpt",
			loginId: "login-1",
			authUrl: "https://chatgpt.test/auth",
		});
		mocks.client.waitForLoginCompletion.mockResolvedValue({
			loginId: "login-1",
			success: true,
			error: null,
		});
		mocks.client.logout.mockResolvedValue({});
	});

	it("uses an existing Codex app-server account instead of starting login", async () => {
		const statuses: string[] = [];

		await loginOpenAICodexAppServer(
			() => {},
			undefined,
			(status) => statuses.push(status),
		);

		expect(mocks.client.initialize).toHaveBeenCalledWith({
			experimentalApi: true,
		});
		expect(mocks.client.readAccount).toHaveBeenCalledWith(true);
		expect(mocks.client.startChatGptLogin).not.toHaveBeenCalled();
		expect(statuses).toContain(
			"Codex app-server is already authenticated: dev@example.com, pro.",
		);
		expect(mocks.client.close).toHaveBeenCalledOnce();
	});

	it("starts streamlined app-server login when no account exists", async () => {
		const authUrls: string[] = [];
		const statuses: string[] = [];
		mocks.client.readAccount
			.mockResolvedValueOnce({
				account: null,
				requiresOpenaiAuth: true,
			})
			.mockResolvedValueOnce({
				account: {
					type: "chatgpt",
					email: "dev@example.com",
					planType: "pro",
				},
				requiresOpenaiAuth: false,
			});

		await loginOpenAICodexAppServer(
			(url) => authUrls.push(url),
			undefined,
			(status) => statuses.push(status),
		);

		expect(mocks.client.startChatGptLogin).toHaveBeenCalledWith("browser", {
			codexStreamlinedLogin: true,
		});
		expect(mocks.client.waitForLoginCompletion).toHaveBeenCalledWith("login-1");
		expect(authUrls).toEqual(["https://chatgpt.test/auth"]);
		expect(statuses).toContain(
			"Codex ChatGPT sign-in complete: dev@example.com, pro.",
		);
		expect(mocks.client.close).toHaveBeenCalledOnce();
	});

	it("starts streamlined app-server login when account refresh fails", async () => {
		const authUrls: string[] = [];
		const statuses: string[] = [];
		mocks.client.readAccount
			.mockRejectedValueOnce(new Error("refresh failed"))
			.mockResolvedValueOnce({
				account: {
					type: "chatgpt",
					email: "dev@example.com",
					planType: "pro",
				},
				requiresOpenaiAuth: false,
			});

		await loginOpenAICodexAppServer(
			(url) => authUrls.push(url),
			undefined,
			(status) => statuses.push(status),
		);

		expect(mocks.client.startChatGptLogin).toHaveBeenCalledWith("browser", {
			codexStreamlinedLogin: true,
		});
		expect(mocks.client.waitForLoginCompletion).toHaveBeenCalledWith("login-1");
		expect(mocks.client.readAccount).toHaveBeenCalledWith(true);
		expect(authUrls).toEqual(["https://chatgpt.test/auth"]);
		expect(statuses).toContain(
			"Codex app-server account refresh failed; starting sign-in to repair authentication.",
		);
		expect(statuses).toContain(
			"Codex ChatGPT sign-in complete: dev@example.com, pro.",
		);
		expect(mocks.client.close).toHaveBeenCalledOnce();
	});

	it("signs out through Codex app-server", async () => {
		await logoutOpenAICodexAppServer();

		expect(mocks.client.initialize).toHaveBeenCalledWith({
			experimentalApi: true,
		});
		expect(mocks.client.logout).toHaveBeenCalledOnce();
		expect(mocks.client.close).toHaveBeenCalledOnce();
	});

	it("detects existing Codex app-server accounts for logout discovery", async () => {
		await expect(hasOpenAICodexAppServerAccount()).resolves.toBe(true);

		expect(mocks.client.initialize).toHaveBeenCalledWith({
			experimentalApi: true,
		});
		expect(mocks.client.readAccount).toHaveBeenCalledWith(false);
		expect(mocks.client.close).toHaveBeenCalledOnce();
	});

	it("does not force token refresh for passive app-server account discovery", async () => {
		mocks.client.readAccount.mockImplementationOnce((refreshToken: boolean) => {
			if (refreshToken) {
				throw new Error("refresh failed");
			}
			return Promise.resolve({
				account: {
					type: "chatgpt",
					email: "dev@example.com",
					planType: "pro",
				},
				requiresOpenaiAuth: false,
			});
		});

		await expect(hasOpenAICodexAppServerAccount()).resolves.toBe(true);

		expect(mocks.client.readAccount).toHaveBeenCalledWith(false);
	});

	it("treats app-server account probe failures as no account", async () => {
		mocks.client.readAccount.mockRejectedValueOnce(new Error("offline"));

		await expect(hasOpenAICodexAppServerAccount()).resolves.toBe(false);

		expect(mocks.client.close).toHaveBeenCalledOnce();
	});
});
