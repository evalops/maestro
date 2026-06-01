export type ImmediateCliExit =
	| { kind: "version" }
	| { kind: "help"; includeHidden: boolean };

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false"]);
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
const COMMANDS_WITH_OWN_HELP = new Set([
	"a2a",
	"evalops",
	"hosted-runner",
	"init",
	"operating-plane",
	"remote",
	"skill",
	"update",
]);
const METER_BASE_ENV_VARS = [
	"MAESTRO_METER_BASE",
	"MAESTRO_METER_SERVICE_URL",
	"MAESTRO_PLATFORM_BASE_URL",
	"MAESTRO_EVALOPS_BASE_URL",
	"EVALOPS_BASE_URL",
];
const EVENT_BUS_URL_ENV_VARS = [
	"MAESTRO_EVENT_BUS_URL",
	"EVALOPS_NATS_URL",
	"NATS_URL",
];
const MANAGED_EVALOPS_TOKEN_ENV_VARS = [
	"MAESTRO_EVALOPS_ACCESS_TOKEN",
	"EVALOPS_TOKEN",
];
const MANAGED_EVALOPS_ORGANIZATION_ENV_VARS = [
	"MAESTRO_EVALOPS_ORG_ID",
	"EVALOPS_ORGANIZATION_ID",
	"EVALOPS_ORG_ID",
	"MAESTRO_ENTERPRISE_ORG_ID",
	"MAESTRO_LLM_GATEWAY_ORG_ID",
	"MAESTRO_REMOTE_RUNNER_ORG_ID",
];
const MANAGED_EVALOPS_AGENT_SESSION_ENV_VARS = [
	"MAESTRO_AGENT_ID",
	"MAESTRO_AGENT_RUN_ID",
];

function isTruthyEnvValue(value: string | undefined): boolean {
	return TRUE_ENV_VALUES.has(value?.trim().toLowerCase() ?? "");
}

function isFalseEnvValue(value: string | undefined): boolean {
	return FALSE_ENV_VALUES.has(value?.trim().toLowerCase() ?? "");
}

function hasEnvValue(
	env: NodeJS.ProcessEnv,
	names: readonly string[],
): boolean {
	return names.some((name) => Boolean(env[name]?.trim()));
}

function optionAwareTokens(args: string[]): string[] {
	const tokens: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (!arg) {
			continue;
		}
		tokens.push(arg);
		if (FLAGS_WITH_VALUES.has(arg) && index + 1 < args.length) {
			index++;
		}
	}
	return tokens;
}

function commandOwnsRequestedImmediateExit(tokens: string[]): boolean {
	for (const arg of tokens) {
		if (
			arg === "--help" ||
			arg === "-h" ||
			arg === "--help-hidden" ||
			arg === "--help-all" ||
			arg === "--version" ||
			arg === "-v"
		) {
			return false;
		}
		if (COMMANDS_WITH_OWN_HELP.has(arg)) {
			return true;
		}
	}
	return false;
}

export function getImmediateCliExit(args: string[]): ImmediateCliExit | null {
	const tokens = optionAwareTokens(args);
	let wantsVersion = false;
	let wantsHelp = false;
	let includeHidden = false;

	for (const arg of tokens) {
		if (arg === "--version" || arg === "-v") {
			wantsVersion = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			wantsHelp = true;
			continue;
		}
		if (arg === "--help-hidden" || arg === "--help-all") {
			wantsHelp = true;
			includeHidden = true;
		}
	}

	const commandOwnsImmediateExit = commandOwnsRequestedImmediateExit(tokens);
	if (wantsVersion && !commandOwnsImmediateExit) {
		return { kind: "version" };
	}
	if (wantsHelp && !commandOwnsImmediateExit) {
		return { kind: "help", includeHidden };
	}
	return null;
}

function isRemoteMeterDestinationConfigured(env: NodeJS.ProcessEnv): boolean {
	return hasEnvValue(env, METER_BASE_ENV_VARS);
}

function isEventBusDestinationConfigured(env: NodeJS.ProcessEnv): boolean {
	if (isFalseEnvValue(env.MAESTRO_EVENT_BUS ?? env.MAESTRO_AUDIT_BUS)) {
		return false;
	}
	return (
		hasEnvValue(env, EVENT_BUS_URL_ENV_VARS) ||
		(hasEnvValue(env, MANAGED_EVALOPS_TOKEN_ENV_VARS) &&
			hasEnvValue(env, MANAGED_EVALOPS_ORGANIZATION_ENV_VARS) &&
			hasEnvValue(env, MANAGED_EVALOPS_AGENT_SESSION_ENV_VARS))
	);
}

function isBeaconDestinationConfigured(env: NodeJS.ProcessEnv): boolean {
	if (isEventBusDestinationConfigured(env)) {
		return true;
	}
	if (isFalseEnvValue(env.MAESTRO_TELEMETRY ?? env.PLAYWRIGHT_TELEMETRY)) {
		return false;
	}
	const sample =
		env.MAESTRO_TELEMETRY_SAMPLE ?? env.PLAYWRIGHT_TELEMETRY_SAMPLE;
	if (sample !== undefined) {
		const parsedSample = Number.parseFloat(sample);
		if (Number.isFinite(parsedSample) && parsedSample <= 0) {
			return false;
		}
	}
	return Boolean(
		env.MAESTRO_BEACON_ENDPOINT ||
			env.MAESTRO_TELEMETRY_ENDPOINT ||
			env.PLAYWRIGHT_TELEMETRY_ENDPOINT ||
			env.MAESTRO_TELEMETRY_FILE ||
			env.PLAYWRIGHT_TELEMETRY_FILE ||
			env.MAESTRO_BEACON_FILE ||
			isRemoteMeterDestinationConfigured(env),
	);
}

export function isStartupTelemetryRequested(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (
		isTruthyEnvValue(env.MAESTRO_INTERNAL_TELEMETRY_DISABLED) ||
		isTruthyEnvValue(env.EVALOPS_INTERNAL_TELEMETRY_DISABLED)
	) {
		return false;
	}
	return (
		isTruthyEnvValue(env.MAESTRO_TELEMETRY ?? env.PLAYWRIGHT_TELEMETRY) ||
		isBeaconDestinationConfigured(env)
	);
}

export function shouldUseInstantCliExit(
	exit: ImmediateCliExit | null,
	env: NodeJS.ProcessEnv = process.env,
): exit is ImmediateCliExit {
	return exit !== null && !isStartupTelemetryRequested(env);
}
