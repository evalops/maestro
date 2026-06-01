import {
	type CodexAccountReadResult,
	type CodexLoginStartResult,
	createCodexAppServerClient,
} from "./app-server-client.js";

function accountLabel(state: CodexAccountReadResult): string {
	const account = state.account;
	if (!account) {
		return "missing";
	}
	if (account.type === "chatgpt") {
		const plan =
			typeof account.planType === "string" && account.planType.length > 0
				? `, ${account.planType}`
				: "";
		return `${account.email}${plan}`;
	}
	if (account.type === "apiKey") {
		return "API key";
	}
	return account.type;
}

function isBrowserLogin(
	value: CodexLoginStartResult,
): value is { type: "chatgpt"; loginId: string; authUrl: string } {
	return (
		value.type === "chatgpt" &&
		typeof (value as { loginId?: unknown }).loginId === "string" &&
		typeof (value as { authUrl?: unknown }).authUrl === "string"
	);
}

function isDeviceCodeLogin(value: CodexLoginStartResult): value is {
	type: "chatgptDeviceCode";
	loginId: string;
	verificationUrl: string;
	userCode: string;
} {
	return (
		value.type === "chatgptDeviceCode" &&
		typeof (value as { loginId?: unknown }).loginId === "string" &&
		typeof (value as { verificationUrl?: unknown }).verificationUrl ===
			"string" &&
		typeof (value as { userCode?: unknown }).userCode === "string"
	);
}

export async function loginOpenAICodexAppServer(
	onAuthUrl: (url: string) => void,
	_onPromptCode?: () => Promise<string>,
	onStatus?: (status: string) => void,
): Promise<void> {
	const client = createCodexAppServerClient();
	try {
		await client.initialize({ experimentalApi: true });
		let currentAccount: CodexAccountReadResult | null = null;
		try {
			currentAccount = await client.readAccount(true);
		} catch {
			onStatus?.(
				"Codex app-server account refresh failed; starting sign-in to repair authentication.",
			);
		}
		if (currentAccount?.account) {
			onStatus?.(
				`Codex app-server is already authenticated: ${accountLabel(currentAccount)}.`,
			);
			return;
		}

		const login = await client.startChatGptLogin("browser", {
			codexStreamlinedLogin: true,
		});

		if (isBrowserLogin(login)) {
			onAuthUrl(login.authUrl);
			onStatus?.("Complete Codex ChatGPT sign-in in the browser.");
			await client.waitForLoginCompletion(login.loginId);
		} else if (isDeviceCodeLogin(login)) {
			onAuthUrl(login.verificationUrl);
			onStatus?.(`Complete Codex device sign-in with code ${login.userCode}.`);
			await client.waitForLoginCompletion(login.loginId);
		} else if (login.type === "apiKey") {
			onStatus?.("Codex app-server is configured with an API key.");
			return;
		} else if (login.type === "chatgptAuthTokens") {
			onStatus?.("Codex app-server is using externally managed ChatGPT auth.");
			return;
		} else {
			throw new Error(`Unsupported Codex login response: ${login.type}`);
		}

		const account = await client.readAccount(true);
		if (!account.account) {
			throw new Error("Codex app-server did not report a signed-in account.");
		}
		onStatus?.(`Codex ChatGPT sign-in complete: ${accountLabel(account)}.`);
	} finally {
		client.close();
	}
}

export async function logoutOpenAICodexAppServer(): Promise<void> {
	const client = createCodexAppServerClient();
	try {
		await client.initialize({ experimentalApi: true });
		await client.logout();
	} finally {
		client.close();
	}
}

export async function hasOpenAICodexAppServerAccount(): Promise<boolean> {
	const client = createCodexAppServerClient();
	try {
		await client.initialize({ experimentalApi: true });
		const account = await client.readAccount(false);
		return account.account !== null;
	} catch {
		return false;
	} finally {
		client.close();
	}
}
