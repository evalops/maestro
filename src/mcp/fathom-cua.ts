import { existsSync } from "node:fs";
import { join } from "node:path";
import { getEnvValue } from "../platform/client.js";
import { createLogger } from "../utils/logger.js";
import type { McpServerConfig } from "./types.js";

const logger = createLogger("mcp:fathom-cua");

const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);
const ENABLED_ENV_VARS = [
	"MAESTRO_FATHOM_CUA_ENABLED",
	"FATHOM_CUA_MCP_ENABLED",
] as const;
const NAME_ENV_VARS = ["MAESTRO_FATHOM_CUA_MCP_NAME", "FATHOM_CUA_MCP_NAME"];
const COMMAND_ENV_VARS = [
	"MAESTRO_FATHOM_CUA_CLIENT_COMMAND",
	"FATHOM_CUA_CLIENT_COMMAND",
] as const;
const ARGS_ENV_VARS = [
	"MAESTRO_FATHOM_CUA_CLIENT_ARGS_JSON",
	"FATHOM_CUA_CLIENT_ARGS_JSON",
] as const;
const REPO_ENV_VARS = ["MAESTRO_FATHOM_CUA_REPO", "FATHOM_CUA_REPO"] as const;
const CWD_ENV_VARS = [
	"MAESTRO_FATHOM_CUA_CLIENT_CWD",
	"FATHOM_CUA_CLIENT_CWD",
] as const;
const WORKSPACE_ENV_VARS = [
	"MAESTRO_FATHOM_CUA_WORKSPACE_ID",
	"FATHOM_CUA_WORKSPACE_ID",
	"MAESTRO_WORKSPACE_ID",
	"MAESTRO_EVALOPS_WORKSPACE_ID",
	"EVALOPS_WORKSPACE_ID",
] as const;
const HELPER_ENDPOINT_ENV_VARS = [
	"MAESTRO_FATHOM_CUA_HELPER_ENDPOINT",
	"FATHOM_CUA_HELPER_ENDPOINT",
] as const;
const IPC_ROOT_ENV_VARS = [
	"MAESTRO_FATHOM_CUA_IPC_ROOT",
	"FATHOM_CUA_IPC_ROOT",
	"FATHOM_IPC_ROOT",
] as const;
const SESSION_ID_ENV_VARS = [
	"MAESTRO_FATHOM_CUA_SESSION_ID",
	"FATHOM_CUA_SESSION_ID",
	"MAESTRO_SESSION_ID",
] as const;
const TURN_ID_ENV_VARS = [
	"MAESTRO_FATHOM_CUA_TURN_ID",
	"FATHOM_CUA_TURN_ID",
	"MAESTRO_AGENT_RUN_ID",
	"MAESTRO_REQUEST_ID",
] as const;
const DISABLE_IPC_ENV_VARS = [
	"MAESTRO_FATHOM_CUA_DISABLE_IPC",
	"FATHOM_CUA_DISABLE_IPC",
] as const;
const TOOL_PROFILE_ENV_VARS = [
	"MAESTRO_FATHOM_CUA_TOOL_PROFILE",
	"FATHOM_CUA_TOOL_PROFILE",
] as const;
const DEFAULT_SERVER_NAME = "fathom-cua";
const DEFAULT_TOOL_PROFILE = "canonical";

function envFlagEnabled(names: readonly string[]): boolean {
	const value = getEnvValue(names);
	if (!value) {
		return false;
	}
	return !DISABLED_VALUES.has(value.trim().toLowerCase());
}

function envFlagDisabled(names: readonly string[]): boolean {
	const value = getEnvValue(names);
	if (!value) {
		return false;
	}
	return DISABLED_VALUES.has(value.trim().toLowerCase());
}

function parseArgsJson(raw: string | undefined): string[] {
	if (!raw) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) {
			throw new Error("expected an array");
		}
		return parsed.map((item) => {
			if (typeof item !== "string") {
				throw new Error("expected only string arguments");
			}
			return item;
		});
	} catch (error) {
		logger.warn("Ignoring invalid Fathom CUA MCP args JSON", {
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}

function appendFlag(
	args: string[],
	flag: string,
	value: string | undefined,
): void {
	if (value) {
		args.push(flag, value);
	}
}

function resolveToolProfile(): string {
	return getEnvValue(TOOL_PROFILE_ENV_VARS)?.trim() || DEFAULT_TOOL_PROFILE;
}

function resolveFathomRepo(): string | undefined {
	const configured = getEnvValue(REPO_ENV_VARS);
	if (configured) {
		return configured;
	}

	const candidates = [
		join(process.cwd(), "..", "fathom"),
		join(process.cwd(), "..", "..", "fathom"),
		join(process.cwd(), "..", "..", "..", "fathom"),
	];
	return candidates.find((candidate) =>
		existsSync(join(candidate, "cmd", "fathom-client", "main.go")),
	);
}

function buildFathomCuaServer(): McpServerConfig {
	const repo = resolveFathomRepo();
	const configuredCommand = getEnvValue(COMMAND_ENV_VARS);
	const configuredCwd = getEnvValue(CWD_ENV_VARS);
	const command = configuredCommand ?? (repo ? "go" : "fathom-client");
	const cwd = configuredCwd ?? (configuredCommand ? undefined : repo);
	const extraArgs = parseArgsJson(getEnvValue(ARGS_ENV_VARS));
	const args = configuredCommand
		? [...extraArgs]
		: repo
			? ["run", "./cmd/fathom-client", ...extraArgs]
			: [...extraArgs];
	const workspaceId = getEnvValue(WORKSPACE_ENV_VARS);
	const helperEndpoint = getEnvValue(HELPER_ENDPOINT_ENV_VARS);
	const ipcRoot = getEnvValue(IPC_ROOT_ENV_VARS);
	const sessionId = getEnvValue(SESSION_ID_ENV_VARS);
	const turnId = getEnvValue(TURN_ID_ENV_VARS);
	const toolProfile = resolveToolProfile();

	appendFlag(args, "-tool-profile", toolProfile);
	appendFlag(args, "-workspace-id", workspaceId);
	appendFlag(args, "-helper-endpoint", helperEndpoint);
	appendFlag(args, "-ipc-root", ipcRoot);
	appendFlag(args, "-session-id", sessionId);
	appendFlag(args, "-turn-id", turnId);
	if (envFlagEnabled(DISABLE_IPC_ENV_VARS)) {
		args.push("-disable-ipc");
	}

	const env = Object.fromEntries(
		Object.entries({
			FATHOM_CALLER_PRODUCT: "maestro",
			FATHOM_CUA_PRODUCT: "maestro",
			FATHOM_CUA_WORKSPACE_ID: workspaceId,
			FATHOM_IPC_ROOT: ipcRoot,
		}).filter((entry): entry is [string, string] => Boolean(entry[1])),
	);

	return {
		name: getEnvValue(NAME_ENV_VARS) ?? DEFAULT_SERVER_NAME,
		transport: "stdio",
		command,
		args,
		cwd,
		env,
		scope: "plugin",
	};
}

export function getFathomCuaPluginServers(): McpServerConfig[] {
	if (envFlagDisabled(ENABLED_ENV_VARS) || !envFlagEnabled(ENABLED_ENV_VARS)) {
		return [];
	}
	return [buildFathomCuaServer()];
}
