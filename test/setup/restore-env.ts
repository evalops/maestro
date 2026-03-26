import { afterEach } from "vitest";

type EnvSnapshot = Record<string, string | undefined>;

type ProcessWithEnvSnapshot = typeof process & {
	__MAESTRO_ORIGINAL_ENV__?: EnvSnapshot;
	__MAESTRO_ORIGINAL_ENV_REF__?: NodeJS.ProcessEnv;
};

const processWithSnapshot = process as ProcessWithEnvSnapshot;

const originalEnvRef =
	processWithSnapshot.__MAESTRO_ORIGINAL_ENV_REF__ ?? process.env;
if (!processWithSnapshot.__MAESTRO_ORIGINAL_ENV_REF__) {
	processWithSnapshot.__MAESTRO_ORIGINAL_ENV_REF__ = originalEnvRef;
}

const originalEnvSnapshot = processWithSnapshot.__MAESTRO_ORIGINAL_ENV__ ?? {
	...process.env,
};
if (!processWithSnapshot.__MAESTRO_ORIGINAL_ENV__) {
	processWithSnapshot.__MAESTRO_ORIGINAL_ENV__ = originalEnvSnapshot;
}

function restoreEnv() {
	if (process.env !== originalEnvRef) {
		process.env = originalEnvRef;
	}

	for (const key of Object.keys(process.env)) {
		if (!(key in originalEnvSnapshot)) {
			Reflect.deleteProperty(process.env, key);
		}
	}

	for (const [key, value] of Object.entries(originalEnvSnapshot)) {
		if (value === undefined) {
			Reflect.deleteProperty(process.env, key);
		} else {
			process.env[key] = value;
		}
	}
}

afterEach(() => {
	restoreEnv();
});
