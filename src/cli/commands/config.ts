import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { PATHS } from "../../config/constants.js";
import {
	type ConfigInspection,
	type ConfigValidationResult,
	getConfigHierarchy,
	inspectConfig,
	validateConfig,
} from "../../models/registry.js";
import {
	badge,
	muted,
	sectionHeading,
	separator as themedSeparator,
} from "../../style/theme.js";
// Use the UMD build to avoid ESM subpath resolution issues in some environments
import { parseJsonc } from "../../utils/jsonc-umd.js";
import { getHomeDir } from "../../utils/path-expansion.js";

import type { Api } from "../../agent/types.js";
import { getEnvVarsForProvider } from "../../providers/api-keys.js";
import {
	getEvalOpsManagedProviderDefinitions,
	isEvalOpsManagedProvider,
} from "../../providers/evalops-managed.js";

type ProviderPreset = {
	id: string;
	name: string;
	api: Api;
	defaultModel: string;
	baseUrl?: string;
	requiresApiKey: boolean;
	apiKeyEnv?: string;
	note?: string;
	contextWindow?: number;
	maxTokens?: number;
};

function getManagedGatewayBaseUrl(): string {
	return (
		process.env.MAESTRO_LLM_GATEWAY_URL?.trim() || "http://127.0.0.1:8081/v1"
	);
}

function getManagedGatewayProviderPresets(): ProviderPreset[] {
	return getEvalOpsManagedProviderDefinitions().map((definition) => ({
		id: definition.id,
		name: definition.name,
		api: definition.api,
		defaultModel: definition.defaultModel,
		baseUrl: getManagedGatewayBaseUrl(),
		requiresApiKey: false,
		note: definition.note,
	}));
}

export function getProviderPresets(): ProviderPreset[] {
	return [
		{
			id: "anthropic",
			name: "Anthropic (Claude)",
			api: "anthropic-messages",
			defaultModel: "claude-opus-4-6",
			baseUrl: "https://api.anthropic.com",
			requiresApiKey: true,
			apiKeyEnv: "ANTHROPIC_API_KEY",
			contextWindow: 1000000,
			maxTokens: 128000,
		},
		{
			id: "openai",
			name: "OpenAI (Responses)",
			api: "openai-responses",
			defaultModel: "gpt-4o-mini",
			baseUrl: "https://api.openai.com/v1",
			requiresApiKey: true,
			apiKeyEnv: "OPENAI_API_KEY",
		},
		{
			id: "groq",
			name: "Groq",
			api: "openai-completions",
			defaultModel: "llama-3.3-70b-versatile",
			baseUrl: "https://api.groq.com/openai/v1",
			requiresApiKey: true,
			apiKeyEnv: "GROQ_API_KEY",
		},
		{
			id: "openrouter",
			name: "OpenRouter",
			api: "openai-completions",
			defaultModel: "openai/o4-mini",
			baseUrl: "https://openrouter.ai/api/v1",
			requiresApiKey: true,
			apiKeyEnv: "OPENROUTER_API_KEY",
			note: "Supports many upstreams; accepts OpenAI-compatible keys",
		},
		...getManagedGatewayProviderPresets(),
		{
			id: "google-gemini",
			name: "Google Gemini API",
			api: "google-generative-ai",
			defaultModel: "gemini-2.0-flash",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			requiresApiKey: true,
			apiKeyEnv: "GEMINI_API_KEY",
		},
		{
			id: "google-gemini-cli",
			name: "Google Gemini CLI (Cloud Code Assist)",
			api: "google-gemini-cli",
			defaultModel: "gemini-2.5-flash",
			baseUrl: "https://cloudcode-pa.googleapis.com",
			requiresApiKey: false,
			note: "Requires OAuth via /login (token includes projectId)",
		},
		{
			id: "google-antigravity",
			name: "Google Antigravity (Sandbox)",
			api: "google-gemini-cli",
			defaultModel: "gemini-3-pro-high",
			baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
			requiresApiKey: false,
			note: "Requires OAuth via /login (token includes projectId)",
		},
		{
			id: "vertex-ai",
			name: "Google Vertex AI (Claude/Gemini)",
			api: "anthropic-messages",
			defaultModel: "claude-3-7-sonnet@20250219",
			baseUrl: "https://us-central1-aiplatform.googleapis.com/v1beta1",
			requiresApiKey: false,
			note: "Uses ADC; set GOOGLE_APPLICATION_CREDENTIALS or gcloud login",
		},
		{
			id: "bedrock",
			name: "AWS Bedrock",
			api: "openai-completions",
			defaultModel: "anthropic.claude-3-7-sonnet-20250219-v1:0",
			requiresApiKey: false,
			note: "Uses AWS credentials + region envs",
		},
		{
			id: "mistral",
			name: "Mistral",
			api: "openai-completions",
			defaultModel: "mistral-large-latest",
			baseUrl: "https://api.mistral.ai/v1",
			requiresApiKey: true,
			apiKeyEnv: "MISTRAL_API_KEY",
		},
		{
			id: "lmstudio",
			name: "LM Studio (local)",
			api: "openai-responses",
			defaultModel: "lmstudio/gemma-3n",
			baseUrl: "http://127.0.0.1:1234/v1",
			requiresApiKey: false,
		},
		{
			id: "ollama",
			name: "Ollama (local)",
			api: "openai-responses",
			defaultModel: "ollama/llama3.2",
			baseUrl: "http://localhost:11434/v1",
			requiresApiKey: false,
		},
	];
}

export interface ConfigShowRenderOptions {
	hierarchy: string[];
	homeDir?: string;
	disableColors?: boolean;
}

// Adapted from ansi-regex (MIT) to cover CSI and OSC escape sequences.
const ANSI_STRING_TERMINATORS = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
const ANSI_OSC_SEQUENCE = `(?:\\u001B\\][\\s\\S]*?${ANSI_STRING_TERMINATORS})`;
const ANSI_CSI_SEQUENCE =
	"[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
const ANSI_ESCAPE_SEQUENCE = new RegExp(
	`${ANSI_OSC_SEQUENCE}|${ANSI_CSI_SEQUENCE}`,
	"g",
);

function stripAnsi(value: string): string {
	return value.replace(ANSI_ESCAPE_SEQUENCE, "");
}

const normalizeForCompare = (value: string): string =>
	process.platform === "win32" ? value.toLowerCase() : value;

function replaceHomePrefix(path: string, homeDir: string): string {
	const normalizedPath = path.replace(/\\/g, "/");
	const normalizedHome = homeDir.replace(/\\/g, "/");
	const pathCheck = normalizeForCompare(normalizedPath);
	const homeCheck = normalizeForCompare(normalizedHome);
	if (pathCheck === homeCheck) {
		return "~";
	}
	if (pathCheck.startsWith(`${homeCheck}/`)) {
		return `~${normalizedPath.slice(normalizedHome.length)}`;
	}
	return path;
}

export function buildConfigShowSections(
	inspection: ConfigInspection,
	options: ConfigShowRenderOptions,
): string[] {
	const homeDir = options.homeDir ?? getHomeDir();
	const rel = (path: string) => replaceHomePrefix(path, homeDir);
	const output: string[] = [];

	output.push(sectionHeading("Configuration Inspection"));
	output.push("");
	output.push(badge("Config Sources", undefined, "info"));
	for (const source of inspection.sources) {
		const status = source.exists
			? badge("present", undefined, "success")
			: badge("missing", undefined, "warn");
		const mark = options.hierarchy.includes(source.path) ? "•" : " ";
		output.push(`  ${mark} ${status} ${muted(rel(source.path))}`);
	}
	output.push("");

	if (inspection.providers.length > 0) {
		output.push(
			badge(`Providers (${inspection.providers.length})`, undefined, "info"),
		);
		for (const provider of inspection.providers) {
			const isOverrideOnly = provider.modelCount === 0;
			const heading = `${chalk.cyan(provider.id)} ${muted(
				`(${provider.modelCount} models)`,
			)}`;
			const enabledBadge = provider.enabled
				? badge("enabled", undefined, "success")
				: badge("disabled", undefined, "warn");
			const metaBadges: string[] = [];
			if (isOverrideOnly) {
				metaBadges.push(badge("override-only", undefined, "info"));
				if (provider.apiKeySource) {
					metaBadges.push(badge("API key", provider.apiKeySource, "success"));
				}
			} else {
				const keyBadge = provider.apiKeySource
					? badge("API key", provider.apiKeySource, "success")
					: badge("API key missing", undefined, "warn");
				metaBadges.push(keyBadge);
			}
			metaBadges.push(enabledBadge);
			const metaLine = metaBadges.join(` ${themedSeparator()} `);
			output.push(`  ${heading} ${themedSeparator()} ${metaLine}`);
			output.push(`     ${muted(provider.name)}`);
			output.push(`     ${muted(`Base URL: ${provider.baseUrl}`)}`);
			if (provider.options && Object.keys(provider.options).length > 0) {
				output.push(muted(`     Options: ${JSON.stringify(provider.options)}`));
			}
			if (provider.models.length <= 3) {
				for (const model of provider.models) {
					output.push(muted(`       • ${formatModelLabel(model)}`));
				}
			} else {
				const firstModel = provider.models[0];
				const secondModel = provider.models[1];
				if (firstModel) {
					output.push(muted(`       • ${formatModelLabel(firstModel)}`));
				}
				if (secondModel) {
					output.push(muted(`       • ${formatModelLabel(secondModel)}`));
				}
				output.push(muted(`       ... and ${provider.models.length - 2} more`));
			}
			output.push("");
		}
	} else {
		output.push(`${badge("No providers configured", undefined, "warn")}`);
		output.push("");
	}

	if (inspection.fileReferences.length > 0) {
		output.push(
			badge(
				`File References (${inspection.fileReferences.length})`,
				undefined,
				"info",
			),
		);
		for (const ref of inspection.fileReferences) {
			const status = ref.exists
				? badge("present", undefined, "success")
				: badge("missing", undefined, "danger");
			const size = ref.size ? ` (${formatBytes(ref.size)})` : "";
			output.push(`  ${status} ${muted(rel(ref.path))}${muted(size)}`);
		}
		output.push("");
	}

	if (inspection.envVars.length > 0) {
		output.push(
			badge(
				`Environment Variables (${inspection.envVars.length})`,
				undefined,
				"info",
			),
		);
		for (const envVar of inspection.envVars) {
			const status = envVar.set
				? badge("set", undefined, "success")
				: badge("missing", undefined, "warn");
			const value = envVar.maskedValue ? envVar.maskedValue : "(not set)";
			output.push(`  ${status} ${chalk.cyan(envVar.name)}: ${muted(value)}`);
		}
		output.push("");
	}

	if (options.disableColors) {
		return output.map((line) => stripAnsi(line));
	}
	return output;
}

/**
 * Handle `maestro config validate` command
 */
export async function handleConfigValidate(): Promise<void> {
	console.log(sectionHeading("Validating Configuration"));

	const result: ConfigValidationResult = validateConfig();
	const homeDir = getHomeDir();

	// Show config files
	if (result.summary.configFiles.length > 0) {
		console.log(muted("Config Files:"));
		for (const file of result.summary.configFiles) {
			const relPath = replaceHomePrefix(file, homeDir);
			console.log(muted(`  • ${relPath}`));
		}
		console.log();
	}

	// Show errors
	if (result.errors.length > 0) {
		console.log(badge("[ERROR] Errors", undefined, "danger"));
		for (const error of result.errors) {
			console.log(chalk.red(`  • ${error}`));
		}
		console.log();
	}

	// Show warnings
	if (result.warnings.length > 0) {
		console.log(badge("[WARN] Warnings", undefined, "warn"));
		for (const warning of result.warnings) {
			console.log(chalk.yellow(`  • ${warning}`));
		}
		console.log();
	}

	// Show summary
	console.log(muted("Summary:"));
	console.log(
		muted(`  • ${badge("Providers", String(result.summary.providers))}`),
	);
	console.log(muted(`  • ${badge("Models", String(result.summary.models))}`));
	console.log(
		muted(
			`  • ${badge(
				"File References",
				String(result.summary.fileReferences.length),
			)}`,
		),
	);
	console.log(
		muted(
			`  • ${badge(
				"Environment Variables",
				String(result.summary.envVars.length),
			)}`,
		),
	);
	console.log();

	// Final verdict
	if (result.valid) {
		console.log(`${badge("Configuration is valid", undefined, "success")}\n`);
		process.exit(0);
	} else {
		console.log(`${badge("Configuration has errors", undefined, "danger")}\n`);
		process.exit(1);
	}
}

/**
 * Legacy renderer for `maestro config show`
 */
function renderConfigShowLegacy(
	inspection: ConfigInspection,
	hierarchy: string[],
	homeDir: string,
): void {
	console.log(sectionHeading("Configuration Inspection"));

	// Show config sources
	console.log(badge("Config Sources", undefined, "info"));
	for (const source of inspection.sources) {
		const relPath = replaceHomePrefix(source.path, homeDir);
		const status = source.exists
			? badge("present", undefined, "success")
			: badge("missing", undefined, "warn");
		const mark = hierarchy.includes(source.path) ? "•" : " ";
		console.log(`  ${mark} ${status} ${muted(relPath)}`);
	}
	console.log();

	// Show providers
	if (inspection.providers.length > 0) {
		console.log(
			badge(`Providers (${inspection.providers.length})`, undefined, "info"),
		);
		for (const provider of inspection.providers) {
			const isOverrideOnly = provider.modelCount === 0;
			const heading = `${chalk.cyan(provider.id)} ${muted(
				`(${provider.modelCount} models)`,
			)}`;
			const enabledBadge = provider.enabled
				? badge("enabled", undefined, "success")
				: badge("disabled", undefined, "warn");
			const metaBadges: string[] = [];
			if (isOverrideOnly) {
				metaBadges.push(badge("override-only", undefined, "info"));
				if (provider.apiKeySource) {
					metaBadges.push(badge("API key", provider.apiKeySource, "success"));
				}
			} else {
				const keyBadge = provider.apiKeySource
					? badge("API key", provider.apiKeySource, "success")
					: badge("API key missing", undefined, "warn");
				metaBadges.push(keyBadge);
			}
			metaBadges.push(enabledBadge);
			const metaLine = metaBadges.join(` ${themedSeparator()} `);

			console.log(`  ${heading} ${themedSeparator()} ${metaLine}`);
			console.log(`     ${muted(provider.name)}`);
			console.log(`     ${muted(`Base URL: ${provider.baseUrl}`)}`);
			if (provider.options && Object.keys(provider.options).length > 0) {
				console.log(muted(`     Options: ${JSON.stringify(provider.options)}`));
			}

			// Show models
			if (provider.models.length <= 3) {
				for (const model of provider.models) {
					console.log(muted(`       • ${formatModelLabel(model)}`));
				}
			} else {
				const firstModel = provider.models[0];
				const secondModel = provider.models[1];
				if (firstModel) {
					console.log(muted(`       • ${formatModelLabel(firstModel)}`));
				}
				if (secondModel) {
					console.log(muted(`       • ${formatModelLabel(secondModel)}`));
				}
				console.log(muted(`       ... and ${provider.models.length - 2} more`));
			}
			console.log();
		}
	} else {
		console.log(`${badge("No providers configured", undefined, "warn")}\n`);
	}

	// Show file references
	if (inspection.fileReferences.length > 0) {
		console.log(
			badge(
				`File References (${inspection.fileReferences.length})`,
				undefined,
				"info",
			),
		);
		for (const ref of inspection.fileReferences) {
			const relPath = replaceHomePrefix(ref.path, homeDir);
			const status = ref.exists
				? badge("present", undefined, "success")
				: badge("missing", undefined, "danger");
			const size = ref.size ? ` (${formatBytes(ref.size)})` : "";
			console.log(`  ${status} ${muted(relPath)}${muted(size)}`);
		}
		console.log();
	}

	// Show environment variables
	if (inspection.envVars.length > 0) {
		console.log(
			badge(
				`Environment Variables (${inspection.envVars.length})`,
				undefined,
				"info",
			),
		);
		for (const envVar of inspection.envVars) {
			const status = envVar.set
				? badge("set", undefined, "success")
				: badge("missing", undefined, "warn");
			const value = envVar.maskedValue ? envVar.maskedValue : "(not set)";
			console.log(`  ${status} ${chalk.cyan(envVar.name)}: ${muted(value)}`);
		}
		console.log();
	}
}

/**
 * Handle `maestro config show` command
 */
export async function handleConfigShow(): Promise<void> {
	const inspection: ConfigInspection = inspectConfig();
	const hierarchy = getConfigHierarchy();
	const homeDir = getHomeDir();
	const layoutPref = (
		process.env.MAESTRO_CONFIG_SHOW_LAYOUT ?? "v2"
	).toLowerCase();

	if (layoutPref === "legacy") {
		renderConfigShowLegacy(inspection, hierarchy, homeDir);
	} else {
		const lines = buildConfigShowSections(inspection, {
			hierarchy,
			homeDir,
			disableColors: !process.stdout.isTTY,
		});
		for (const line of lines) {
			console.log(line);
		}
	}

	process.exit(0);
}

/**
 * Handle `maestro config init` command
 */
export async function handleConfigInit(): Promise<void> {
	console.log(sectionHeading("Initialize Maestro Configuration"));

	const readline = await import("node:readline/promises");
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		const providerPresets = getProviderPresets();

		// Determine config location
		const configDir = join(process.cwd(), ".maestro");
		const configPath = join(configDir, "config.json");
		const promptsDir = join(configDir, "prompts");

		// Check if config already exists
		if (existsSync(configPath)) {
			const overwrite = await rl.question(
				chalk.yellow(
					`Config already exists at ${configPath}. Overwrite? (y/N): `,
				),
			);
			if (overwrite.toLowerCase() !== "y") {
				console.log(muted("\nCancelled."));
				rl.close();
				return;
			}
		}

		// Optional flag: --preset <id> to skip menu
		const args = process.argv.slice(2);
		const presetFlagIndex = args.findIndex(
			(arg) => arg === "--preset" || arg === "-p",
		);
		const presetId =
			presetFlagIndex >= 0 ? (args[presetFlagIndex + 1] ?? "") : "";

		// Step 1: Choose provider
		console.log(`\n${badge("1. Choose your provider", undefined, "info")}`);
		providerPresets.forEach((preset, idx) => {
			const note = preset.note ? chalk.dim(` — ${preset.note}`) : "";
			console.log(`  ${idx + 1}) ${preset.name}${note}`);
		});

		let preset: ProviderPreset | undefined;
		if (presetId) {
			const found = providerPresets.find(
				(p) => p.id.toLowerCase() === presetId.toLowerCase(),
			);
			if (!found) {
				console.log(
					chalk.yellow(
						`\nUnknown preset "${presetId}", falling back to menu selection.`,
					),
				);
			} else {
				preset = found;
				console.log(chalk.green(`\nUsing preset: ${preset.name}`));
			}
		}

		if (!preset) {
			const providerChoice = await rl.question(
				chalk.cyan(`\nProvider (1-${providerPresets.length}): `),
			);

			const presetIndex =
				Number.parseInt(providerChoice.trim(), 10) - 1 >= 0 &&
				Number.parseInt(providerChoice.trim(), 10) - 1 < providerPresets.length
					? Number.parseInt(providerChoice.trim(), 10) - 1
					: 0;
			preset = providerPresets[presetIndex] ?? providerPresets[0];
		}

		// At this point preset is guaranteed to be defined because providerPresets is non-empty
		if (!preset) {
			throw new Error("No provider presets available");
		}

		const {
			id: providerId,
			name: providerName,
			baseUrl,
			api: apiType,
		} = preset;
		const { defaultModel } = preset;
		const requiresApiKey = preset.requiresApiKey;

		let useEnv = true;
		let apiKeyField: { apiKeyEnv?: string; apiKey?: string } = {};
		if (requiresApiKey) {
			console.log(
				`\n${badge(
					"2. How would you like to provide your API key?",
					undefined,
					"info",
				)}`,
			);
			console.log("  1) Environment variable (recommended)");
			console.log("  2) Direct in config (not recommended)");

			const keyChoice = await rl.question(chalk.cyan("\nChoice (1-2): "));
			useEnv = keyChoice.trim() !== "2";

			if (useEnv) {
				const fallbackEnv =
					getEnvVarsForProvider(providerId)[0] ??
					`${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
				const envVarName = preset.apiKeyEnv ?? fallbackEnv;
				apiKeyField = { apiKeyEnv: envVarName };
				console.log(chalk.dim(`\nUsing environment variable: ${envVarName}`));
			} else {
				const apiKey = await rl.question(chalk.cyan("\nEnter API key: "));
				apiKeyField = { apiKey: apiKey.trim() };
			}
		} else {
			useEnv = false;
			const noKeyMessage = isEvalOpsManagedProvider(providerId)
				? "\nManaged gateway preset does not use a local API key. Run /login evalops after setup."
				: "\nLocal providers do not require API keys. Skipping step.";
			console.log(chalk.dim(noKeyMessage));
		}

		// Step 3: Use file references for prompts
		console.log(
			`\n${badge(
				"3. Would you like to use file references for prompts?",
				undefined,
				"info",
			)}`,
		);
		console.log("  This creates a prompts/ folder for better organization.");

		const useFiles = await rl.question(
			chalk.cyan("\nUse file references? (Y/n): "),
		);
		const createPrompts = useFiles.toLowerCase() !== "n";

		// Create directories
		mkdirSync(configDir, { recursive: true });
		if (createPrompts) {
			mkdirSync(promptsDir, { recursive: true });
		}

		// Create config
		const config: LocalConfigFile = {
			$schema: "https://composer-cli.dev/config.schema.json",
			providers: [
				{
					id: providerId,
					name: providerName,
					...(baseUrl && { baseUrl }),
					api: apiType,
					...apiKeyField,
					models: [
						{
							id: defaultModel,
							name: createPrompts
								? "{file:./prompts/system.md}"
								: "Default assistant",
							contextWindow: preset?.contextWindow ?? 200000,
							maxTokens: preset?.maxTokens ?? 8192,
						},
					],
				},
			],
		};

		// Write config
		writeFileSync(configPath, JSON.stringify(config, null, 2));
		console.log(`\n${badge("Created config", configPath, "success")}`);

		// Create example prompt file
		if (createPrompts) {
			const systemPromptPath = join(promptsDir, "system.md");
			const examplePrompt = `# System Prompt

You are a helpful AI coding assistant.

## Guidelines

- Write clean, maintainable code
- Follow best practices
- Provide clear explanations
- Test your suggestions

## Style

- Be concise but thorough
- Use examples when helpful
- Ask clarifying questions when needed
`;
			writeFileSync(systemPromptPath, examplePrompt);
			console.log(badge("Created prompt", systemPromptPath, "success"));
		}

		// Create .env.example if using environment variables
		if (useEnv) {
			const envExamplePath = join(process.cwd(), ".env.example");
			const envVarName = apiKeyField.apiKeyEnv ?? "";
			const envContent = existsSync(envExamplePath)
				? `\n# Added by maestro init\n${envVarName}=your-api-key-here\n`
				: `# Maestro Configuration\n${envVarName}=your-api-key-here\n`;

			if (existsSync(envExamplePath)) {
				const fs = await import("node:fs/promises");
				await fs.appendFile(envExamplePath, envContent);
			} else {
				writeFileSync(envExamplePath, envContent);
			}
			console.log(badge("Updated .env.example", undefined, "success"));
		}

		// Show next steps
		console.log(sectionHeading("Configuration initialized successfully!"));
		console.log(muted("Next steps:"));

		if (useEnv) {
			const envVarName = apiKeyField.apiKeyEnv ?? "";
			console.log(muted(`  1. Set ${envVarName} in your environment`));
		}
		if (createPrompts) {
			console.log(muted("  2. Edit .maestro/prompts/system.md"));
		}
		console.log(muted("  3. Run: maestro models list"));
		console.log(muted('  4. Start using: maestro "your prompt"\n'));

		rl.close();
	} catch (error) {
		rl.close();
		throw error;
	}
}

type LocalProviderTemplate = {
	id: string;
	name: string;
	baseUrl: string;
	api: string;
	model: {
		id: string;
		name: string;
		contextWindow: number;
		maxTokens: number;
	};
};

const LOCAL_PROVIDER_TEMPLATES: Record<string, LocalProviderTemplate> = {
	lmstudio: {
		id: "lmstudio",
		name: "LM Studio (local)",
		baseUrl: "http://127.0.0.1:1234/v1",
		api: "openai-responses",
		model: {
			id: "lmstudio/gemma-3n",
			name: "Gemma 3n (local)",
			contextWindow: 200_000,
			maxTokens: 8192,
		},
	},
	ollama: {
		id: "ollama",
		name: "Ollama (local)",
		baseUrl: "http://localhost:11434/v1",
		api: "openai-responses",
		model: {
			id: "ollama/llama3.1",
			name: "Llama 3.1 (local)",
			contextWindow: 128_000,
			maxTokens: 8192,
		},
	},
};

interface LocalConfigFile {
	$schema?: string;
	providers?: Array<{
		id: string;
		name: string;
		api: string;
		baseUrl?: string;
		models: Array<{
			id: string;
			name: string;
			contextWindow: number;
			maxTokens: number;
			input?: Array<"text" | "image">;
		}>;
		options?: Record<string, unknown>;
	}>;
}

function loadLocalConfig(path: string): LocalConfigFile {
	if (!existsSync(path)) {
		return {
			$schema: "https://composer-cli.dev/config.schema.json",
			providers: [],
		};
	}
	const raw = readFileSync(path, "utf-8");
	try {
		const parsed = parseJsonc(raw, [], {
			allowTrailingComma: true,
			disallowComments: false,
		});
		if (!parsed || typeof parsed !== "object") {
			return {
				$schema: "https://composer-cli.dev/config.schema.json",
				providers: [],
			};
		}
		return parsed as LocalConfigFile;
	} catch (error) {
		throw new Error(
			`Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function upsertLocalProvider(
	config: LocalConfigFile,
	provider: LocalProviderTemplate,
	overrides: {
		id: string;
		name: string;
		baseUrl: string;
		modelId: string;
		modelName: string;
		contextWindow: number;
		maxTokens: number;
	},
): void {
	if (!Array.isArray(config.providers)) {
		config.providers = [];
	}
	type ProviderEntry = NonNullable<LocalConfigFile["providers"]>[number];
	const entry: ProviderEntry = {
		id: overrides.id,
		name: overrides.name,
		api: provider.api,
		baseUrl: overrides.baseUrl,
		models: [
			{
				id: overrides.modelId,
				name: overrides.modelName,
				contextWindow: overrides.contextWindow,
				maxTokens: overrides.maxTokens,
				input: ["text"] as Array<"text" | "image">,
			},
		],
	};
	const existingIndex = config.providers.findIndex(
		(p) => p?.id === overrides.id,
	);
	if (existingIndex >= 0) {
		config.providers[existingIndex] = entry;
	} else {
		config.providers.push(entry);
	}
}

async function checkLocalEndpoint(
	name: string,
	baseUrl: string,
): Promise<string> {
	try {
		const url = new URL(baseUrl);
		url.pathname = "/models";
		const response = await fetch(url.toString(), { method: "GET" });
		if (response.ok) {
			return `${badge(name, undefined, "success")} ${chalk.dim(
				`responded with ${response.status}`,
			)}`;
		}
		return `${badge(name, undefined, "warn")} ${chalk.dim(
			`HTTP ${response.status}`,
		)}`;
	} catch (error) {
		return `${badge(name, undefined, "danger")} ${chalk.dim(
			error instanceof Error ? error.message : String(error),
		)}`;
	}
}

export async function handleConfigLocal(): Promise<void> {
	console.log(sectionHeading("Local provider helper"));
	const readline = await import("node:readline/promises");
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		console.log("  1) Add LM Studio provider");
		console.log("  2) Add Ollama provider");
		console.log("  3) Check local endpoints");
		console.log("  4) Cancel");
		const choice = (await rl.question(chalk.cyan("\nChoice (1-4): "))).trim();

		if (choice === "4") {
			console.log(muted("\nCancelled."));
			rl.close();
			return;
		}

		if (choice === "3") {
			const lmstudioTemplate = LOCAL_PROVIDER_TEMPLATES.lmstudio;
			const ollamaTemplate = LOCAL_PROVIDER_TEMPLATES.ollama;
			const targets = [
				...(lmstudioTemplate
					? [{ name: "LM Studio", url: lmstudioTemplate.baseUrl }]
					: []),
				...(ollamaTemplate
					? [{ name: "Ollama", url: ollamaTemplate.baseUrl }]
					: []),
			];
			for (const target of targets) {
				console.log(await checkLocalEndpoint(target.name, target.url));
			}
			rl.close();
			return;
		}

		const templateKey = choice === "2" ? "ollama" : "lmstudio";
		const template = LOCAL_PROVIDER_TEMPLATES[templateKey];
		if (!template) {
			console.log(chalk.red(`\nUnknown template: ${templateKey}`));
			rl.close();
			return;
		}

		const scope = (
			await rl.question(
				chalk.cyan(
					"\nSave provider to:\n  1) Project (.maestro/local.json)\n  2) Home (~/.maestro/local.json)\n\nChoice (1-2): ",
				),
			)
		).trim();
		const targetDir =
			scope === "2" ? PATHS.MAESTRO_HOME : join(process.cwd(), ".maestro");
		mkdirSync(targetDir, { recursive: true });
		const localPath = join(targetDir, "local.json");
		const config = loadLocalConfig(localPath);

		const providerId =
			(
				await rl.question(chalk.cyan(`\nProvider id (${template.id}): `))
			).trim() || template.id;
		const providerName =
			(
				await rl.question(chalk.cyan(`Provider name (${template.name}): `))
			).trim() || template.name;
		const baseUrl =
			(
				await rl.question(chalk.cyan(`Base URL (${template.baseUrl}): `))
			).trim() || template.baseUrl;
		const modelId =
			(
				await rl.question(chalk.cyan(`Model id (${template.model.id}): `))
			).trim() || template.model.id;
		const modelName =
			(
				await rl.question(chalk.cyan(`Model name (${template.model.name}): `))
			).trim() || template.model.name;
		const contextWindowAnswer = (
			await rl.question(
				chalk.cyan(`Context window (${template.model.contextWindow}): `),
			)
		).trim();
		const maxTokensAnswer = (
			await rl.question(
				chalk.cyan(`Max output tokens (${template.model.maxTokens}): `),
			)
		).trim();
		const contextWindow =
			Number.parseInt(contextWindowAnswer, 10) || template.model.contextWindow;
		const maxTokens =
			Number.parseInt(maxTokensAnswer, 10) || template.model.maxTokens;

		upsertLocalProvider(config, template, {
			id: providerId,
			name: providerName,
			baseUrl,
			modelId,
			modelName,
			contextWindow,
			maxTokens,
		});
		if (!config.$schema) {
			config.$schema = "https://composer-cli.dev/config.schema.json";
		}
		writeFileSync(localPath, JSON.stringify(config, null, 2));
		console.log(`\n${badge("Updated local config", localPath, "success")}`);
		console.log(
			muted(
				"Reload your models (/model) after starting the local runtime to use the new provider.",
			),
		);
		console.log(
			muted("Tip: run `maestro config local` again to check connectivity."),
		);

		rl.close();
	} catch (error) {
		rl.close();
		throw error;
	}
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let index = 0;
	let value = bytes;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}
	return `${value.toFixed(1)} ${units[index]}`;
}

function formatModelLabel(model: {
	id: string;
	reasoning?: boolean;
	input?: string[];
}): string {
	const caps: string[] = [];
	if (model.reasoning) {
		caps.push("thinking");
	}
	if (model.input?.includes("image")) {
		caps.push("vision");
	}
	const suffix = caps.length ? ` ${chalk.dim(`[${caps.join(", ")}]`)}` : "";
	return `${model.id}${suffix}`;
}
