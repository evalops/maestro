/**
 * Global Config Loading Tests
 *
 * Tests for loading config from ~/.maestro/config.toml (global config).
 * Uses vi.mock at module level to mock the homedir function.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Test directory paths - set before vi.mock
let testDir: string;
let globalDir: string;
let projectDir: string;

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

// Mock homedir at module level for ESM compatibility
vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return {
		...actual,
		homedir: () => globalDir,
	};
});

// Must import after vi.mock
const { loadConfig, clearConfigCache, getAvailableProfiles, DEFAULT_CONFIG } =
	await import("../../src/config/toml-config.js");

describe("global config loading", () => {
	beforeEach(() => {
		testDir = join(tmpdir(), `composer-global-config-test-${Date.now()}`);
		globalDir = join(testDir, "home");
		projectDir = join(testDir, "project");
		process.env.HOME = globalDir;
		process.env.USERPROFILE = globalDir;
		mkdirSync(join(globalDir, ".maestro"), { recursive: true });
		mkdirSync(join(projectDir, ".maestro"), { recursive: true });
		clearConfigCache();
	});

	afterEach(() => {
		clearConfigCache();
		rmSync(testDir, { recursive: true, force: true });
		if (originalHome === undefined) {
			Reflect.deleteProperty(process.env, "HOME");
		} else {
			process.env.HOME = originalHome;
		}
		if (originalUserProfile === undefined) {
			Reflect.deleteProperty(process.env, "USERPROFILE");
		} else {
			process.env.USERPROFILE = originalUserProfile;
		}
		// Clean up env vars - must use delete because assignment to undefined
		// sets the value to the string "undefined" instead of removing it
		Reflect.deleteProperty(process.env, "MAESTRO_MODEL");
		Reflect.deleteProperty(process.env, "MAESTRO_MODEL_PROVIDER");
		Reflect.deleteProperty(process.env, "MAESTRO_APPROVAL_POLICY");
		Reflect.deleteProperty(process.env, "MAESTRO_SANDBOX_MODE");
		Reflect.deleteProperty(process.env, "MAESTRO_PROFILE");
	});

	it("loads global config from ~/.maestro/config.toml", () => {
		const globalConfigPath = join(globalDir, ".maestro", "config.toml");
		writeFileSync(
			globalConfigPath,
			`
model = "global-model"
model_provider = "global-provider"
`,
		);

		const config = loadConfig(projectDir);
		expect(config.model).toBe("global-model");
		expect(config.model_provider).toBe("global-provider");
	});

	it("project config overrides global config", () => {
		const globalConfigPath = join(globalDir, ".maestro", "config.toml");
		writeFileSync(
			globalConfigPath,
			`
model = "global-model"
model_provider = "global-provider"
approval_policy = "on-failure"
`,
		);

		const projectConfigPath = join(projectDir, ".maestro", "config.toml");
		writeFileSync(
			projectConfigPath,
			`
model = "project-model"
`,
		);

		const config = loadConfig(projectDir);
		// Project overrides global
		expect(config.model).toBe("project-model");
		// Global value preserved when not overridden
		expect(config.model_provider).toBe("global-provider");
		expect(config.approval_policy).toBe("on-failure");
	});

	it("deep merges global and project nested configs", () => {
		const globalConfigPath = join(globalDir, ".maestro", "config.toml");
		writeFileSync(
			globalConfigPath,
			`
[features]
web_search_request = true
ghost_commit = true

[tui]
notifications = true
animations = true
`,
		);

		const projectConfigPath = join(projectDir, ".maestro", "config.toml");
		writeFileSync(
			projectConfigPath,
			`
[features]
ghost_commit = false

[tui]
animations = false
`,
		);

		const config = loadConfig(projectDir);
		// Project overrides specific nested values
		expect(config.features?.ghost_commit).toBe(false);
		expect(config.tui?.animations).toBe(false);
		// Global values preserved when not overridden
		expect(config.features?.web_search_request).toBe(true);
		expect(config.tui?.notifications).toBe(true);
	});

	it("global profiles are available to project", () => {
		const globalConfigPath = join(globalDir, ".maestro", "config.toml");
		writeFileSync(
			globalConfigPath,
			`
[profiles.global-fast]
model = "haiku"
model_reasoning_effort = "low"

[profiles.global-powerful]
model = "opus"
model_reasoning_effort = "high"
`,
		);

		const projectConfigPath = join(projectDir, ".maestro", "config.toml");
		writeFileSync(
			projectConfigPath,
			`
[profiles.project-custom]
model = "custom-model"
`,
		);

		// Both global and project profiles should be available
		const profiles = getAvailableProfiles(projectDir);
		expect(profiles).toContain("global-fast");
		expect(profiles).toContain("global-powerful");
		expect(profiles).toContain("project-custom");

		// Can activate global profile
		clearConfigCache();
		const config = loadConfig(projectDir, "global-fast");
		expect(config.model).toBe("haiku");
		expect(config.model_reasoning_effort).toBe("low");
	});

	it("project profile overrides global profile with same name", () => {
		const globalConfigPath = join(globalDir, ".maestro", "config.toml");
		writeFileSync(
			globalConfigPath,
			`
[profiles.shared]
model = "global-shared-model"
model_provider = "global-provider"
`,
		);

		const projectConfigPath = join(projectDir, ".maestro", "config.toml");
		writeFileSync(
			projectConfigPath,
			`
[profiles.shared]
model = "project-shared-model"
`,
		);

		const config = loadConfig(projectDir, "shared");
		// Project profile takes precedence
		expect(config.model).toBe("project-shared-model");
		// Note: global profile value for model_provider is NOT preserved because
		// the project profiles.shared entirely replaces the global one
		// This is expected behavior - profiles are replaced, not merged
	});

	it("environment overrides take precedence over both global and project", () => {
		const globalConfigPath = join(globalDir, ".maestro", "config.toml");
		writeFileSync(globalConfigPath, 'model = "global-model"');

		const projectConfigPath = join(projectDir, ".maestro", "config.toml");
		writeFileSync(projectConfigPath, 'model = "project-model"');

		process.env.MAESTRO_MODEL = "env-model";

		const config = loadConfig(projectDir);
		expect(config.model).toBe("env-model");
	});

	it("CLI overrides take precedence over everything", () => {
		const globalConfigPath = join(globalDir, ".maestro", "config.toml");
		writeFileSync(globalConfigPath, 'model = "global-model"');

		const projectConfigPath = join(projectDir, ".maestro", "config.toml");
		writeFileSync(projectConfigPath, 'model = "project-model"');

		process.env.MAESTRO_MODEL = "env-model";

		const config = loadConfig(projectDir, undefined, {
			model: "cli-model",
		});
		expect(config.model).toBe("cli-model");
	});

	it("global MCP servers are merged with project servers", () => {
		const globalConfigPath = join(globalDir, ".maestro", "config.toml");
		writeFileSync(
			globalConfigPath,
			`
[mcp_servers.global-server]
command = "npx"
args = ["-y", "global-mcp"]

[mcp_servers.shared-server]
command = "global-cmd"
`,
		);

		const projectConfigPath = join(projectDir, ".maestro", "config.toml");
		writeFileSync(
			projectConfigPath,
			`
[mcp_servers.project-server]
command = "npx"
args = ["-y", "project-mcp"]

[mcp_servers.shared-server]
command = "project-cmd"
`,
		);

		const config = loadConfig(projectDir);
		// Global server preserved
		expect(config.mcp_servers?.["global-server"]?.command).toBe("npx");
		// Project server added
		expect(config.mcp_servers?.["project-server"]?.command).toBe("npx");
		// Shared server uses project value
		expect(config.mcp_servers?.["shared-server"]?.command).toBe("project-cmd");
	});

	it("global model providers are merged with project providers", () => {
		const globalConfigPath = join(globalDir, ".maestro", "config.toml");
		writeFileSync(
			globalConfigPath,
			`
[model_providers.openai]
name = "OpenAI"
base_url = "https://api.openai.com/v1"
env_key = "OPENAI_API_KEY"

[model_providers.anthropic]
name = "Anthropic Global"
base_url = "https://api.anthropic.com"
`,
		);

		const projectConfigPath = join(projectDir, ".maestro", "config.toml");
		writeFileSync(
			projectConfigPath,
			`
[model_providers.custom]
name = "Custom Provider"
base_url = "https://custom.api.com"

[model_providers.anthropic]
name = "Anthropic Project"
`,
		);

		const config = loadConfig(projectDir);
		// Global provider preserved
		expect(config.model_providers?.openai?.name).toBe("OpenAI");
		// Project provider added
		expect(config.model_providers?.custom?.name).toBe("Custom Provider");
		// Shared provider uses project value
		expect(config.model_providers?.anthropic?.name).toBe("Anthropic Project");
	});

	it("uses defaults when no config files exist", () => {
		// With no global or project config, should use defaults
		const config = loadConfig(projectDir);
		expect(config.model).toBe(DEFAULT_CONFIG.model);
		expect(config.model_provider).toBe(DEFAULT_CONFIG.model_provider);
		expect(config.approval_policy).toBe(DEFAULT_CONFIG.approval_policy);
	});
});
