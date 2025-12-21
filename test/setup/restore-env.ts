import { afterEach } from "vitest";

type EnvSnapshot = Record<string, string | undefined>;

type ProcessWithEnvSnapshot = typeof process & {
	__COMPOSER_ORIGINAL_ENV__?: EnvSnapshot;
	__COMPOSER_ORIGINAL_ENV_REF__?: NodeJS.ProcessEnv;
};

const processWithSnapshot = process as ProcessWithEnvSnapshot;

const originalEnvRef =
	processWithSnapshot.__COMPOSER_ORIGINAL_ENV_REF__ ?? process.env;
if (!processWithSnapshot.__COMPOSER_ORIGINAL_ENV_REF__) {
	processWithSnapshot.__COMPOSER_ORIGINAL_ENV_REF__ = originalEnvRef;
}

const originalEnvSnapshot = processWithSnapshot.__COMPOSER_ORIGINAL_ENV__ ?? {
	...process.env,
};
if (!processWithSnapshot.__COMPOSER_ORIGINAL_ENV__) {
	processWithSnapshot.__COMPOSER_ORIGINAL_ENV__ = originalEnvSnapshot;
}

function restoreEnv() {
	if (process.env !== originalEnvRef) {
		process.env = originalEnvRef;
	}

	for (const key of Object.keys(process.env)) {
		if (!(key in originalEnvSnapshot)) {
			delete process.env[key];
		}
	}

	for (const [key, value] of Object.entries(originalEnvSnapshot)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

afterEach(() => {
	restoreEnv();
});
