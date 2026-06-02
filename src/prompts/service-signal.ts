const PROMPTS_BASE_URL_ENV_VARS = [
	"PROMPTS_SERVICE_URL",
	"MAESTRO_PROMPTS_SERVICE_URL",
	"MAESTRO_PLATFORM_BASE_URL",
	"MAESTRO_EVALOPS_BASE_URL",
	"EVALOPS_BASE_URL",
] as const;

function hasEnvValue(name: string): boolean {
	return Boolean(process.env[name]?.trim());
}

export function hasPromptServiceBaseUrlSignal(): boolean {
	return PROMPTS_BASE_URL_ENV_VARS.some(hasEnvValue);
}
