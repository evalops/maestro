import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import chalk from "chalk";
import type { HostedRunnerContext } from "../../server/app-context.js";

type HostedRunnerFlagValue = true | string;

interface HostedRunnerOptions {
	flags: Map<string, HostedRunnerFlagValue[]>;
	positionals: string[];
}

export interface HostedRunnerConfig {
	runnerSessionId: string;
	workspaceRoot: string;
	host?: string;
	port: number;
	workspaceId?: string;
	agentRunId?: string;
	maestroSessionId?: string;
	attachAudience?: string;
}

interface HostedRunnerResolveOptions {
	defaultPort?: number;
}

const HOSTED_RUNNER_USAGE = `maestro hosted-runner [options]

Options:
  --runner-session-id <id>  Platform remote-runner session id (required)
  --workspace-root <path>   Workspace root mounted into the runtime pod (required)
  --listen <host:port>      Address to bind, for example 0.0.0.0:8080
  --host <host>             Bind host when --listen is not used
  --port <port>             Bind port when --listen is not used
  --workspace-id <id>       EvalOps workspace id for metadata
  --agent-run-id <id>       Platform AgentRun id for metadata
  --maestro-session-id <id> Existing Maestro session id for metadata
  --attach-audience <aud>   Expected attach audience metadata
  --help                    Show this help

Environment:
  MAESTRO_RUNNER_SESSION_ID, REMOTE_RUNNER_SESSION_ID
  MAESTRO_WORKSPACE_ROOT
  MAESTRO_HOSTED_RUNNER_LISTEN, MAESTRO_HOSTED_RUNNER_HOST, MAESTRO_HOSTED_RUNNER_PORT, PORT
  MAESTRO_REMOTE_RUNNER_WORKSPACE_ID, MAESTRO_AGENT_RUN_ID, MAESTRO_SESSION_ID
  MAESTRO_ATTACH_AUDIENCE`;

function parseHostedRunnerOptions(
	args: readonly string[],
): HostedRunnerOptions {
	const flags = new Map<string, HostedRunnerFlagValue[]>();
	const positionals: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (!arg) {
			continue;
		}
		if (arg === "--") {
			positionals.push(...args.slice(index + 1));
			break;
		}
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}
		const equalsIndex = arg.indexOf("=");
		const key = equalsIndex >= 0 ? arg.slice(2, equalsIndex) : arg.slice(2);
		const inlineValue =
			equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : undefined;
		const next = args[index + 1];
		const value =
			inlineValue !== undefined
				? inlineValue
				: next && !next.startsWith("--")
					? next
					: true;
		if (inlineValue === undefined && value !== true) {
			index += 1;
		}
		const values = flags.get(key) ?? [];
		values.push(value);
		flags.set(key, values);
	}

	return { flags, positionals };
}

function getLastFlag(
	options: HostedRunnerOptions,
	key: string,
): string | undefined {
	const values = options.flags.get(key);
	const value = values?.at(-1);
	return typeof value === "string" ? value.trim() : undefined;
}

function hasFlag(options: HostedRunnerOptions, key: string): boolean {
	return options.flags.has(key);
}

function getEnvValue(
	env: NodeJS.ProcessEnv,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const value = env[key]?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

function parsePort(
	value: string | undefined,
	label: string,
): number | undefined {
	if (!value) {
		return undefined;
	}
	if (!/^\d+$/.test(value.trim())) {
		throw new Error(`${label} must be a TCP port between 1 and 65535`);
	}
	const port = Number.parseInt(value, 10);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`${label} must be a TCP port between 1 and 65535`);
	}
	return port;
}

function parseListen(value: string | undefined): {
	host?: string;
	port?: number;
} {
	if (!value) {
		return {};
	}
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) {
		return { port: parsePort(trimmed, "--listen") };
	}
	const separatorIndex = trimmed.lastIndexOf(":");
	if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
		throw new Error("--listen must be <host:port> or <port>");
	}
	return {
		host: trimmed.slice(0, separatorIndex),
		port: parsePort(trimmed.slice(separatorIndex + 1), "--listen"),
	};
}

async function resolveWorkspaceRoot(path: string | undefined): Promise<string> {
	if (!path) {
		throw new Error(
			"maestro hosted-runner requires --workspace-root or MAESTRO_WORKSPACE_ROOT",
		);
	}
	const workspaceRoot = resolve(path);
	const stats = await stat(workspaceRoot);
	if (!stats.isDirectory()) {
		throw new Error(`Hosted runner workspace root is not a directory: ${path}`);
	}
	return realpath(workspaceRoot);
}

export function formatHostedRunnerUsage(): string {
	return HOSTED_RUNNER_USAGE;
}

export async function resolveHostedRunnerConfig(
	args: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
	options: HostedRunnerResolveOptions = {},
): Promise<HostedRunnerConfig> {
	const parsed = parseHostedRunnerOptions(args);
	if (parsed.positionals.length > 0) {
		throw new Error(
			`Unexpected hosted-runner argument: ${parsed.positionals[0]}`,
		);
	}

	const runnerSessionId =
		getLastFlag(parsed, "runner-session-id") ??
		getEnvValue(env, ["MAESTRO_RUNNER_SESSION_ID", "REMOTE_RUNNER_SESSION_ID"]);
	if (!runnerSessionId) {
		throw new Error(
			"maestro hosted-runner requires --runner-session-id or MAESTRO_RUNNER_SESSION_ID",
		);
	}

	const listen = parseListen(
		getLastFlag(parsed, "listen") ?? env.MAESTRO_HOSTED_RUNNER_LISTEN,
	);
	const port =
		listen.port ??
		parsePort(getLastFlag(parsed, "port"), "--port") ??
		parsePort(env.MAESTRO_HOSTED_RUNNER_PORT, "MAESTRO_HOSTED_RUNNER_PORT") ??
		parsePort(env.PORT, "PORT") ??
		options.defaultPort ??
		8080;

	return {
		runnerSessionId,
		workspaceRoot: await resolveWorkspaceRoot(
			getLastFlag(parsed, "workspace-root") ??
				getEnvValue(env, ["MAESTRO_WORKSPACE_ROOT", "WORKSPACE_ROOT"]),
		),
		host:
			listen.host ??
			getLastFlag(parsed, "host") ??
			env.MAESTRO_HOSTED_RUNNER_HOST,
		port,
		workspaceId:
			getLastFlag(parsed, "workspace-id") ??
			getEnvValue(env, [
				"MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
				"MAESTRO_WORKSPACE_ID",
			]),
		agentRunId: getLastFlag(parsed, "agent-run-id") ?? env.MAESTRO_AGENT_RUN_ID,
		maestroSessionId:
			getLastFlag(parsed, "maestro-session-id") ?? env.MAESTRO_SESSION_ID,
		attachAudience:
			getLastFlag(parsed, "attach-audience") ?? env.MAESTRO_ATTACH_AUDIENCE,
	};
}

export function applyHostedRunnerEnvironment(config: HostedRunnerConfig): void {
	process.env.MAESTRO_HOSTED_RUNNER_MODE = "1";
	process.env.MAESTRO_RUNNER_SESSION_ID = config.runnerSessionId;
	process.env.MAESTRO_WORKSPACE_ROOT = config.workspaceRoot;
	process.env.MAESTRO_PROFILE ??= "hosted-runner";
	process.env.MAESTRO_WEB_REQUIRE_KEY ??= "0";
	process.env.MAESTRO_WEB_REQUIRE_REDIS ??= "0";
	process.env.MAESTRO_WEB_REQUIRE_CSRF ??= "0";
	process.env.MAESTRO_AGENT_DIR ??= resolve(
		config.workspaceRoot,
		".maestro",
		"agent",
	);
	if (config.workspaceId) {
		process.env.MAESTRO_REMOTE_RUNNER_WORKSPACE_ID = config.workspaceId;
	}
	if (config.agentRunId) {
		process.env.MAESTRO_AGENT_RUN_ID = config.agentRunId;
	}
	if (config.maestroSessionId) {
		process.env.MAESTRO_SESSION_ID = config.maestroSessionId;
	}
	if (config.attachAudience) {
		process.env.MAESTRO_ATTACH_AUDIENCE = config.attachAudience;
	}
	process.chdir(config.workspaceRoot);
}

export function toHostedRunnerContext(
	config: HostedRunnerConfig,
): HostedRunnerContext {
	return {
		enabled: true,
		runnerSessionId: config.runnerSessionId,
		workspaceRoot: config.workspaceRoot,
		listenHost: config.host,
		listenPort: config.port,
		workspaceId: config.workspaceId,
		agentRunId: config.agentRunId,
		attachAudience: config.attachAudience,
		configuredMaestroSessionId: config.maestroSessionId,
		activeMaestroSessionId: config.maestroSessionId,
	};
}

export async function handleHostedRunnerCommand(
	args: readonly string[],
	options: HostedRunnerResolveOptions = {},
): Promise<void> {
	const parsed = parseHostedRunnerOptions(args);
	if (hasFlag(parsed, "help")) {
		console.log(formatHostedRunnerUsage());
		return;
	}

	try {
		const config = await resolveHostedRunnerConfig(args, process.env, options);
		applyHostedRunnerEnvironment(config);
		const { startWebServer } = await import("../../web-server.js");
		await startWebServer(config.port, {
			host: config.host,
			hostedRunner: toHostedRunnerContext(config),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(message));
		process.exit(1);
	}
}
