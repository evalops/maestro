import { timingSafeEqual } from "node:crypto";
import {
	type IncomingMessage,
	type ServerResponse,
	createServer,
} from "node:http";
import { URL } from "node:url";
import chalk from "chalk";
import {
	deleteOpenAIOAuthCredential,
	exchangeIdTokenForApiKey,
	exchangeOpenAIAuthorizationCode,
	generateOpenAILoginUrl,
	getFreshOpenAIOAuthCredential,
	getStoredOpenAIOAuthCredential,
	saveOpenAIOAuthCredential,
} from "../../providers/openai-auth.js";

export async function handleOpenAICommand(
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
					'Unknown openai subcommand. Try "composer openai login", "logout", or "status".',
				),
			);
			process.exit(1);
	}
}

async function handleLogin(): Promise<void> {
	console.log(chalk.bold("Composer OpenAI Login"));
	const { url, verifier, state } = await generateOpenAILoginUrl();

	console.log(
		chalk.yellow(
			"Please open the following URL in your browser to authenticate:",
		),
	);
	console.log(chalk.underline(url));

	const server = createServer(
		async (req: IncomingMessage, res: ServerResponse) => {
			const reqUrl = new URL(req.url ?? "", "http://localhost:1455");

			if (reqUrl.pathname === "/auth/callback") {
				const code = reqUrl.searchParams.get("code");
				const callbackState = reqUrl.searchParams.get("state");

				if (
					!callbackState ||
					callbackState.length !== state.length ||
					!timingSafeEqual(Buffer.from(callbackState), Buffer.from(state))
				) {
					res.writeHead(400, { "Content-Type": "text/plain" });
					res.end("State mismatch. Possible CSRF attack.");
					setTimeout(() => server.close(), 100);
					return;
				}

				if (!code) {
					res.writeHead(400, { "Content-Type": "text/plain" });
					res.end("Authorization code missing.");
					setTimeout(() => server.close(), 100);
					return;
				}

				try {
					const tokens = await exchangeOpenAIAuthorizationCode(code, verifier);
					if (!tokens) {
						throw new Error("Failed to exchange code for tokens.");
					}

					// Exchange ID token for API key
					const apiKey = await exchangeIdTokenForApiKey(tokens.idToken);
					if (!apiKey) {
						throw new Error("Failed to exchange ID token for API key.");
					}

					await saveOpenAIOAuthCredential({
						accessToken: tokens.accessToken,
						refreshToken: tokens.refreshToken,
						idToken: tokens.idToken,
						expiresAt: tokens.expiresAt,
						apiKey,
						mode: "chatgpt",
					});

					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(
						"<html><body><h1>Login Successful</h1><p>You can close this tab and return to the terminal.</p></body></html>",
					);
					console.log(chalk.green("\nOpenAI credentials saved successfully."));
					console.log(
						chalk.dim(
							"Future runs can use --auth chatgpt or set it as default.",
						),
					);
				} catch (error) {
					const errorMsg =
						error instanceof Error ? error.message : "Unknown error";
					console.error(chalk.red(`\nLogin failed: ${errorMsg}`));
					res.writeHead(500, { "Content-Type": "text/plain" });
					res.end("Login failed. Check terminal for details.");
				} finally {
					// Allow response to complete before closing
					setTimeout(() => server.close(), 100);
				}
			} else {
				res.writeHead(404);
				res.end("Not Found");
			}
		},
	);

	server.on("error", (e: NodeJS.ErrnoException) => {
		if (e.code === "EADDRINUSE") {
			console.error(
				chalk.red(
					"Port 1455 is already in use. Please close the other process and try again.",
				),
			);
			process.exit(1);
		}
		console.error(chalk.red(`Server error: ${e.message}`));
		process.exit(1);
	});

	server.listen(1455, "127.0.0.1");
}

async function handleLogout(): Promise<void> {
	await deleteOpenAIOAuthCredential();
	console.log(chalk.green("Removed stored OpenAI credentials."));
}

async function handleStatus(): Promise<void> {
	const stored = await getStoredOpenAIOAuthCredential();
	if (!stored) {
		console.log(chalk.yellow("No stored OpenAI credentials."));
		console.log(
			chalk.dim('Run "composer openai login" to authenticate with OpenAI.'),
		);
		return;
	}
	const remainingMs = Math.max(0, stored.expiresAt - Date.now());
	const minutes = Math.round(remainingMs / 60000);
	console.log(chalk.green("Stored OpenAI credentials detected."));
	console.log(
		chalk.dim(
			`Access token expires in ~${minutes} minute${minutes === 1 ? "" : "s"} (auto-refresh enabled).`,
		),
	);
	const fresh = await getFreshOpenAIOAuthCredential();
	if (fresh) {
		console.log(chalk.dim("Credentials refreshed."));
	}
}
