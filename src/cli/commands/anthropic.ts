import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import {
	type AnthropicLoginMode,
	CLAUDE_CODE_BETA_HEADER,
	deleteAnthropicOAuthCredential,
	exchangeAnthropicAuthorizationCode,
	generateAnthropicLoginUrl,
	getFreshAnthropicOAuthCredential,
	getStoredAnthropicOAuthCredential,
	saveAnthropicOAuthCredential,
} from "../../providers/anthropic-auth.js";

function parseMode(value?: string): AnthropicLoginMode {
	if (!value) return "pro";
	return value === "console" ? "console" : "pro";
}

export async function handleAnthropicCommand(
	subcommand?: string,
	params: string[] = [],
): Promise<void> {
	switch (subcommand) {
		case "login":
			await handleLogin(parseMode(params[0]));
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
					'Unknown anthropic subcommand. Try "composer anthropic login", "logout", or "status".',
				),
			);
			process.exit(1);
	}
}

async function handleLogin(mode: AnthropicLoginMode): Promise<void> {
	console.log(chalk.bold("Composer Claude Code login"));
	const { url, verifier } = await generateAnthropicLoginUrl(mode);
	console.log(chalk.gray(url));
	const rl = createInterface({ input: stdin, output: stdout });
	const code = (
		await rl.question("2. Paste the code shown in the browser: ")
	)?.trim();
	rl.close();
	if (!code) {
		console.error(chalk.red("Authorization code is required."));
		process.exit(1);
	}
	const tokens = await exchangeAnthropicAuthorizationCode(code, verifier);
	if (!tokens) {
		console.error(
			chalk.red("Failed to exchange the authorization code. Please try again."),
		);
		process.exit(1);
	}
	await saveAnthropicOAuthCredential({
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: tokens.expiresAt,
		mode,
	});
	console.log(chalk.green("Claude Code credentials saved."));
	console.log(
		chalk.dim(
			"Future runs can use --auth claude or set it as default. Credentials refresh automatically.",
		),
	);
}

async function handleLogout(): Promise<void> {
	await deleteAnthropicOAuthCredential();
	console.log(chalk.green("Removed stored Claude Code credentials."));
}

async function handleStatus(): Promise<void> {
	const stored = await getStoredAnthropicOAuthCredential();
	if (!stored) {
		console.log(chalk.yellow("No stored Claude Code credentials."));
		console.log(
			chalk.dim(
				'Run "composer anthropic login" to link a Claude Pro/Max subscription.',
			),
		);
		return;
	}
	const remainingMs = Math.max(0, stored.expiresAt - Date.now());
	const minutes = Math.round(remainingMs / 60000);
	console.log(chalk.green("Stored Claude Code credentials detected."));
	console.log(
		chalk.dim(
			`Access token expires in ~${minutes} minute${minutes === 1 ? "" : "s"} (auto-refresh enabled).`,
		),
	);
	const fresh = await getFreshAnthropicOAuthCredential();
	if (fresh) {
		console.log(chalk.dim(`Beta headers applied: ${CLAUDE_CODE_BETA_HEADER}`));
	}
}
