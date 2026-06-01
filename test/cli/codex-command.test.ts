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
		mocks.client.readAccount.mockResolvedValueOnce({
			account: null,
			requiresOpenaiAuth: true,
		});
		mocks.client.startChatGptLogin.mockResolvedValue({ type: "apiKey" });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await handleCodexCommand("login");

		expect(mocks.client.readAccount).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("already configured with an API key"),
		);
		expect(mocks.client.close).toHaveBeenCalledOnce();

		log.mockRestore();
	});

	it("runs browser ChatGPT sign-in and refreshes account status", async () => {
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
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await handleCodexCommand("login");

		expect(mocks.client.initialize).toHaveBeenCalledWith({
			experimentalApi: true,
		});
		expect(mocks.client.startChatGptLogin).toHaveBeenCalledWith("browser", {
			codexStreamlinedLogin: true,
		});
		expect(mocks.client.waitForLoginCompletion).toHaveBeenCalledWith("login-1");
		expect(mocks.client.readAccount).toHaveBeenCalledWith(true);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("Signed in with ChatGPT as dev@example.com, pro"),
		);
		expect(mocks.client.close).toHaveBeenCalledOnce();

		log.mockRestore();
	});

	it("starts browser ChatGPT sign-in when the existing account refresh fails", async () => {
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
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await handleCodexCommand("login");

		expect(mocks.client.startChatGptLogin).toHaveBeenCalledWith("browser", {
			codexStreamlinedLogin: true,
		});
		expect(mocks.client.waitForLoginCompletion).toHaveBeenCalledWith("login-1");
		expect(mocks.client.readAccount).toHaveBeenCalledWith(true);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining(
				"Codex app-server account refresh failed; starting a new sign-in flow.",
			),
		);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("Signed in with ChatGPT as dev@example.com, pro"),
		);
		expect(mocks.client.close).toHaveBeenCalledOnce();

		log.mockRestore();
	});

	it("supports ChatGPT device-code sign-in", async () => {
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
		mocks.client.startChatGptLogin.mockResolvedValue({
			type: "chatgptDeviceCode",
			loginId: "login-device-1",
			verificationUrl: "https://chatgpt.test/device",
			userCode: "ABCD-EFGH",
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await handleCodexCommand("login", ["--device"]);

		expect(mocks.client.startChatGptLogin).toHaveBeenCalledWith("device", {
			codexStreamlinedLogin: true,
		});
		expect(mocks.client.waitForLoginCompletion).toHaveBeenCalledWith(
			"login-device-1",
		);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("ABCD-EFGH"));
		expect(mocks.client.close).toHaveBeenCalledOnce();

		log.mockRestore();
	});

	it("reports existing Codex sign-in instead of starting another flow", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await handleCodexCommand("login");

		expect(mocks.client.startChatGptLogin).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("already signed in as dev@example.com, pro"),
		);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("maestro codex login --force"),
		);
		expect(mocks.client.close).toHaveBeenCalledOnce();

		log.mockRestore();
	});

	it("forces a fresh Codex sign-in flow when requested", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await handleCodexCommand("login", ["--force"]);

		expect(mocks.client.readAccount).toHaveBeenCalledWith(true);
		expect(mocks.client.startChatGptLogin).toHaveBeenCalledWith("browser", {
			codexStreamlinedLogin: true,
		});
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("Signed in with ChatGPT as dev@example.com, pro"),
		);

		log.mockRestore();
	});

	it("recognizes current Codex device-auth spelling", async () => {
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
		mocks.client.startChatGptLogin.mockResolvedValue({
			type: "chatgptDeviceCode",
			loginId: "login-device-1",
			verificationUrl: "https://chatgpt.test/device",
			userCode: "ABCD-EFGH",
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await handleCodexCommand("login", ["--device-auth"]);

		expect(mocks.client.startChatGptLogin).toHaveBeenCalledWith("device", {
			codexStreamlinedLogin: true,
		});

		log.mockRestore();
	});

	it("handles externally managed Codex ChatGPT auth tokens", async () => {
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
		mocks.client.startChatGptLogin.mockResolvedValue({
			type: "chatgptAuthTokens",
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await handleCodexCommand("login");

		expect(mocks.client.waitForLoginCompletion).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("externally managed ChatGPT auth"),
		);

		log.mockRestore();
	});

	it("reports current Codex app-server sign-in status", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await handleCodexCommand("status");

		expect(mocks.client.initialize).toHaveBeenCalled();
		expect(mocks.client.readAccount).toHaveBeenCalledWith(true);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining(
				"OpenAI Codex is signed in as dev@example.com, pro",
			),
		);
		expect(mocks.client.close).toHaveBeenCalledOnce();

		log.mockRestore();
	});

	it("logs out of ChatGPT for Codex", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await handleCodexCommand("logout");

		expect(mocks.client.initialize).toHaveBeenCalled();
		expect(mocks.client.logout).toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("Signed out of ChatGPT for OpenAI Codex"),
		);
		expect(mocks.client.close).toHaveBeenCalledOnce();

		log.mockRestore();
	});

	it("reports app-server auth and Codex tool profile health", async () => {
		const originalProfile = process.env.MAESTRO_CODEX_TOOL_PROFILE;
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			process.env.MAESTRO_CODEX_TOOL_PROFILE = "read-only";
			await handleCodexCommand("doctor");

			expect(mocks.client.initialize).toHaveBeenCalled();
			expect(mocks.client.readAccount).toHaveBeenCalledWith(true);
			expect(log).toHaveBeenCalledWith(expect.stringContaining("Codex Doctor"));
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining("ChatGPT sign-in: dev@example.com, pro"),
			);
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining("Codex tool profile (read-only):"),
			);
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining("Dynamic tool schema: compatible"),
			);
			expect(mocks.client.close).toHaveBeenCalledOnce();
		} finally {
			if (typeof originalProfile === "string") {
				process.env.MAESTRO_CODEX_TOOL_PROFILE = originalProfile;
			} else {
				delete process.env.MAESTRO_CODEX_TOOL_PROFILE;
			}
		}

		log.mockRestore();
	});
});
