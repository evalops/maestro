function parseEnvBoolean(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	const normalized = value.toLowerCase();
	if (normalized === "1" || normalized === "true" || normalized === "yes") {
		return true;
	}
	if (normalized === "0" || normalized === "false" || normalized === "no") {
		return false;
	}
	return undefined;
}

export function shouldDefaultToReducedMotion(): boolean {
	return Boolean(
		process.env.SSH_CONNECTION ||
			process.env.SSH_CLIENT ||
			process.env.TMUX ||
			process.env.STY,
	);
}

export function isReducedMotionEnabled(): boolean {
	const envValue = parseEnvBoolean(process.env.COMPOSER_REDUCED_MOTION);
	if (envValue !== undefined) return envValue;
	return shouldDefaultToReducedMotion();
}

export function setReducedMotionEnv(enabled: boolean): void {
	process.env.COMPOSER_REDUCED_MOTION = enabled ? "1" : "0";
}
