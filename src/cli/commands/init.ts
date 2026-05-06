import chalk from "chalk";
import {
	type EvalOpsInitOptions,
	bootstrapEvalOpsAgent,
} from "../../evalops/agent-bootstrap.js";
import { muted, sectionHeading } from "../../style/theme.js";

export function formatInitHelp(): string {
	return `${sectionHeading("maestro init")}${muted(
		`  maestro init                         Login, create or reuse an API key, and register this agent
  maestro init --rotate-key           Replace the stored agent MCP API key
  maestro init --mcp-url <url>        Override the EvalOps agent MCP endpoint
  maestro init --json                 Emit machine-readable bootstrap output

Options
  --agent-type <type>                 Agent type to register, defaults to maestro
  --surface <surface>                 Surface to register, defaults to cli
  --integration-profile <profile>     mcp_only, mcp_otlp, managed_runtime, sdk_integrated, or provider_proxy
  --shim-type <type>                  native_mcp, command_wrapper, hook, provider_proxy, sdk, or mcp_firewall_proxy
  --trace-mode <mode>                 none, mcp_events, or otlp
  --memory-mode <mode>                none, read_only, durable, or cerebro
  --runtime-owner <owner>             external or evalops
  --workspace, --workspace-id <id>    Workspace to associate with the registration
  --scope <scope[,scope...]>          Registration scopes to request
  --key-scope <scope[,scope...]>      API key scopes to request
  --expires-in-days <days>            API key TTL in days
  --force-login                       Re-run EvalOps OAuth before bootstrapping
  --manifest-url <url>                Override the agent MCP manifest URL
  --ttl-seconds <seconds>             Registration TTL in seconds`,
	)}`;
}

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
			case "--integration-profile":
				options.integrationProfile = readValue(args, i, arg);
				i++;
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
			case "--memory-mode":
				options.memoryMode = readValue(args, i, arg);
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
			case "--runtime-owner":
				options.runtimeOwner = readValue(args, i, arg);
				i++;
				break;
			case "--shim-type":
				options.shimType = readValue(args, i, arg);
				i++;
				break;
			case "--surface":
				options.surface = readValue(args, i, arg);
				i++;
				break;
			case "--trace-mode":
				options.traceMode = readValue(args, i, arg);
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

function checkLine(text: string): string {
	return `${chalk.green("✓")} ${text}`;
}

export function formatInitSuccess(
	result: Awaited<ReturnType<typeof bootstrapEvalOpsAgent>>,
): string {
	const keyMode = result.apiKeyCreated ? "Created" : "Reused";
	const authenticatedAs = result.authenticatedAs ?? "EvalOps";
	const governedActions = result.governedActionsLoaded ?? 0;
	const lines = [
		chalk.bold("EvalOps Maestro bootstrap"),
		"",
		checkLine(`Authenticated as ${authenticatedAs}`),
		checkLine(`${keyMode} managed inference key`),
		checkLine("Registered local agent runtime"),
		checkLine(
			`Integration profile ${result.integrationProfile ?? "managed_runtime"} via ${result.shimType ?? "sdk"}`,
		),
		checkLine(`Loaded ${governedActions} governed actions`),
		checkLine(
			result.approvalPolicyAttached
				? "Attached default approval policy"
				: "Queued approval policy review",
		),
		checkLine(
			result.traceIngestionStarted
				? "Started trace ingestion"
				: "Requested trace ingestion",
		),
		checkLine(
			result.governedInferenceCheckRan
				? "Ran first governed inference check"
				: "Queued first governed inference check",
		),
		checkLine(
			result.evidenceEventPublished
				? "Published evidence event"
				: "Queued evidence event",
		),
		"",
		"Open console:",
		result.consoleUrl ?? "https://app.evalops.dev/overview?env=production",
	];
	return lines.join("\n");
}

export async function handleInitCommand(args: string[] = []): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(formatInitHelp());
		return;
	}

	let options: EvalOpsInitOptions;
	try {
		options = parseInitArgs(args);
	} catch (error) {
		console.error(
			chalk.red(error instanceof Error ? error.message : String(error)),
		);
		process.exit(1);
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

	console.log(formatInitSuccess(result));
}
