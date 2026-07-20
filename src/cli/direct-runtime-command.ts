import { isStartupTelemetryRequested } from "./instant-exit.js";

const NATIVE_UTILITY_COMMANDS = new Set([
	"cost",
	"export",
	"hooks",
	"import",
	"models",
	"sessions",
	"stats",
	"status",
]);

const DIRECT_RUNTIME_COMMANDS = new Set([
	...NATIVE_UTILITY_COMMANDS,
	"hosted-runner",
	"init",
	"skill",
	"update",
]);

export function isNativeUtilityCommand(command: string | undefined): boolean {
	return Boolean(command && NATIVE_UTILITY_COMMANDS.has(command));
}

const FLAGS_WITH_VALUES = new Set([
	"--mode",
	"--provider",
	"--model",
	"-m",
	"--task-budget",
	"--models",
	"--models-file",
	"--api-key",
	"--port",
	"--system-prompt",
	"--append-system-prompt",
	"--session",
	"--approval-mode",
	"--auth",
	"--sandbox",
	"--output-schema",
	"--output-last-message",
	"--tools",
	"--composer",
	"--format",
	"--profile",
	"--config",
	"--junit",
	"--replay",
	"--record-scenario",
]);

const LEGACY_AUTH_FLAGS_WITH_VALUES = new Set(["--codex-api-key"]);
const LEGACY_AUTH_FLAG_PREFIXES = [
	"--codex-api-key=",
	"--auth=chatgpt",
	"--auth=claude",
];
const LEGACY_AUTH_MODES = new Set(["chatgpt", "claude"]);

export function isDirectRuntimeCommand(command: string | undefined): boolean {
	return Boolean(command && DIRECT_RUNTIME_COMMANDS.has(command));
}

export function getRuntimeCommand(args: readonly string[]): string | null {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (!arg) {
			continue;
		}
		if (FLAGS_WITH_VALUES.has(arg) && index + 1 < args.length) {
			index++;
			continue;
		}
		if (arg.startsWith("-")) {
			continue;
		}
		return arg;
	}
	return null;
}

export function getDirectRuntimeCommand(
	args: readonly string[],
): string | null {
	const command = getRuntimeCommand(args);
	return DIRECT_RUNTIME_COMMANDS.has(command ?? "") ? command : null;
}

export function shouldUseUnbundledMainRuntime(
	args: readonly string[],
): boolean {
	return getRuntimeCommand(args) === "exec";
}

function hasLegacyAuthFlag(args: readonly string[]): boolean {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (!arg) {
			continue;
		}
		if (LEGACY_AUTH_FLAGS_WITH_VALUES.has(arg)) {
			return true;
		}
		if (LEGACY_AUTH_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
			return true;
		}
		if (arg === "--auth" && LEGACY_AUTH_MODES.has(args[index + 1] ?? "")) {
			return true;
		}
	}
	return false;
}

export function shouldAttemptDirectRuntimeDispatch(
	args: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return (
		getDirectRuntimeCommand(args) !== null &&
		!hasLegacyAuthFlag(args) &&
		!isStartupTelemetryRequested(env)
	);
}
