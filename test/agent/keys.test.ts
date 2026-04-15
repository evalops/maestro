import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStoredCredentials } from "../../src/agent/keys.js";

const tempDir = join(process.cwd(), ".tmp-keys-test");
const tempFile = join(tempDir, "keys.json");
const tempFactoryConfig = join(tempDir, "config.json");

describe("getStoredCredentials", () => {
	beforeEach(() => {
		mkdirSync(tempDir, { recursive: true });
		process.env.MAESTRO_KEYS_PATH = tempFile;
		process.env.FACTORY_HOME = tempDir;
	});

	afterEach(() => {
		try {
			unlinkSync(tempFile);
		} catch {
			// ignore
		}
		try {
			unlinkSync(tempFactoryConfig);
		} catch {
			// ignore
		}
		Reflect.deleteProperty(process.env, "MAESTRO_KEYS_PATH");
		Reflect.deleteProperty(process.env, "FACTORY_HOME");
	});

	it("returns empty when file missing", () => {
		expect(getStoredCredentials("openai")).toEqual({});
	});

	it("returns stored key and authType when present", () => {
		writeFileSync(
			tempFile,
			JSON.stringify({
				openai: { apiKey: "sk-test", authType: "api-key" },
			}),
			"utf8",
		);
		expect(getStoredCredentials("openai")).toEqual({
			apiKey: "sk-test",
			authType: "api-key",
		});
	});

	it("falls back to factory config api_keys map", () => {
		writeFileSync(
			tempFactoryConfig,
			JSON.stringify({
				api_keys: { groq: "gsk-test" },
			}),
			"utf8",
		);
		process.env.FACTORY_HOME = tempDir;
		expect(getStoredCredentials("groq")).toEqual({
			apiKey: "gsk-test",
			authType: "api-key",
		});
	});
});
