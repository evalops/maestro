export type EnvOverrides = Record<string, string | undefined>;

function restoreEnv(snapshot: EnvOverrides): void {
	for (const key of Object.keys(process.env)) {
		if (!(key in snapshot)) {
			delete process.env[key];
		}
	}

	for (const [key, value] of Object.entries(snapshot)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

export function applyEnv(overrides: EnvOverrides): void {
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

export async function withEnv<T>(
	overrides: EnvOverrides,
	fn: () => Promise<T> | T,
): Promise<T> {
	const snapshot: EnvOverrides = { ...process.env };
	applyEnv(overrides);
	try {
		return await fn();
	} finally {
		restoreEnv(snapshot);
	}
}
