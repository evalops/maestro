import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type GoogleInstalledAppOAuthProvider,
	getGoogleInstalledAppOAuthEnvNames,
	loadGoogleInstalledAppOAuthConfig,
} from "../src/oauth/google-installed-app-config.js";

const PROVIDERS: GoogleInstalledAppOAuthProvider[] = [
	"google-gemini-cli",
	"google-antigravity",
];

const ORIGINAL_ENV = { ...process.env };

function restoreOAuthEnv(): void {
	for (const provider of PROVIDERS) {
		const { clientIdEnv, clientSecretEnv } =
			getGoogleInstalledAppOAuthEnvNames(provider);
		if (ORIGINAL_ENV[clientIdEnv] === undefined) {
			Reflect.deleteProperty(process.env, clientIdEnv);
		} else {
			process.env[clientIdEnv] = ORIGINAL_ENV[clientIdEnv];
		}
		if (ORIGINAL_ENV[clientSecretEnv] === undefined) {
			Reflect.deleteProperty(process.env, clientSecretEnv);
		} else {
			process.env[clientSecretEnv] = ORIGINAL_ENV[clientSecretEnv];
		}
	}
}

describe("Google installed-app OAuth config", () => {
	afterEach(() => {
		restoreOAuthEnv();
	});

	it.each(PROVIDERS)("requires explicit client config for %s", (provider) => {
		const { clientIdEnv, clientSecretEnv } =
			getGoogleInstalledAppOAuthEnvNames(provider);
		Reflect.deleteProperty(process.env, clientIdEnv);
		Reflect.deleteProperty(process.env, clientSecretEnv);

		expect(() => loadGoogleInstalledAppOAuthConfig(provider)).toThrow(
			new RegExp(`${clientIdEnv}.*${clientSecretEnv}`),
		);
		expect(() => loadGoogleInstalledAppOAuthConfig(provider)).not.toThrow(
			/maestro login/,
		);
		expect(() => loadGoogleInstalledAppOAuthConfig(provider)).toThrow(
			/\/login/,
		);
	});

	it.each(PROVIDERS)("loads trimmed client config for %s", (provider) => {
		const { clientIdEnv, clientSecretEnv } =
			getGoogleInstalledAppOAuthEnvNames(provider);
		process.env[clientIdEnv] = " client-id ";
		process.env[clientSecretEnv] = " client-secret ";

		expect(loadGoogleInstalledAppOAuthConfig(provider)).toEqual({
			clientId: "client-id",
			clientSecret: "client-secret",
		});
	});

	it("keeps Google installed-app client material out of provider source", () => {
		const sourceFiles = [
			"src/oauth/google-gemini-cli.ts",
			"src/oauth/google-antigravity.ts",
		];
		for (const file of sourceFiles) {
			const source = readFileSync(join(process.cwd(), file), "utf8");

			expect(source).not.toMatch(/GOCSPX/);
			expect(source).not.toMatch(/apps\.googleusercontent\.com/);
			expect(source).not.toMatch(/decodeBase64/);
		}
	});
});
