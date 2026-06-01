import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/load-env.js";

describe("loadEnv", () => {
	const originalCwd = process.cwd();
	const tempDirs: string[] = [];
	const touchedKeys = new Set<string>();

	afterEach(() => {
		process.chdir(originalCwd);
		for (const key of touchedKeys) {
			delete process.env[key];
		}
		touchedKeys.clear();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { force: true, recursive: true });
		}
	});

	it("returns only keys loaded from cwd dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		process.env.MAESTRO_EXISTING_ENV = "from-shell";
		touchedKeys.add("MAESTRO_EXISTING_ENV");
		touchedKeys.add("MAESTRO_FROM_DOTENV");
		writeFileSync(
			join(dir, ".env"),
			"MAESTRO_EXISTING_ENV=from-dotenv\nMAESTRO_FROM_DOTENV=loaded\n",
			"utf8",
		);
		process.chdir(dir);

		const loaded = loadEnv();

		expect(process.env.MAESTRO_EXISTING_ENV).toBe("from-shell");
		expect(process.env.MAESTRO_FROM_DOTENV).toBe("loaded");
		expect(loaded).toEqual(["MAESTRO_FROM_DOTENV"]);
	});
});
