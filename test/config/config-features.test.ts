/**
 * @vitest-environment node
 *
 * These tests modify global model registry state via COMPOSER_CONFIG env var.
 * They must run sequentially to avoid race conditions with parallel tests.
 */
import {
	existsSync,
	mkdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ConfigInspection,
	type ConfigValidationResult,
	getAliases,
	getRegisteredModels,
	inspectConfig,
	isLocalBaseUrl,
	reloadModelConfig,
	resolveAlias,
	validateConfig,
} from "../../src/models/registry.js";

function writeConfigFile(path: string, data: string | object): void {
	mkdirSync(dirname(path), { recursive: true });
	const payload = typeof data === "string" ? data : JSON.stringify(data);
	writeFileSync(path, payload);
}

describe("Config Features", () => {
	let testDir: string;
	let originalComposerConfig: string | undefined;
	let originalComposerModelsFile: string | undefined;

	beforeEach(() => {
		// Create temp directory for test configs
		testDir = join(
			tmpdir(),
			`composer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });

		// Save and clear config env vars to ensure isolation
		originalComposerConfig = process.env.COMPOSER_CONFIG;
		originalComposerModelsFile = process.env.COMPOSER_MODELS_FILE;
		Reflect.deleteProperty(process.env, "COMPOSER_CONFIG");
		Reflect.deleteProperty(process.env, "COMPOSER_MODELS_FILE");

		// Clear any cached config from previous tests
		try {
			reloadModelConfig();
		} catch {
			// Ignore errors during reset
		}
	});

	afterEach(() => {
		// Restore original env vars
		if (originalComposerConfig !== undefined) {
			process.env.COMPOSER_CONFIG = originalComposerConfig;
		} else {
			Reflect.deleteProperty(process.env, "COMPOSER_CONFIG");
		}
		if (originalComposerModelsFile !== undefined) {
			process.env.COMPOSER_MODELS_FILE = originalComposerModelsFile;
		} else {
			Reflect.deleteProperty(process.env, "COMPOSER_MODELS_FILE");
		}

		// Clean test-specific env vars
		Reflect.deleteProperty(process.env, "TEST_API_KEY");

		// Clear config cache between tests
		try {
			reloadModelConfig();
		} catch {
			// Ignore reload errors from invalid test configs
		}

		// Cleanup test directory
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("JSONC Support", () => {
		it("should parse JSON with comments", () => {
			const configPath = join(testDir, "test-jsonc.json");
			const config = `{
				// This is a comment
				"providers": [{
					"id": "test",
					"name": "Test", /* block comment */
					"baseUrl": "https://api.test.com",
					"api": "anthropic-messages",
					"models": [{
						"id": "model-1",
						"name": "Model 1",
						"contextWindow": 100000,
						"maxTokens": 4096,
					}] // trailing comma is OK!
				}]
			}`;

			writeConfigFile(configPath, config);
			process.env.COMPOSER_CONFIG = configPath;

			const result = validateConfig();
			expect(result.valid).toBe(true);
			expect(result.summary.providers).toBe(1);
			expect(result.summary.models).toBe(1);
		});

		it("should handle trailing commas", () => {
			const configPath = join(testDir, "trailing-commas.json");
			const config = `{
				"providers": [{
					"id": "test",
					"name": "Test",
					"baseUrl": "https://api.test.com",
					"api": "anthropic-messages",
					"models": [
						{
							"id": "model-1",
							"name": "Model 1",
							"contextWindow": 100000,
							"maxTokens": 4096,
						},
					],
				}],
			}`;

			writeConfigFile(configPath, config);
			process.env.COMPOSER_CONFIG = configPath;

			const result = validateConfig();
			expect(result.valid).toBe(true);
		});
	});

	describe("Environment Variable Substitution", () => {
		it("should substitute {env:VAR} with environment variable", async () => {
			process.env.TEST_API_KEY = "test-key-123";

			const configPath = join(testDir, "env-vars.json");
			const config = {
				providers: [
					{
						id: "test",
						name: "Test",
						baseUrl: "https://api.test.com",
						api: "anthropic-messages",
						apiKey: "{env:TEST_API_KEY}",
						models: [
							{
								id: "model-1",
								name: "Model 1",
								contextWindow: 100000,
								maxTokens: 4096,
							},
						],
					},
				],
			};

			writeConfigFile(configPath, config);
			process.env.COMPOSER_CONFIG = configPath;

			// Force config reload to pick up new COMPOSER_CONFIG
			reloadModelConfig();

			const inspection = inspectConfig();

			// The config file should be in sources
			const testSource = inspection.sources.find((s) =>
				s.path.includes("env-vars.json"),
			);
			expect(testSource).toBeDefined();
			expect(testSource?.exists).toBe(true);

			// Should have env vars tracked from our config file
			const envVar = inspection.envVars.find((v) => v.name === "TEST_API_KEY");
			expect(envVar).toBeDefined();
			expect(envVar?.set).toBe(true);
		});

		it("should warn when env var is not set", () => {
			const configPath = join(testDir, "missing-env.json");
			const config = {
				providers: [
					{
						id: "test",
						name: "Test",
						baseUrl: "https://api.test.com",
						api: "anthropic-messages",
						apiKey: "{env:NONEXISTENT_VAR}",
						models: [
							{
								id: "model-1",
								name: "Model 1",
								contextWindow: 100000,
								maxTokens: 4096,
							},
						],
					},
				],
			};

			writeConfigFile(configPath, config);
			process.env.COMPOSER_CONFIG = configPath;

			const result = validateConfig();
			expect(result.warnings.length).toBeGreaterThan(0);
			expect(result.warnings.some((w) => w.includes("NONEXISTENT_VAR"))).toBe(
				true,
			);
		});
	});

	describe("File References", () => {
		it("should resolve {file:path} references", () => {
			const promptPath = join(testDir, "prompt.txt");
			writeConfigFile(promptPath, "This is my system prompt");

			const configPath = join(testDir, "file-ref.json");
			const config = {
				providers: [
					{
						id: "test",
						name: "Test",
						baseUrl: "https://api.test.com",
						api: "anthropic-messages",
						models: [
							{
								id: "model-1",
								name: `{file:${promptPath}}`,
								contextWindow: 100000,
								maxTokens: 4096,
							},
						],
					},
				],
			};

			writeConfigFile(configPath, config);
			process.env.COMPOSER_CONFIG = configPath;

			const result = validateConfig();
			expect(result.summary.fileReferences.length).toBe(1);
			expect(result.summary.fileReferences[0]).toBe(promptPath);
		});

		it("should error when file reference doesn't exist", () => {
			const configPath = join(testDir, "bad-file-ref.json");
			const missingPath = join(testDir, "nonexistent.txt");
			const config = {
				providers: [
					{
						id: "test",
						name: "Test",
						baseUrl: "https://api.test.com",
						api: "anthropic-messages",
						models: [
							{
								id: "model-1",
								name: `{file:${missingPath}}`,
								contextWindow: 100000,
								maxTokens: 4096,
							},
						],
					},
				],
			};

			writeConfigFile(configPath, config);
			process.env.COMPOSER_CONFIG = configPath;

			const result = validateConfig();
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes(missingPath))).toBe(true);
		});
	});

	describe("Model Aliases", () => {
		it("should resolve model aliases", () => {
			const configPath = join(testDir, "aliases.json");
			const config = {
				aliases: {
					fast: "anthropic/claude-haiku",
					smart: "anthropic/claude-sonnet-4-5",
					thinking: "anthropic/claude-opus",
				},
				providers: [
					{
						id: "anthropic",
						name: "Anthropic",
						baseUrl: "https://api.anthropic.com/v1/messages",
						api: "anthropic-messages",
						models: [
							{
								id: "claude-haiku",
								name: "Haiku",
								contextWindow: 200000,
								maxTokens: 8192,
							},
							{
								id: "claude-sonnet-4-5",
								name: "Sonnet",
								contextWindow: 200000,
								maxTokens: 8192,
							},
							{
								id: "claude-opus",
								name: "Opus",
								contextWindow: 200000,
								maxTokens: 8192,
							},
						],
					},
				],
			};

			writeConfigFile(configPath, config);
			process.env.COMPOSER_CONFIG = configPath;
			reloadModelConfig(); // Force reload with new config

			const aliases = getAliases();
			expect(aliases).toEqual({
				fast: "anthropic/claude-haiku",
				smart: "anthropic/claude-sonnet-4-5",
				thinking: "anthropic/claude-opus",
			});

			const resolved = resolveAlias("fast");
			expect(resolved).toEqual({
				provider: "anthropic",
				modelId: "claude-haiku",
			});
		});

		it("should return null for non-existent alias", () => {
			const configPath = join(testDir, "no-aliases.json");
			const config = {
				providers: [
					{
						id: "test",
						name: "Test",
						baseUrl: "https://api.test.com",
						api: "anthropic-messages",
						models: [
							{
								id: "model-1",
								name: "Model",
								contextWindow: 100000,
								maxTokens: 4096,
							},
						],
					},
				],
			};

			writeConfigFile(configPath, config);
			process.env.COMPOSER_CONFIG = configPath;

			const resolved = resolveAlias("nonexistent");
			expect(resolved).toBeNull();
		});
	});

	describe("Config Validation", () => {
		it("should validate a valid config", () => {
			const configPath = join(testDir, "valid.json");
			const config = {
				providers: [
					{
						id: "test",
						name: "Test",
						baseUrl: "https://api.test.com",
						api: "anthropic-messages",
						models: [
							{
								id: "model-1",
								name: "Model 1",
								contextWindow: 100000,
								maxTokens: 4096,
							},
						],
					},
				],
			};

			writeConfigFile(configPath, config);
			process.env.COMPOSER_CONFIG = configPath;

			const result: ConfigValidationResult = validateConfig();
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
			expect(result.summary.providers).toBe(1);
			expect(result.summary.models).toBe(1);
		});

		it("should report warnings for missing env vars", () => {
			const configPath = join(testDir, "missing-vars.json");
			const config = {
				providers: [
					{
						id: "test",
						name: "Test",
						baseUrl: "https://api.test.com",
						api: "anthropic-messages",
						apiKey: "{env:MISSING_KEY}",
						models: [
							{
								id: "model-1",
								name: "Model 1",
								contextWindow: 100000,
								maxTokens: 4096,
							},
						],
					},
				],
			};

			writeConfigFile(configPath, config);
			process.env.COMPOSER_CONFIG = configPath;

			const result = validateConfig();
			expect(result.warnings.length).toBeGreaterThan(0);
		});

		it("should warn on providers with no models and no overrides", () => {
			const configPath = join(testDir, "noop-provider.json");
			const config = {
				providers: [
					{
						id: "noop",
						name: "No-op Provider",
					},
				],
			};

			writeConfigFile(configPath, config);
			process.env.COMPOSER_CONFIG = configPath;

			const result = validateConfig();
			expect(result.warnings.some((w) => w.includes("no effect"))).toBe(true);
		});
	});

	describe("Config Inspection", () => {
		it("should inspect loaded configuration", () => {
			const configPath = join(testDir, "inspect.json");
			const config = {
				providers: [
					{
						id: "test",
						name: "Test Provider",
						baseUrl: "https://api.test.com",
						api: "anthropic-messages",
						apiKeyEnv: "TEST_KEY",
						models: [
							{
								id: "model-1",
								name: "Model 1",
								contextWindow: 100000,
								maxTokens: 4096,
							},
							{
								id: "model-2",
								name: "Model 2",
								contextWindow: 200000,
								maxTokens: 8192,
							},
						],
					},
				],
			};

			writeConfigFile(configPath, config);
			process.env.COMPOSER_CONFIG = configPath;
			reloadModelConfig(); // Force reload with new config

			const inspection: ConfigInspection = inspectConfig();

			expect(inspection.sources.length).toBeGreaterThan(0);
			expect(inspection.providers.length).toBeGreaterThan(0);

			const provider = inspection.providers.find((p) => p.id === "test");
			expect(provider).toBeDefined();
			expect(provider?.name).toBe("Test Provider");
			expect(provider?.modelCount).toBe(2);
		});
	});

	describe("Built-in provider overrides", () => {
		it("should override baseUrl for built-in models", () => {
			const configPath = join(testDir, "override-baseurl.json");
			const overrideUrl = "http://localhost:7777/v1/messages";
			const config = {
				providers: [
					{
						id: "anthropic",
						name: "Anthropic",
						baseUrl: overrideUrl,
					},
				],
			};

			writeConfigFile(configPath, config);
			process.env.COMPOSER_CONFIG = configPath;
			reloadModelConfig();

			const models = getRegisteredModels().filter(
				(model) => model.provider === "anthropic",
			);
			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				expect(model.baseUrl).toBe(overrideUrl);
				expect(model.isLocal).toBe(true);
			}
		});

		it("should apply header overrides to built-in models", () => {
			const configPath = join(testDir, "override-headers.json");
			const config = {
				providers: [
					{
						id: "anthropic",
						name: "Anthropic",
						headers: {
							"X-Test-Header": "enabled",
						},
					},
				],
			};

			writeConfigFile(configPath, config);
			process.env.COMPOSER_CONFIG = configPath;
			reloadModelConfig();

			const models = getRegisteredModels().filter(
				(model) => model.provider === "anthropic",
			);
			expect(models.length).toBeGreaterThan(0);
			expect(models[0]?.headers?.["X-Test-Header"]).toBe("enabled");
		});
	});

	describe("Local provider detection", () => {
		it("should mark localhost providers as local in inspection", () => {
			const configPath = join(testDir, "local-provider.json");
			const config = {
				providers: [
					{
						id: "lmstudio",
						name: "LM Studio",
						baseUrl: "http://127.0.0.1:1234/v1",
						api: "openai-responses",
						models: [
							{
								id: "lmstudio/gemma",
								name: "Gemma",
								contextWindow: 200000,
								maxTokens: 8192,
							},
						],
					},
				],
			};

			writeConfigFile(configPath, config);
			process.env.COMPOSER_CONFIG = configPath;
			reloadModelConfig();

			const inspection = inspectConfig();
			const provider = inspection.providers.find((p) => p.id === "lmstudio");
			expect(provider).toBeDefined();
			expect(provider?.isLocal).toBe(true);
		});

		it("should set isLocal flag on registered models with localhost base URLs", () => {
			const configPath = join(testDir, "local-model.json");
			const config = {
				providers: [
					{
						id: "custom",
						name: "Custom",
						baseUrl: "https://api.example.com/v1",
						api: "openai-responses",
						models: [
							{
								id: "custom/local",
								name: "Local override",
								baseUrl: "http://localhost:7777/v1",
								contextWindow: 100000,
								maxTokens: 4096,
							},
						],
					},
				],
			};

			writeConfigFile(configPath, config);
			process.env.COMPOSER_CONFIG = configPath;
			reloadModelConfig();

			const models = getRegisteredModels().filter(
				(model) => model.id === "custom/local" && model.provider === "custom",
			);
			expect(models).toHaveLength(1);
			expect(models[0]?.isLocal).toBe(true);
		});

		it("should detect localhost URLs via helper", () => {
			expect(isLocalBaseUrl("http://localhost:11434/v1")).toBe(true);
			expect(isLocalBaseUrl("http://127.0.0.1")).toBe(true);
			expect(isLocalBaseUrl("https://api.example.com")).toBe(false);
		});
	});
});
