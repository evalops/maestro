import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	client: {
		initialize: vi.fn(),
		startChatGptLogin: vi.fn(),
		waitForLoginCompletion: vi.fn(),
		readAccount: vi.fn(),
		logout: vi.fn(),
		close: vi.fn(),
	},
}));

vi.mock("../../src/codex/app-server-client.js", () => ({
	createCodexAppServerClient: () => mocks.client,
}));

const { handleCodexCommand } = await import("../../src/cli/commands/codex.js");

describe("codex CLI command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.client.initialize.mockResolvedValue({});
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
		mocks.client.readAccount.mockResolvedValue({
			account: {
				type: "chatgpt",
				email: "dev@example.com",
				planType: "pro",
			},
			requiresOpenaiAuth: false,
		});
	});

	it("treats apiKey login-start as already configured", async () => {
		mocks.client.startChatGptLogin.mockResolvedValue({ type: "apiKey" });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await handleCodexCommand("login");

		expect(mocks.client.readAccount).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("already configured with an API key"),
		);
		expect(mocks.client.close).toHaveBeenCalledOnce();

		log.mockRestore();
	});
});
