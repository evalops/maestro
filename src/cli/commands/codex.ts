import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { hasOAuthCredentials, login, logout } from "../../oauth/index.js";
import { loadOAuthCredentials } from "../../oauth/storage.js";

export async function handleCodexCommand(
	subcommand?: string,
	_params: string[] = [],
): Promise<void> {
	switch (subcommand) {
		case "login":
			await handleLogin();
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

async function promptCode(): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await rl.question(
			"Paste the OpenAI redirect URL or authorization code: ",
		);
	} finally {
		rl.close();
	}
}

async function handleLogin(): Promise<void> {
	console.log(chalk.bold("Maestro OpenAI Codex Login"));
	await login("openai-codex", {
		onAuthUrl: (url) => {
			console.log(
				chalk.yellow(
					"Open this URL in your browser to authenticate with OpenAI:",
				),
			);
			console.log(chalk.underline(url));
		},
		onPromptCode: promptCode,
		onStatus: (status) => console.log(chalk.dim(status)),
	});
	console.log(chalk.green("OpenAI Codex credentials saved successfully."));
	console.log(
		chalk.dim(
			'Select provider "openai-codex" or a model like "openai-codex/gpt-5.5".',
		),
	);
}

async function handleLogout(): Promise<void> {
	await logout("openai-codex");
	console.log(chalk.green("Removed stored OpenAI Codex credentials."));
}

async function handleStatus(): Promise<void> {
	if (!hasOAuthCredentials("openai-codex")) {
		console.log(chalk.yellow("No stored OpenAI Codex credentials."));
		console.log(
			chalk.dim('Run "maestro codex login" to authenticate with OpenAI.'),
		);
		return;
	}
	const credentials = loadOAuthCredentials("openai-codex");
	const remainingMs = Math.max(
		0,
		(credentials?.expires ?? Date.now()) - Date.now(),
	);
	const minutes = Math.round(remainingMs / 60_000);
	const accountId =
		typeof credentials?.metadata?.accountId === "string"
			? credentials.metadata.accountId
			: undefined;
	console.log(chalk.green("Stored OpenAI Codex credentials detected."));
	if (accountId) {
		console.log(chalk.dim(`ChatGPT account id: ${accountId}`));
	}
	console.log(
		chalk.dim(
			`Access token expires in ~${minutes} minute${minutes === 1 ? "" : "s"} (auto-refresh enabled).`,
		),
	);
}
