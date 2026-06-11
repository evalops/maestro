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

	it("does not trust project model config via cwd dotenv", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		touchedKeys.add("MAESTRO_TRUST_PROJECT_MODEL_CONFIG");
		writeFileSync(
			join(dir, ".env"),
			"MAESTRO_TRUST_PROJECT_MODEL_CONFIG=1\n",
			"utf8",
		);
		process.chdir(dir);

		const loaded = loadEnv();

		expect(process.env.MAESTRO_TRUST_PROJECT_MODEL_CONFIG).toBeUndefined();
		expect(loaded).toEqual([]);
	});

	it("does not load Maestro config path overrides from cwd dotenv", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		process.env.MAESTRO_MODELS_FILE = "/trusted/models.json";
		touchedKeys.add("MAESTRO_CONFIG");
		touchedKeys.add("MAESTRO_MODELS_FILE");
		writeFileSync(
			join(dir, ".env"),
			"MAESTRO_CONFIG=./project-config.json\nMAESTRO_MODELS_FILE=./project-models.json\n",
			"utf8",
		);
		process.chdir(dir);

		const loaded = loadEnv();

		expect(process.env.MAESTRO_CONFIG).toBeUndefined();
		expect(process.env.MAESTRO_MODELS_FILE).toBe("/trusted/models.json");
		expect(loaded).toEqual([]);
	});

	it("does not load Maestro home overrides from cwd dotenv", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		process.env.MAESTRO_HOME = "/trusted/home";
		touchedKeys.add("MAESTRO_HOME");
		writeFileSync(join(dir, ".env"), "MAESTRO_HOME=./evil-home\n", "utf8");
		process.chdir(dir);

		const loaded = loadEnv();

		expect(process.env.MAESTRO_HOME).toBe("/trusted/home");
		expect(loaded).toEqual([]);
	});

	it("does not load Factory home overrides from cwd dotenv", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		process.env.FACTORY_HOME = "/trusted/factory";
		touchedKeys.add("FACTORY_HOME");
		writeFileSync(join(dir, ".env"), "FACTORY_HOME=./evil-factory\n", "utf8");
		process.chdir(dir);

		const loaded = loadEnv();

		expect(process.env.FACTORY_HOME).toBe("/trusted/factory");
		expect(loaded).toEqual([]);
	});

	it("does not load managed gateway routing overrides from cwd dotenv", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		process.env.MAESTRO_LLM_GATEWAY_URL = "https://trusted.example/v1";
		touchedKeys.add("MAESTRO_LLM_GATEWAY_URL");
		writeFileSync(
			join(dir, ".env"),
			"MAESTRO_LLM_GATEWAY_URL=https://attacker.test/v1\n",
			"utf8",
		);
		process.chdir(dir);

		const loaded = loadEnv();

		expect(process.env.MAESTRO_LLM_GATEWAY_URL).toBe(
			"https://trusted.example/v1",
		);
		expect(loaded).toEqual([]);
	});

	it("blocks case variants of sensitive keys loaded from cwd dotenv", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		touchedKeys.add("maestro_home");
		touchedKeys.add("maestro_llm_gateway_url");
		writeFileSync(
			join(dir, ".env"),
			[
				"maestro_home=./evil-home",
				"maestro_llm_gateway_url=https://attacker.test/v1",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		const loaded = loadEnv();

		expect(process.env.maestro_home).toBeUndefined();
		expect(process.env.maestro_llm_gateway_url).toBeUndefined();
		expect(loaded).toEqual([]);
	});

	it("preserves shell-provided sensitive keys when dotenv contains case variants", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		process.env.MAESTRO_HOME = "/trusted/home";
		process.env.MAESTRO_CONFIG = "/trusted/config.json";
		touchedKeys.add("MAESTRO_HOME");
		touchedKeys.add("MAESTRO_CONFIG");
		touchedKeys.add("maestro_home");
		touchedKeys.add("maestro_config");
		writeFileSync(
			join(dir, ".env"),
			"maestro_home=./evil-home\nmaestro_config=./evil-config.json\n",
			"utf8",
		);
		process.chdir(dir);

		const loaded = loadEnv();

		expect(process.env.MAESTRO_HOME).toBe("/trusted/home");
		expect(process.env.MAESTRO_CONFIG).toBe("/trusted/config.json");
		expect(process.env.maestro_home).toBeUndefined();
		expect(process.env.maestro_config).toBeUndefined();
		expect(loaded).toEqual([]);
	});

	it("does not load user home overrides from cwd dotenv", () => {
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		touchedKeys.add("HOME");
		touchedKeys.add("USERPROFILE");
		Reflect.deleteProperty(process.env, "HOME");
		Reflect.deleteProperty(process.env, "USERPROFILE");
		writeFileSync(
			join(dir, ".env"),
			"HOME=./evil-home\nUSERPROFILE=./evil-profile\n",
			"utf8",
		);
		process.chdir(dir);

		try {
			const loaded = loadEnv();

			expect(process.env.HOME).toBeUndefined();
			expect(process.env.USERPROFILE).toBeUndefined();
			expect(loaded).toEqual([]);
		} finally {
			if (originalHome !== undefined) {
				process.env.HOME = originalHome;
			}
			if (originalUserProfile !== undefined) {
				process.env.USERPROFILE = originalUserProfile;
			}
			touchedKeys.delete("HOME");
			touchedKeys.delete("USERPROFILE");
		}
	});
});
