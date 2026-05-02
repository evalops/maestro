import chalk from "chalk";
import { hasOAuthCredentials, login, logout } from "../../oauth/index.js";
import { loadOAuthCredentials } from "../../oauth/storage.js";

export async function handleEvalOpsCommand(subcommand?: string): Promise<void> {
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
					'Unknown evalops subcommand. Try "maestro evalops login", "logout", or "status".',
				),
			);
			process.exit(1);
	}
}

async function handleLogin(): Promise<void> {
	console.log(chalk.bold("Maestro EvalOps Login"));
	await login("evalops", {
		onAuthUrl: (url) => {
			console.log(
				chalk.yellow(
					"Open this URL in your browser to authenticate with EvalOps:",
				),
			);
			console.log(chalk.underline(url));
		},
		onStatus: (status) => console.log(chalk.dim(status)),
	});
	console.log(chalk.green("EvalOps credentials saved successfully."));
	console.log(
		chalk.dim('Try "maestro --provider evalops --model gpt-4o-mini".'),
	);
}

async function handleLogout(): Promise<void> {
	await logout("evalops");
	console.log(chalk.green("Removed stored EvalOps credentials."));
}

async function handleStatus(): Promise<void> {
	if (!hasOAuthCredentials("evalops")) {
		console.log(chalk.yellow("No stored EvalOps credentials."));
		console.log(
			chalk.dim('Run "maestro evalops login" to authenticate with EvalOps.'),
		);
		return;
	}

	const credentials = loadOAuthCredentials("evalops");
	const remainingMs = Math.max(
		0,
		(credentials?.expires ?? Date.now()) - Date.now(),
	);
	const minutes = Math.round(remainingMs / 60_000);
	const metadata = credentials?.metadata;
	const organizationId =
		typeof metadata?.organizationId === "string"
			? metadata.organizationId
			: undefined;
	const providerRef =
		metadata?.providerRef &&
		typeof metadata.providerRef === "object" &&
		!Array.isArray(metadata.providerRef)
			? (metadata.providerRef as Record<string, unknown>)
			: undefined;

	console.log(chalk.green("Stored EvalOps credentials detected."));
	if (organizationId) {
		console.log(chalk.dim(`Organization: ${organizationId}`));
	}
	if (providerRef) {
		const provider =
			typeof providerRef.provider === "string"
				? providerRef.provider
				: "openai";
		const environment =
			typeof providerRef.environment === "string"
				? providerRef.environment
				: "prod";
		console.log(chalk.dim(`Provider ref: ${provider}/${environment}`));
	}
	console.log(
		chalk.dim(
			`Access token expires in ~${minutes} minute${minutes === 1 ? "" : "s"} (auto-refresh enabled).`,
		),
	);
}
