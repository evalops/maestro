import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStoredCredentials } from "../../src/agent/keys.js";

const tempDir = join(process.cwd(), ".tmp-keys-test");
const tempFile = join(tempDir, "keys.json");

describe("getStoredCredentials", () => {
	beforeEach(() => {
		mkdirSync(tempDir, { recursive: true });
		process.env.COMPOSER_KEYS_PATH = tempFile;
	});

	afterEach(() => {
		try {
			unlinkSync(tempFile);
		} catch {
			// ignore
		}
		process.env.COMPOSER_KEYS_PATH = undefined;
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
});
