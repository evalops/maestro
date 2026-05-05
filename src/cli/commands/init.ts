import chalk from "chalk";
import {
	type EvalOpsInitOptions,
	bootstrapEvalOpsAgent,
} from "../../evalops/agent-bootstrap.js";

function readValue(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("-")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function parsePositiveInteger(value: string, flag: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${flag} must be a positive integer`);
	}
	return parsed;
}

function appendScopes(existing: string[] | undefined, value: string): string[] {
	return [
		...(existing ?? []),
		...value
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0),
	];
}

export function parseInitArgs(args: string[]): EvalOpsInitOptions {
	const options: EvalOpsInitOptions = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--agent-mcp-url":
			case "--mcp-url":
				options.mcpUrl = readValue(args, i, arg);
				i++;
				break;
			case "--agent-type":
				options.agentType = readValue(args, i, arg);
				i++;
				break;
			case "--api-key-scope":
			case "--key-scope":
				options.apiKeyScopes = appendScopes(
					options.apiKeyScopes,
					readValue(args, i, arg),
				);
				i++;
				break;
			case "--expires-in-days":
				options.expiresInDays = parsePositiveInteger(
					readValue(args, i, arg),
					arg,
				);
				i++;
				break;
			case "--force-login":
				options.forceLogin = true;
				break;
			case "--json":
				options.json = true;
				break;
			case "--key-name":
				options.keyName = readValue(args, i, arg);
				i++;
				break;
			case "--manifest-url":
				options.manifestUrl = readValue(args, i, arg);
				i++;
				break;
			case "--register-scope":
			case "--scope":
				options.registerScopes = appendScopes(
					options.registerScopes,
					readValue(args, i, arg),
				);
				i++;
				break;
			case "--rotate-key":
				options.rotateKey = true;
				break;
			case "--surface":
				options.surface = readValue(args, i, arg);
				i++;
				break;
			case "--ttl-seconds":
				options.ttlSeconds = parsePositiveInteger(readValue(args, i, arg), arg);
				i++;
				break;
			case "--workspace":
			case "--workspace-id":
				options.workspaceId = readValue(args, i, arg);
				i++;
				break;
			default:
				if (arg?.startsWith("-")) {
					throw new Error(`Unknown maestro init option: ${arg}`);
				}
				throw new Error(`Unexpected maestro init argument: ${arg}`);
		}
	}
	return options;
}

export async function handleInitCommand(args: string[] = []): Promise<void> {
	let options: EvalOpsInitOptions;
	try {
		options = parseInitArgs(args);
	} catch (error) {
		console.error(
			chalk.red(error instanceof Error ? error.message : String(error)),
		);
		process.exit(1);
	}

	if (!options.json) {
		console.log(chalk.bold("Maestro EvalOps Init"));
	}

	const result = await bootstrapEvalOpsAgent(options, {
		onAuthUrl: (url) => {
			if (options.json) {
				console.error(
					"Open this URL in your browser to authenticate with EvalOps:",
				);
				console.error(url);
				return;
			}
			console.log(
				chalk.yellow(
					"Open this URL in your browser to authenticate with EvalOps:",
				),
			);
			console.log(chalk.underline(url));
		},
		onStatus: (status) => {
			if (options.json) {
				console.error(status.message);
				return;
			}
			console.log(chalk.dim(status.message));
		},
	});

	if (options.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	console.log(chalk.green("EvalOps agent bootstrap complete."));
	console.log(chalk.dim(`MCP endpoint: ${result.endpoint}`));
	if (result.organizationId) {
		console.log(chalk.dim(`Organization: ${result.organizationId}`));
	}
	if (result.agentId) {
		console.log(chalk.dim(`Agent: ${result.agentId}`));
	}
	if (result.runId) {
		console.log(chalk.dim(`Run: ${result.runId}`));
	}
	if (result.keyPrefix) {
		const keyMode = result.apiKeyCreated ? "created" : "reused";
		console.log(chalk.dim(`API key ${keyMode}: ${result.keyPrefix}`));
	}
	console.log(
		chalk.dim(
			"Stored EvalOps MCP credentials locally for future Maestro sessions.",
		),
	);
}
