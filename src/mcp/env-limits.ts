export type EnvValidatorResult =
	| { effective: number; status: "valid"; message?: string }
	| { effective: number; status: "invalid" | "capped"; message: string };

export interface EnvValidator {
	name: string;
	default: number;
	validate: (raw: string | undefined) => EnvValidatorResult;
}

// Reference pattern only; not enforced elsewhere yet.
export const defaultEnvValidators: EnvValidator[] = [
	{
		name: "COMPOSER_MCP_MAX_OUTPUT_TOKENS",
		default: 32000,
		validate: (raw) => {
			if (!raw) return { effective: 32000, status: "valid" };
			const n = Number.parseInt(raw, 10);
			if (!Number.isFinite(n) || n <= 0) {
				return {
					effective: 32000,
					status: "invalid",
					message: `Invalid value "${raw}"`,
				};
			}
			if (n > 64000) {
				return {
					effective: 64000,
					status: "capped",
					message: `Capped from ${n} to 64000`,
				};
			}
			return { effective: n, status: "valid" };
		},
	},
	{
		name: "COMPOSER_MCP_MAX_STDIO_OUTPUT",
		default: 30000,
		validate: (raw) => {
			if (!raw) return { effective: 30000, status: "valid" };
			const n = Number.parseInt(raw, 10);
			if (!Number.isFinite(n) || n <= 0) {
				return {
					effective: 30000,
					status: "invalid",
					message: `Invalid value "${raw}"`,
				};
			}
			if (n > 150000) {
				return {
					effective: 150000,
					status: "capped",
					message: `Capped from ${n} to 150000`,
				};
			}
			return { effective: n, status: "valid" };
		},
	},
];

export function evaluateEnvValidators(
	validators: EnvValidator[] = defaultEnvValidators,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, EnvValidatorResult> {
	const results: Record<string, EnvValidatorResult> = {};
	for (const v of validators) {
		results[v.name] = v.validate(env[v.name]);
	}
	return results;
}
