export type EvalOpsEnv = Record<string, string | undefined>;

export const EVALOPS_ACCESS_TOKEN_ENV_VARS = [
	"MAESTRO_EVALOPS_ACCESS_TOKEN",
	"EVALOPS_TOKEN",
] as const;

export const EVALOPS_ORGANIZATION_ID_ENV_VARS = [
	"MAESTRO_EVALOPS_ORG_ID",
	"EVALOPS_ORGANIZATION_ID",
	"EVALOPS_ORG_ID",
	"MAESTRO_ENTERPRISE_ORG_ID",
] as const;

export const EVALOPS_WORKSPACE_ID_ENV_VARS = [
	"MAESTRO_EVALOPS_WORKSPACE_ID",
	"EVALOPS_WORKSPACE_ID",
	"MAESTRO_WORKSPACE_ID",
] as const;

export const EVALOPS_USER_ID_ENV_VARS = [
	"MAESTRO_EVALOPS_USER_ID",
	"EVALOPS_USER_ID",
	"MAESTRO_USER_ID",
] as const;

export const EVALOPS_INTEGRATION_PROFILE_ENV_VARS = [
	"MAESTRO_EVALOPS_INTEGRATION_PROFILE",
	"EVALOPS_INTEGRATION_PROFILE",
	"MAESTRO_INTEGRATION_PROFILE",
] as const;

export const EVALOPS_MEMORY_MODE_ENV_VARS = [
	"MAESTRO_EVALOPS_MEMORY_MODE",
	"EVALOPS_MEMORY_MODE",
	"MAESTRO_MEMORY_MODE",
] as const;

export const EVALOPS_RUNTIME_OWNER_ENV_VARS = [
	"MAESTRO_EVALOPS_RUNTIME_OWNER",
	"EVALOPS_RUNTIME_OWNER",
	"MAESTRO_RUNTIME_OWNER",
] as const;

export const EVALOPS_SHIM_TYPE_ENV_VARS = [
	"MAESTRO_EVALOPS_SHIM_TYPE",
	"EVALOPS_SHIM_TYPE",
	"MAESTRO_SHIM_TYPE",
] as const;

export const EVALOPS_TRACE_MODE_ENV_VARS = [
	"MAESTRO_EVALOPS_TRACE_MODE",
	"EVALOPS_TRACE_MODE",
	"MAESTRO_TRACE_MODE",
] as const;

export function trimEvalOpsEnvValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

export function readEvalOpsEnv(
	env: EvalOpsEnv,
	names: readonly string[],
): string | undefined {
	for (const name of names) {
		const value = trimEvalOpsEnvValue(env[name]);
		if (value) return value;
	}
	return undefined;
}
