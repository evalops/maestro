import chalk from "chalk";
import {
	formatManagedEvalOpsStatus,
	resolveManagedEvalOpsContext,
} from "../../evalops/managed-context.js";
import { hasOAuthCredentials, login, logout } from "../../oauth/index.js";

export async function handleEvalOpsCommand(
	subcommand?: string,
	args: string[] = [],
): Promise<void> {
	switch (subcommand) {
		case "init": {
			const { handleInitCommand } = await import("./init.js");
			await handleInitCommand(args);
			return;
		}
		case "login":
			await handleLogin();
			return;
		case "logout":
			await handleLogout();
			return;
		case "status":
			await handleEvalOpsStatus();
			return;
		default:
			console.error(
				chalk.red(
					'Unknown evalops subcommand. Try "maestro init" for setup, or "maestro evalops login", "logout", or "status".',
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

export async function handleEvalOpsStatus(): Promise<void> {
	if (!hasOAuthCredentials("evalops")) {
		console.log(chalk.yellow("No stored EvalOps credentials."));
		console.log(
			chalk.dim('Run "maestro evalops login" to authenticate with EvalOps.'),
		);
		return;
	}

	console.log(chalk.green("Stored EvalOps credentials detected."));
	const context = resolveManagedEvalOpsContext();
	console.log(formatManagedEvalOpsStatus(context));
	if (!context.managed) {
		console.log(
			chalk.yellow('No EvalOps agent session yet. Run "maestro init".'),
		);
	}
}
