import {
	existsSync,
	mkdirSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ConfigInspection,
	type ConfigValidationResult,
	getAliases,
	inspectConfig,
	reloadModelConfig,
	resolveAlias,
	validateConfig,
} from "../src/models/registry";

describe("Config Features", () => {
	let testDir: string;
	let originalEnv: Record<string, string | undefined>;

	beforeEach(() => {
		// Create temp directory for test configs
		testDir = join(tmpdir(), `composer-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });

		// Save original env
		originalEnv = { ...process.env };
	});

	afterEach(() => {
		// Restore env first (before reloading config)
		process.env = originalEnv;

		// Clear config cache between tests
		try {
			reloadModelConfig();
		} catch (e) {
			// Ignore reload errors from invalid test configs
		}

		// Cleanup test directory
		try {
			rmdirSync(testDir, { recursive: true });
		} catch (e) {
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

			writeFileSync(configPath, config);
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

			writeFileSync(configPath, config);
			process.env.COMPOSER_CONFIG = configPath;

			const result = validateConfig();
			expect(result.valid).toBe(true);
		});
	});

	describe("Environment Variable Substitution", () => {
		it("should substitute {env:VAR} with environment variable", () => {
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

			writeFileSync(configPath, JSON.stringify(config));
			process.env.COMPOSER_CONFIG = configPath;

			const inspection = inspectConfig();
			const provider = inspection.providers.find((p) => p.id === "test");

			// Should have env vars tracked
			expect(inspection.envVars.length).toBeGreaterThan(0);
			const envVar = inspection.envVars.find((v) => v.name === "TEST_API_KEY");
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

			writeFileSync(configPath, JSON.stringify(config));
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
			writeFileSync(promptPath, "This is my system prompt");

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

			writeFileSync(configPath, JSON.stringify(config));
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

			writeFileSync(configPath, JSON.stringify(config));
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
						baseUrl: "https://api.anthropic.com",
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

			writeFileSync(configPath, JSON.stringify(config));
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

			writeFileSync(configPath, JSON.stringify(config));
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

			writeFileSync(configPath, JSON.stringify(config));
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

			writeFileSync(configPath, JSON.stringify(config));
			process.env.COMPOSER_CONFIG = configPath;

			const result = validateConfig();
			expect(result.warnings.length).toBeGreaterThan(0);
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

			writeFileSync(configPath, JSON.stringify(config));
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
});
