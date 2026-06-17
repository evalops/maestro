import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("factory integration cache", () => {
	let testDir: string;
	let originalMaestroConfig: string | undefined;
	let originalFactoryHome: string | undefined;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`maestro-factory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		originalMaestroConfig = process.env.MAESTRO_CONFIG;
		originalFactoryHome = process.env.FACTORY_HOME;
		Reflect.deleteProperty(process.env, "MAESTRO_CONFIG");
		process.env.FACTORY_HOME = join(testDir, ".factory");
		mkdirSync(process.env.FACTORY_HOME, { recursive: true });
		vi.resetModules();
	});

	afterEach(() => {
		if (originalFactoryHome === undefined) {
			Reflect.deleteProperty(process.env, "FACTORY_HOME");
		} else {
			process.env.FACTORY_HOME = originalFactoryHome;
		}
		if (originalMaestroConfig === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_CONFIG");
		} else {
			process.env.MAESTRO_CONFIG = originalMaestroConfig;
		}
		rmSync(testDir, { recursive: true, force: true });
		vi.resetModules();
	});

	it("does not reuse snapshot data for a stricter policy cache key", async () => {
		writeFileSync(
			join(process.env.FACTORY_HOME!, "config.json"),
			JSON.stringify({
				custom_models: [
					{
						model: "factory-model",
						provider: "openai",
						base_url: "https://factory.example/v1",
					},
				],
			}),
		);

		const {
			clearFactoryCache,
			ensureFactoryDataWithPolicy,
			readFactoryConfigSnapshot,
		} = await import("../../src/models/factory-integration.js");

		clearFactoryCache();

		const strictPolicy = {
			allowedBaseUrls: ["https://trusted.example/v1"],
		};

		expect(ensureFactoryDataWithPolicy(strictPolicy)).toBeNull();
		expect(readFactoryConfigSnapshot()).not.toBeNull();
		expect(ensureFactoryDataWithPolicy(strictPolicy)).toBeNull();
	});

	it("applies merged URL policy to factory config snapshots", async () => {
		const maestroConfigPath = join(testDir, "maestro-config.json");
		process.env.MAESTRO_CONFIG = maestroConfigPath;
		writeFileSync(
			maestroConfigPath,
			JSON.stringify({
				allowedBaseUrls: ["https://trusted.example/v1"],
				providers: [],
			}),
		);
		writeFileSync(
			join(process.env.FACTORY_HOME!, "config.json"),
			JSON.stringify({
				custom_models: [
					{
						model: "blocked-model",
						provider: "openai",
						base_url: "https://blocked.example/v1",
					},
				],
			}),
		);

		const { clearCachedConfig } = await import(
			"../../src/models/config-loader.js"
		);
		const { clearFactoryCache } = await import(
			"../../src/models/factory-integration.js"
		);
		const { loadFactoryConfigOrThrow } = await import(
			"../../src/factory/config.js"
		);

		clearCachedConfig();
		clearFactoryCache();

		expect(() => loadFactoryConfigOrThrow()).toThrow(/no custom models/i);
	});

	it("applies merged URL policy to factory default model selection", async () => {
		const maestroConfigPath = join(testDir, "maestro-config.json");
		process.env.MAESTRO_CONFIG = maestroConfigPath;
		writeFileSync(
			maestroConfigPath,
			JSON.stringify({
				allowedBaseUrls: ["https://allowed.example/v1"],
				providers: [],
			}),
		);
		writeFileSync(
			join(process.env.FACTORY_HOME!, "config.json"),
			JSON.stringify({
				custom_models: [
					{
						model: "allowed-model",
						provider: "openai",
						base_url: "https://allowed.example/v1",
					},
					{
						model: "blocked-model",
						provider: "openai",
						base_url: "https://blocked.example/v1",
					},
				],
			}),
		);
		writeFileSync(
			join(process.env.FACTORY_HOME!, "settings.json"),
			JSON.stringify({ model: "blocked-model" }),
		);

		const { clearFactoryCache, getFactoryDefaultModelSelection } = await import(
			"../../src/models/factory-integration.js"
		);

		clearFactoryCache();

		expect(getFactoryDefaultModelSelection()).toBeNull();
	});

	it("does not let policy-only lookups bypass later Factory fallback", async () => {
		const maestroConfigPath = join(testDir, "maestro-config.json");
		process.env.MAESTRO_CONFIG = maestroConfigPath;
		writeFileSync(
			maestroConfigPath,
			JSON.stringify({
				allowedBaseUrls: ["https://allowed.example/v1"],
				providers: [],
			}),
		);
		writeFileSync(
			join(process.env.FACTORY_HOME!, "config.json"),
			JSON.stringify({
				custom_models: [
					{
						model: "allowed-model",
						provider: "openai",
						base_url: "https://allowed.example/v1",
					},
				],
			}),
		);
		writeFileSync(
			join(process.env.FACTORY_HOME!, "settings.json"),
			JSON.stringify({ model: "allowed-model" }),
		);

		const { clearCachedConfig, getMergedCustomModelUrlPolicyConfig } =
			await import("../../src/models/config-loader.js");
		const { clearFactoryCache, getFactoryDefaultModelSelection } = await import(
			"../../src/models/factory-integration.js"
		);
		const { getRegisteredModels } = await import(
			"../../src/models/registry.js"
		);

		clearCachedConfig();
		clearFactoryCache();

		expect(getMergedCustomModelUrlPolicyConfig()).toEqual({
			allowedBaseUrls: ["https://allowed.example/v1"],
		});

		const selection = getFactoryDefaultModelSelection();
		expect(selection).not.toBeNull();
		expect(selection).toEqual({
			provider: "factory-openai",
			modelId: "allowed-model",
		});
		const resolvedSelection = selection!;
		expect(
			getRegisteredModels().some(
				(model) =>
					model.provider === resolvedSelection.provider &&
					model.id === resolvedSelection.modelId,
			),
		).toBe(true);
	});
});
