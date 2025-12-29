#!/usr/bin/env node

/**
 * GitHub Agent - Entry Point
 *
 * An autonomous agent that watches GitHub issues and creates PRs.
 * Composer building Composer.
 */

import { resolve } from "node:path";
import { Orchestrator, type OrchestratorConfig } from "./orchestrator.js";
import { DEFAULT_CONFIG } from "./types.js";

function printUsage(): void {
	console.error("GitHub Agent - Composer building Composer");
	console.error("");
	console.error("Usage: github-agent <owner/repo> [options]");
	console.error("");
	console.error("Options:");
	console.error(
		"  --working-dir <path>    Working directory for the repo (default: ./workspace)",
	);
	console.error(
		"  --memory-dir <path>     Memory storage directory (default: ./memory)",
	);
	console.error(
		"  --labels <labels>       Comma-separated issue labels to watch (default: composer-task)",
	);
	console.error(
		"  --poll-interval <ms>    Poll interval in milliseconds (default: 60000)",
	);
	console.error("  --max-attempts <n>      Max attempts per task (default: 3)");
	console.error(
		"  --daily-budget <$>      Daily spending limit in dollars (default: 50)",
	);
	console.error("  --no-tests              Skip test requirement");
	console.error("  --no-lint               Skip lint requirement");
	console.error("  --no-self-review        Skip self-review step");
	console.error(
		"  --issue <number>        Process a specific issue immediately and exit",
	);
	console.error("  --github-api-url <url>  Override GitHub API base URL");
	console.error("  --github-app-id <id>    GitHub App ID (for App auth)");
	console.error(
		"  --github-app-private-key <pem>   GitHub App private key (PEM or base64)",
	);
	console.error(
		"  --github-app-private-key-file <path>  GitHub App private key path",
	);
	console.error(
		"  --github-app-installation-id <id>     GitHub App installation id",
	);
	console.error(
		"  --webhook-secret <secret>  Shared secret for webhook verification",
	);
	console.error("  --webhook-port <port>    Webhook port (default: 8787)");
	console.error(
		"  --webhook-path <path>    Webhook path (default: /github/webhooks)",
	);
	console.error(
		"  --webhook-mode <mode>    poll | webhook | hybrid (default: poll)",
	);
	console.error("  --help                  Show this help");
	console.error("");
	console.error("Environment variables:");
	console.error(
		"  GITHUB_TOKEN            GitHub personal access token (optional if App auth)",
	);
	console.error(
		"  GITHUB_APP_ID           GitHub App ID (optional if PAT auth)",
	);
	console.error(
		"  GITHUB_APP_PRIVATE_KEY  GitHub App private key (PEM or base64)",
	);
	console.error("  GITHUB_APP_PRIVATE_KEY_PATH  GitHub App private key path");
	console.error("  GITHUB_APP_INSTALLATION_ID   GitHub App installation id");
	console.error("  GITHUB_API_URL          GitHub API base URL (GHES support)");
	console.error("  GITHUB_WEBHOOK_SECRET   Webhook secret for verification");
	console.error("  GITHUB_WEBHOOK_PORT     Webhook port");
	console.error("  GITHUB_WEBHOOK_PATH     Webhook path");
	console.error("  GITHUB_WEBHOOK_MODE     poll | webhook | hybrid");
	console.error(
		"  ANTHROPIC_API_KEY       Anthropic API key (required for composer)",
	);
	console.error("");
	console.error("Examples:");
	console.error("  github-agent evalops/composer");
	console.error(
		"  github-agent evalops/composer --labels good-first-issue,composer-task",
	);
	console.error("  github-agent evalops/composer --issue 42");
	console.error(
		"  github-agent evalops/composer --webhook-secret $SECRET --webhook-mode hybrid",
	);
}

function parseArgs(): {
	config: Partial<OrchestratorConfig>;
	singleIssue?: number;
} {
	const args = process.argv.slice(2);
	const config: Partial<OrchestratorConfig> = { ...DEFAULT_CONFIG };
	let singleIssue: number | undefined;

	// Helper to get and validate the next argument value
	const requireArg = (flag: string, index: number): string => {
		const nextIndex = index + 1;
		if (nextIndex >= args.length || args[nextIndex].startsWith("-")) {
			console.error(`Error: ${flag} requires a value`);
			process.exit(1);
		}
		return args[nextIndex];
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			printUsage();
			process.exit(0);
		} else if (arg === "--working-dir") {
			config.workingDir = resolve(requireArg(arg, i));
			i++;
		} else if (arg === "--memory-dir") {
			config.memoryDir = resolve(requireArg(arg, i));
			i++;
		} else if (arg === "--labels") {
			config.issueLabels = requireArg(arg, i)
				.split(",")
				.map((l) => l.trim());
			i++;
		} else if (arg === "--poll-interval") {
			config.pollIntervalMs = Number.parseInt(requireArg(arg, i), 10);
			i++;
		} else if (arg === "--max-attempts") {
			config.maxAttemptsPerTask = Number.parseInt(requireArg(arg, i), 10);
			i++;
		} else if (arg === "--daily-budget") {
			config.dailyBudget = Number.parseFloat(requireArg(arg, i));
			i++;
		} else if (arg === "--no-tests") {
			config.requireTests = false;
		} else if (arg === "--no-lint") {
			config.requireLint = false;
		} else if (arg === "--no-self-review") {
			config.selfReview = false;
		} else if (arg === "--issue") {
			singleIssue = Number.parseInt(requireArg(arg, i), 10);
			i++;
		} else if (arg === "--github-api-url") {
			config.githubApiUrl = requireArg(arg, i);
			i++;
		} else if (arg === "--github-app-id") {
			config.githubAppId = requireArg(arg, i);
			i++;
		} else if (arg === "--github-app-private-key") {
			config.githubAppPrivateKey = requireArg(arg, i);
			i++;
		} else if (arg === "--github-app-private-key-file") {
			config.githubAppPrivateKeyPath = requireArg(arg, i);
			i++;
		} else if (arg === "--github-app-installation-id") {
			config.githubAppInstallationId = Number.parseInt(requireArg(arg, i), 10);
			i++;
		} else if (arg === "--webhook-secret") {
			config.webhookSecret = requireArg(arg, i);
			i++;
		} else if (arg === "--webhook-port") {
			config.webhookPort = Number.parseInt(requireArg(arg, i), 10);
			i++;
		} else if (arg === "--webhook-path") {
			config.webhookPath = requireArg(arg, i);
			i++;
		} else if (arg === "--webhook-mode") {
			config.webhookMode = requireArg(
				arg,
				i,
			) as OrchestratorConfig["webhookMode"];
			i++;
		} else if (!arg.startsWith("-") && !config.owner) {
			// Parse owner/repo
			const [owner, repo] = arg.split("/");
			if (!owner || !repo) {
				console.error(`Invalid repository format: ${arg}`);
				console.error("Expected: owner/repo");
				process.exit(1);
			}
			config.owner = owner;
			config.repo = repo;
		} else if (arg.startsWith("-")) {
			console.error(`Unknown option: ${arg}`);
			process.exit(1);
		}
	}

	return { config, singleIssue };
}

async function main(): Promise<void> {
	const { config, singleIssue } = parseArgs();

	// Validate required arguments
	if (!config.owner || !config.repo) {
		printUsage();
		process.exit(1);
	}

	// Check environment
	const githubToken = process.env.GITHUB_TOKEN;
	const appId = process.env.GITHUB_APP_ID;
	const appKey = process.env.GITHUB_APP_PRIVATE_KEY;
	const appKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
	const appInstallationId = process.env.GITHUB_APP_INSTALLATION_ID;
	const apiUrl = process.env.GITHUB_API_URL;
	const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
	const webhookPort = process.env.GITHUB_WEBHOOK_PORT;
	const webhookPath = process.env.GITHUB_WEBHOOK_PATH;
	const webhookMode = process.env.GITHUB_WEBHOOK_MODE;

	config.githubToken = config.githubToken ?? githubToken;
	config.githubAppId = config.githubAppId ?? appId;
	config.githubAppPrivateKey = config.githubAppPrivateKey ?? appKey;
	config.githubAppPrivateKeyPath = config.githubAppPrivateKeyPath ?? appKeyPath;
	config.githubAppInstallationId =
		config.githubAppInstallationId ??
		(appInstallationId ? Number.parseInt(appInstallationId, 10) : undefined);
	config.githubApiUrl = config.githubApiUrl ?? apiUrl;
	config.webhookSecret = config.webhookSecret ?? webhookSecret;
	config.webhookPort =
		config.webhookPort ??
		(webhookPort ? Number.parseInt(webhookPort, 10) : undefined);
	config.webhookPath = config.webhookPath ?? webhookPath;
	config.webhookMode =
		config.webhookMode ?? (webhookMode as OrchestratorConfig["webhookMode"]);

	if (
		!config.githubToken &&
		!(
			config.githubAppId &&
			(config.githubAppPrivateKey || config.githubAppPrivateKeyPath)
		)
	) {
		console.error(
			"Error: Either GITHUB_TOKEN or GitHub App credentials are required",
		);
		process.exit(1);
	}

	if (!process.env.ANTHROPIC_API_KEY) {
		console.error("Error: ANTHROPIC_API_KEY environment variable is required");
		process.exit(1);
	}

	// Set defaults
	config.workingDir = config.workingDir || resolve("./workspace");
	config.memoryDir = config.memoryDir || resolve("./memory");
	config.baseBranch = config.baseBranch || "main";
	config.webhookPort = config.webhookPort ?? 8787;
	config.webhookPath = config.webhookPath ?? "/github/webhooks";
	config.webhookMode = config.webhookMode ?? "poll";
	if (config.webhookMode !== "poll" && !config.webhookSecret) {
		if (config.webhookMode === "webhook") {
			console.error(
				"Error: --webhook-mode=webhook requires --webhook-secret or GITHUB_WEBHOOK_SECRET",
			);
			process.exit(1);
		}
		console.warn(
			"[github-agent] Webhook mode requires a secret; falling back to polling.",
		);
		config.webhookMode = "poll";
	}

	// Create and start orchestrator
	const orchestrator = new Orchestrator(config as OrchestratorConfig);

	// Handle shutdown
	const shutdown = async (signal: string) => {
		console.log(`\nReceived ${signal}, shutting down...`);
		await orchestrator.stop();
		process.exit(0);
	};

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));

	if (singleIssue !== undefined) {
		// Single issue mode - process and exit
		console.log(`Processing issue #${singleIssue}...`);
		await orchestrator.processIssue(singleIssue);
		await orchestrator.stop();
	} else {
		// Daemon mode - run continuously
		await orchestrator.start();

		// Keep alive
		await new Promise(() => {});
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
