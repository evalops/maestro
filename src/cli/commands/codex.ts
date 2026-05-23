import chalk from "chalk";
import {
	type CodexAccountReadResult,
	createCodexAppServerClient,
} from "../../codex/app-server-client.js";
import {
	compileCodexDynamicToolSpecs,
	resolveCodexToolProfileName,
	selectCodexToolProfile,
} from "../../codex/compatibility.js";
import { codingTools } from "../../tools/index.js";

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
		case "doctor":
			await handleDoctor();
			return;
		default:
			console.error(
				chalk.red(
					'Unknown codex subcommand. Try "maestro codex login", "logout", "status", or "doctor".',
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

async function handleDoctor(): Promise<void> {
	console.log(chalk.bold("Maestro Codex Doctor"));
	const client = createCodexAppServerClient();
	try {
		await client.initialize({ experimentalApi: true });
		const account = await client.readAccount(true);
		if (!account.account) {
			console.log(chalk.yellow("ChatGPT sign-in: missing"));
			console.log(
				chalk.dim('Run "maestro codex login" to sign in with ChatGPT.'),
			);
			process.exitCode = 1;
		} else {
			console.log(
				chalk.green(`ChatGPT sign-in: ${accountDoctorLabel(account)}`),
			);
		}

		const profileName = resolveCodexToolProfileName(
			process.env.MAESTRO_CODEX_TOOL_PROFILE,
		);
		const selectedTools = selectCodexToolProfile(codingTools, profileName);
		const compiled = compileCodexDynamicToolSpecs(selectedTools);
		console.log(
			chalk.green(
				`Codex tool profile (${profileName}): ${selectedTools.length} tools (${selectedTools
					.map((tool) => tool.name)
					.join(", ")})`,
			),
		);

		const errors = compiled.diagnostics.filter(
			(diagnostic) => diagnostic.severity === "error",
		);
		if (errors.length > 0) {
			process.exitCode = 1;
			console.log(chalk.red(`Dynamic tool schema: ${errors.length} error(s)`));
		} else {
			console.log(chalk.green("Dynamic tool schema: compatible"));
		}
		for (const diagnostic of compiled.diagnostics) {
			const formatter =
				diagnostic.severity === "error"
					? chalk.red
					: diagnostic.severity === "warning"
						? chalk.yellow
						: chalk.dim;
			console.log(formatter(`${diagnostic.code}: ${diagnostic.message}`));
		}
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

function accountDoctorLabel(state: CodexAccountReadResult): string {
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
