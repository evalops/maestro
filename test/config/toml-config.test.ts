import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ComposerConfig,
	DEFAULT_CONFIG,
	applyCliOverride,
	clearConfigCache,
	getAvailableProfiles,
	getConfigSummary,
	loadConfig,
	parseCliOverride,
} from "../../src/config/toml-config.js";

describe("toml-config", () => {
	let testDir: string;
	let globalDir: string;
	let projectDir: string;

	beforeEach(() => {
		clearConfigCache();
		testDir = join(tmpdir(), `composer-config-test-${Date.now()}`);
		globalDir = join(testDir, "global", ".composer");
		projectDir = join(testDir, "project");
		mkdirSync(globalDir, { recursive: true });
		mkdirSync(join(projectDir, ".composer"), { recursive: true });
	});

	afterEach(() => {
		clearConfigCache();
		rmSync(testDir, { recursive: true, force: true });
		// Clean up env vars - must use delete because assignment to undefined
		// sets the value to the string "undefined" instead of removing it
		Reflect.deleteProperty(process.env, "COMPOSER_MODEL");
		Reflect.deleteProperty(process.env, "COMPOSER_MODEL_PROVIDER");
		Reflect.deleteProperty(process.env, "COMPOSER_APPROVAL_POLICY");
		Reflect.deleteProperty(process.env, "COMPOSER_SANDBOX_MODE");
		Reflect.deleteProperty(process.env, "COMPOSER_PROFILE");
	});

	describe("DEFAULT_CONFIG", () => {
		it("has sensible defaults", () => {
			expect(DEFAULT_CONFIG.model).toBe("claude-sonnet-4-20250514");
			expect(DEFAULT_CONFIG.model_provider).toBe("anthropic");
			expect(DEFAULT_CONFIG.approval_policy).toBe("untrusted");
			expect(DEFAULT_CONFIG.sandbox_mode).toBe("workspace-write");
			expect(DEFAULT_CONFIG.model_reasoning_effort).toBe("medium");
		});
	});

	describe("loadConfig", () => {
		it("returns defaults when no config files exist", () => {
			const config = loadConfig(projectDir);
			expect(config.model).toBe(DEFAULT_CONFIG.model);
			expect(config.model_provider).toBe(DEFAULT_CONFIG.model_provider);
		});

		it("loads project config", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
model = "gpt-4o"
model_provider = "openai"
approval_policy = "on-request"
`,
			);

			const config = loadConfig(projectDir);
			expect(config.model).toBe("gpt-4o");
			expect(config.model_provider).toBe("openai");
			expect(config.approval_policy).toBe("on-request");
		});

		it("deep merges nested configs", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
[features]
web_search_request = true
ghost_commit = false

[history]
persistence = "none"
max_bytes = 1048576
`,
			);

			const config = loadConfig(projectDir);
			expect(config.features?.web_search_request).toBe(true);
			expect(config.features?.ghost_commit).toBe(false);
			// Default preserved
			expect(config.features?.view_image_tool).toBe(true);
			expect(config.history?.persistence).toBe("none");
			expect(config.history?.max_bytes).toBe(1048576);
		});

		it("applies profiles", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
model = "claude-sonnet-4-20250514"
profile = "fast"

[profiles.fast]
model = "claude-haiku-3"
model_reasoning_effort = "low"

[profiles.powerful]
model = "claude-opus-4"
model_reasoning_effort = "high"
`,
			);

			const config = loadConfig(projectDir);
			expect(config.model).toBe("claude-haiku-3");
			expect(config.model_reasoning_effort).toBe("low");
		});

		it("allows profile override via parameter", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
model = "claude-sonnet-4-20250514"
profile = "fast"

[profiles.fast]
model = "claude-haiku-3"

[profiles.powerful]
model = "claude-opus-4"
`,
			);

			const config = loadConfig(projectDir, "powerful");
			expect(config.model).toBe("claude-opus-4");
		});

		it("caches config for same workspace and profile", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(configPath, 'model = "gpt-4o"');

			const config1 = loadConfig(projectDir);
			const config2 = loadConfig(projectDir);
			expect(config1).toBe(config2); // Same reference = cached
		});

		it("invalidates cache for different workspace", () => {
			const otherDir = join(testDir, "other-project");
			mkdirSync(join(otherDir, ".composer"), { recursive: true });

			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(configPath, 'model = "gpt-4o"');

			const otherConfigPath = join(otherDir, ".composer", "config.toml");
			writeFileSync(otherConfigPath, 'model = "claude-opus-4"');

			const config1 = loadConfig(projectDir);
			const config2 = loadConfig(otherDir);
			expect(config1.model).toBe("gpt-4o");
			expect(config2.model).toBe("claude-opus-4");
		});

		it("applies CLI overrides with highest precedence", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(configPath, 'model = "gpt-4o"');

			const config = loadConfig(projectDir, undefined, {
				model: "gemini-pro",
			});
			expect(config.model).toBe("gemini-pro");
		});
	});

	describe("environment variable overrides", () => {
		it("applies COMPOSER_MODEL", () => {
			process.env.COMPOSER_MODEL = "env-model";
			const config = loadConfig(projectDir);
			expect(config.model).toBe("env-model");
		});

		it("applies COMPOSER_MODEL_PROVIDER", () => {
			process.env.COMPOSER_MODEL_PROVIDER = "openai";
			const config = loadConfig(projectDir);
			expect(config.model_provider).toBe("openai");
		});

		it("applies COMPOSER_APPROVAL_POLICY", () => {
			process.env.COMPOSER_APPROVAL_POLICY = "on-failure";
			const config = loadConfig(projectDir);
			expect(config.approval_policy).toBe("on-failure");
		});

		it("applies COMPOSER_SANDBOX_MODE", () => {
			process.env.COMPOSER_SANDBOX_MODE = "read-only";
			const config = loadConfig(projectDir);
			expect(config.sandbox_mode).toBe("read-only");
		});

		it("applies COMPOSER_PROFILE", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
[profiles.test]
model = "test-model"
`,
			);

			process.env.COMPOSER_PROFILE = "test";
			const config = loadConfig(projectDir);
			expect(config.model).toBe("test-model");
		});

		it("ignores invalid approval policy values", () => {
			process.env.COMPOSER_APPROVAL_POLICY = "invalid-value";
			const config = loadConfig(projectDir);
			expect(config.approval_policy).toBe("untrusted");
		});

		it("ignores invalid sandbox mode values", () => {
			process.env.COMPOSER_SANDBOX_MODE = "invalid-mode";
			const config = loadConfig(projectDir);
			expect(config.sandbox_mode).toBe("workspace-write");
		});
	});

	describe("parseCliOverride", () => {
		it("parses simple string value", () => {
			const result = parseCliOverride("model=gpt-4o");
			expect(result).toEqual({ key: "model", value: "gpt-4o" });
		});

		it("parses quoted string value", () => {
			const result = parseCliOverride('model="gpt-4o"');
			expect(result).toEqual({ key: "model", value: "gpt-4o" });
		});

		it("parses boolean value", () => {
			const result = parseCliOverride("features.web_search_request=true");
			expect(result).toEqual({
				key: "features.web_search_request",
				value: true,
			});
		});

		it("parses numeric value", () => {
			const result = parseCliOverride("project_doc_max_bytes=65536");
			expect(result).toEqual({ key: "project_doc_max_bytes", value: 65536 });
		});

		it("parses array value", () => {
			const result = parseCliOverride('notify=["terminal", "desktop"]');
			expect(result).toEqual({ key: "notify", value: ["terminal", "desktop"] });
		});

		it("returns null for invalid format", () => {
			expect(parseCliOverride("invalid")).toBeNull();
			expect(parseCliOverride("=value")).toBeNull();
		});
	});

	describe("applyCliOverride", () => {
		it("applies top-level override", () => {
			const config: ComposerConfig = { model: "old-model" };
			const result = applyCliOverride(config, "model", "new-model");
			expect(result.model).toBe("new-model");
		});

		it("applies nested override", () => {
			const config: ComposerConfig = { features: { view_image_tool: true } };
			const result = applyCliOverride(
				config,
				"features.web_search_request",
				true,
			);
			expect(result.features?.web_search_request).toBe(true);
			expect(result.features?.view_image_tool).toBe(true);
		});

		it("creates nested structure if missing", () => {
			const config: ComposerConfig = {};
			const result = applyCliOverride(
				config,
				"model_providers.custom.base_url",
				"https://example.com",
			);
			expect(
				(result.model_providers as Record<string, { base_url: string }>)?.custom
					?.base_url,
			).toBe("https://example.com");
		});
	});

	describe("getAvailableProfiles", () => {
		it("returns empty array when no profiles defined", () => {
			const profiles = getAvailableProfiles(projectDir);
			expect(profiles).toEqual([]);
		});

		it("returns profile names", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
[profiles.fast]
model = "haiku"

[profiles.powerful]
model = "opus"

[profiles.balanced]
model = "sonnet"
`,
			);

			const profiles = getAvailableProfiles(projectDir);
			expect(profiles).toContain("fast");
			expect(profiles).toContain("powerful");
			expect(profiles).toContain("balanced");
			expect(profiles).toHaveLength(3);
		});
	});

	describe("getConfigSummary", () => {
		it("includes model and provider", () => {
			const summary = getConfigSummary(projectDir);
			expect(summary).toContain("Model:");
			expect(summary).toContain("Provider:");
		});

		it("includes active profile when set", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
profile = "test"

[profiles.test]
model = "test-model"
`,
			);

			const summary = getConfigSummary(projectDir);
			expect(summary).toContain("Active Profile: test");
		});

		it("lists available profiles", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
[profiles.alpha]
model = "a"

[profiles.beta]
model = "b"
`,
			);

			const summary = getConfigSummary(projectDir);
			expect(summary).toContain("Available Profiles:");
			expect(summary).toContain("alpha");
			expect(summary).toContain("beta");
		});
	});

	describe("model provider configuration", () => {
		it("parses full model provider config", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
[model_providers.custom]
name = "Custom Provider"
base_url = "https://api.custom.com/v1"
env_key = "CUSTOM_API_KEY"
wire_api = "chat"
request_max_retries = 5
stream_max_retries = 3
stream_idle_timeout_ms = 30000

[model_providers.custom.query_params]
version = "2024-01"

[model_providers.custom.http_headers]
X-Custom-Header = "value"
`,
			);

			const config = loadConfig(projectDir);
			const provider = config.model_providers?.custom;
			expect(provider?.name).toBe("Custom Provider");
			expect(provider?.base_url).toBe("https://api.custom.com/v1");
			expect(provider?.env_key).toBe("CUSTOM_API_KEY");
			expect(provider?.wire_api).toBe("chat");
			expect(provider?.request_max_retries).toBe(5);
			expect(provider?.stream_max_retries).toBe(3);
			expect(provider?.stream_idle_timeout_ms).toBe(30000);
			expect(provider?.query_params?.version).toBe("2024-01");
			expect(provider?.http_headers?.["X-Custom-Header"]).toBe("value");
		});
	});

	describe("MCP server configuration", () => {
		it("parses stdio MCP server", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
cwd = "/tmp"
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 60
enabled_tools = ["search", "fetch"]
`,
			);

			const config = loadConfig(projectDir);
			const server = config.mcp_servers?.context7;
			expect(server?.command).toBe("npx");
			expect(server?.args).toEqual(["-y", "@upstash/context7-mcp"]);
			expect(server?.cwd).toBe("/tmp");
			expect(server?.enabled).toBe(true);
			expect(server?.startup_timeout_sec).toBe(30);
			expect(server?.tool_timeout_sec).toBe(60);
			expect(server?.enabled_tools).toEqual(["search", "fetch"]);
		});

		it("parses HTTP MCP server", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
[mcp_servers.remote]
url = "https://mcp.example.com"
bearer_token_env_var = "MCP_TOKEN"

[mcp_servers.remote.http_headers]
X-API-Version = "v2"
`,
			);

			const config = loadConfig(projectDir);
			const server = config.mcp_servers?.remote;
			expect(server?.url).toBe("https://mcp.example.com");
			expect(server?.bearer_token_env_var).toBe("MCP_TOKEN");
			expect(server?.http_headers?.["X-API-Version"]).toBe("v2");
		});
	});

	describe("sandbox configuration", () => {
		it("parses sandbox workspace write config", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
writable_roots = ["/tmp", "/var/cache"]
network_access = false
exclude_tmpdir_env_var = true
exclude_slash_tmp = false
`,
			);

			const config = loadConfig(projectDir);
			expect(config.sandbox_mode).toBe("workspace-write");
			expect(config.sandbox_workspace_write?.writable_roots).toEqual([
				"/tmp",
				"/var/cache",
			]);
			expect(config.sandbox_workspace_write?.network_access).toBe(false);
			expect(config.sandbox_workspace_write?.exclude_tmpdir_env_var).toBe(true);
			expect(config.sandbox_workspace_write?.exclude_slash_tmp).toBe(false);
		});
	});

	describe("shell environment policy", () => {
		it("parses shell environment policy", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
[shell_environment_policy]
inherit = "core"
ignore_default_excludes = false
exclude = ["SECRET_KEY", "API_TOKEN"]
include_only = ["PATH", "HOME", "USER"]

[shell_environment_policy.set]
NODE_ENV = "development"
DEBUG = "composer:*"
`,
			);

			const config = loadConfig(projectDir);
			const policy = config.shell_environment_policy;
			expect(policy?.inherit).toBe("core");
			expect(policy?.ignore_default_excludes).toBe(false);
			expect(policy?.exclude).toEqual(["SECRET_KEY", "API_TOKEN"]);
			expect(policy?.include_only).toEqual(["PATH", "HOME", "USER"]);
			expect(policy?.set?.NODE_ENV).toBe("development");
			expect(policy?.set?.DEBUG).toBe("composer:*");
		});
	});

	describe("OTEL configuration", () => {
		it("parses OTLP HTTP exporter", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
[otel]
environment = "production"
log_user_prompt = false

[otel.exporter.otlp-http]
endpoint = "https://otel.example.com/v1/traces"
protocol = "binary"

[otel.exporter.otlp-http.headers]
Authorization = "Bearer token"
`,
			);

			const config = loadConfig(projectDir);
			const otel = config.otel;
			expect(otel?.environment).toBe("production");
			expect(otel?.log_user_prompt).toBe(false);
		});
	});

	describe("TUI configuration", () => {
		it("parses TUI settings", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
[tui]
notifications = ["error", "completion"]
animations = false
`,
			);

			const config = loadConfig(projectDir);
			expect(config.tui?.notifications).toEqual(["error", "completion"]);
			expect(config.tui?.animations).toBe(false);
		});

		it("parses boolean notifications setting", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
[tui]
notifications = true
`,
			);

			const config = loadConfig(projectDir);
			expect(config.tui?.notifications).toBe(true);
		});
	});

	describe("project trust configuration", () => {
		it("parses project trust levels", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
[projects."/Users/me/trusted-project"]
trust_level = "trusted"

[projects."/Users/me/sketchy-project"]
trust_level = "untrusted"
`,
			);

			const config = loadConfig(projectDir);
			expect(config.projects?.["/Users/me/trusted-project"]?.trust_level).toBe(
				"trusted",
			);
			expect(config.projects?.["/Users/me/sketchy-project"]?.trust_level).toBe(
				"untrusted",
			);
		});
	});

	describe("instructions configuration", () => {
		it("parses inline instructions", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
instructions = """
Always use TypeScript.
Follow the style guide.
"""
`,
			);

			const config = loadConfig(projectDir);
			expect(config.instructions).toContain("Always use TypeScript");
			expect(config.instructions).toContain("Follow the style guide");
		});

		it("parses instructions file path", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(
				configPath,
				`
experimental_instructions_file = ".composer/instructions.md"
`,
			);

			const config = loadConfig(projectDir);
			expect(config.experimental_instructions_file).toBe(
				".composer/instructions.md",
			);
		});
	});

	describe("error handling", () => {
		it("handles malformed TOML gracefully", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(configPath, "this is not valid = [ toml");

			// Should not throw, returns defaults
			const config = loadConfig(projectDir);
			expect(config.model).toBe(DEFAULT_CONFIG.model);
		});

		it("warns on missing profile", () => {
			const configPath = join(projectDir, ".composer", "config.toml");
			writeFileSync(configPath, 'profile = "nonexistent"');

			// Should not throw, just warns
			const config = loadConfig(projectDir);
			expect(config.model).toBe(DEFAULT_CONFIG.model);
		});
	});
});

// Global config loading tests are in a separate file that uses vi.mock
// to mock the homedir function at module level, which is required for ESM.
