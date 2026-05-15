import chalk from "chalk";
import {
	type CodexAccountReadResult,
	createCodexAppServerClient,
} from "../../codex/app-server-client.js";

export async function handleCodexCommand(
	subcommand?: string,
	params: string[] = [],
): Promise<void> {
	switch (subcommand) {
		case "login":
			await handleLogin(params);
			return;
		case "logout":
			await handleLogout();
			return;
		case "status":
			await handleStatus();
			return;
		default:
			console.error(
				chalk.red(
					'Unknown codex subcommand. Try "maestro codex login", "logout", or "status".',
				),
			);
			process.exit(1);
	}
}

async function handleLogin(params: string[] = []): Promise<void> {
	const deviceFlow =
		params.includes("--device") || params.includes("--device-code");
	console.log(chalk.bold("Maestro OpenAI Codex Login"));
	const client = createCodexAppServerClient();
	try {
		await client.initialize();
		const login = await client.startChatGptLogin(
			deviceFlow ? "device" : "browser",
		);
		if (isBrowserLogin(login)) {
			console.log(
				chalk.yellow("Open this URL in your browser to sign in with ChatGPT:"),
			);
			console.log(chalk.underline(login.authUrl));
			console.log(chalk.dim("Waiting for ChatGPT sign-in to complete..."));
			await client.waitForLoginCompletion(login.loginId);
		} else if (isDeviceCodeLogin(login)) {
			console.log(chalk.yellow("Open this URL and enter the code:"));
			console.log(chalk.underline(login.verificationUrl));
			console.log(chalk.bold(login.userCode));
			console.log(chalk.dim("Waiting for ChatGPT sign-in to complete..."));
			await client.waitForLoginCompletion(login.loginId);
		} else if (isApiKeyLogin(login)) {
			console.log(
				chalk.green("OpenAI Codex is already configured with an API key."),
			);
			console.log(
				chalk.dim(
					'Select provider "openai-codex" or a model like "openai-codex/gpt-5.5".',
				),
			);
			return;
		} else {
			throw new Error(`Unsupported Codex login response: ${login.type}`);
		}
		const account = await client.readAccount(true);
		console.log(chalk.green(`Signed in with ChatGPT${accountLabel(account)}.`));
		console.log(
			chalk.dim(
				'Select provider "openai-codex" or a model like "openai-codex/gpt-5.5".',
			),
		);
	} finally {
		client.close();
	}
}

async function handleLogout(): Promise<void> {
	const client = createCodexAppServerClient();
	try {
		await client.initialize();
		await client.logout();
		console.log(chalk.green("Signed out of ChatGPT for OpenAI Codex."));
	} finally {
		client.close();
	}
}

async function handleStatus(): Promise<void> {
	const client = createCodexAppServerClient();
	try {
		await client.initialize();
		const account = await client.readAccount(true);
		if (!account.account) {
			console.log(chalk.yellow("No ChatGPT sign-in for OpenAI Codex."));
			console.log(
				chalk.dim('Run "maestro codex login" to sign in with ChatGPT.'),
			);
			return;
		}
		console.log(
			chalk.green(`OpenAI Codex is signed in${accountLabel(account)}.`),
		);
	} finally {
		client.close();
	}
}

function accountLabel(state: CodexAccountReadResult): string {
	const account = state.account;
	if (!account || account.type !== "chatgpt") {
		return "";
	}
	const plan =
		typeof account.planType === "string" && account.planType.length > 0
			? `, ${account.planType}`
			: "";
	return ` as ${account.email}${plan}`;
}

function isBrowserLogin(
	value: unknown,
): value is { type: "chatgpt"; loginId: string; authUrl: string } {
	return (
		Boolean(value && typeof value === "object") &&
		(value as { type?: unknown }).type === "chatgpt" &&
		typeof (value as { loginId?: unknown }).loginId === "string" &&
		typeof (value as { authUrl?: unknown }).authUrl === "string"
	);
}

function isApiKeyLogin(value: unknown): value is { type: "apiKey" } {
	return (
		Boolean(value && typeof value === "object") &&
		(value as { type?: unknown }).type === "apiKey"
	);
}

function isDeviceCodeLogin(value: unknown): value is {
	type: "chatgptDeviceCode";
	loginId: string;
	verificationUrl: string;
	userCode: string;
} {
	return (
		Boolean(value && typeof value === "object") &&
		(value as { type?: unknown }).type === "chatgptDeviceCode" &&
		typeof (value as { loginId?: unknown }).loginId === "string" &&
		typeof (value as { verificationUrl?: unknown }).verificationUrl ===
			"string" &&
		typeof (value as { userCode?: unknown }).userCode === "string"
	);
}
