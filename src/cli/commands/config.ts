import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { parse as parseJsonc } from "jsonc-parser";
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

/**
 * Handle `composer config validate` command
 */
export async function handleConfigValidate(): Promise<void> {
	console.log(sectionHeading("🔍 Validating Configuration"));

	const result: ConfigValidationResult = validateConfig();

	// Show config files
	if (result.summary.configFiles.length > 0) {
		console.log(muted("Config Files:"));
		for (const file of result.summary.configFiles) {
			const relPath = file.replace(homedir(), "~");
			console.log(muted(`  • ${relPath}`));
		}
		console.log();
	}

	// Show errors
	if (result.errors.length > 0) {
		console.log(badge("✗ Errors", undefined, "danger"));
		for (const error of result.errors) {
			console.log(chalk.red(`  • ${error}`));
		}
		console.log();
	}

	// Show warnings
	if (result.warnings.length > 0) {
		console.log(badge("⚠  Warnings", undefined, "warn"));
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
 * Handle `composer config show` command
 */
export async function handleConfigShow(): Promise<void> {
	console.log(sectionHeading("📋 Configuration Inspection"));

	const inspection: ConfigInspection = inspectConfig();

	// Show config sources
	console.log(badge("Config Sources", undefined, "info"));
	const hierarchy = getConfigHierarchy();
	for (const source of inspection.sources) {
		const relPath = source.path.replace(homedir(), "~");
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
			const heading = `${chalk.cyan(provider.id)} ${muted(
				`(${provider.modelCount} models)`,
			)}`;
			const keyBadge = provider.apiKeySource
				? badge("API key", provider.apiKeySource, "success")
				: badge("API key missing", undefined, "warn");
			const enabledBadge = provider.enabled
				? badge("enabled", undefined, "success")
				: badge("disabled", undefined, "warn");

			console.log(
				`  ${heading} ${themedSeparator()} ${keyBadge} ${themedSeparator()} ${enabledBadge}`,
			);
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
				console.log(muted(`       • ${formatModelLabel(provider.models[0])}`));
				console.log(muted(`       • ${formatModelLabel(provider.models[1])}`));
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
			const relPath = ref.path.replace(homedir(), "~");
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

	process.exit(0);
}

/**
 * Handle `composer config init` command
 */
export async function handleConfigInit(): Promise<void> {
	console.log(sectionHeading("🚀 Initialize Composer Configuration"));

	const readline = await import("node:readline/promises");
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		// Determine config location
		const configDir = join(process.cwd(), ".composer");
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

		// Step 1: Choose provider
		console.log(`\n${badge("1. Choose your provider", undefined, "info")}`);
		console.log("  1) Anthropic (Claude)");
		console.log("  2) OpenAI (GPT)");
		console.log("  3) AWS Bedrock");
		console.log("  4) Google Vertex AI");
		console.log("  5) LM Studio (local)");
		console.log("  6) Ollama (local)");

		const providerChoice = await rl.question(chalk.cyan("\nProvider (1-6): "));

		let providerId: string;
		let providerName: string;
		let baseUrl: string | undefined;
		let apiType: string;
		let defaultModel: string;
		let requiresApiKey = true;

		switch (providerChoice.trim()) {
			case "1":
				providerId = "anthropic";
				providerName = "Anthropic";
				baseUrl = "https://api.anthropic.com";
				apiType = "anthropic-messages";
				defaultModel = "claude-sonnet-4-5";
				break;
			case "2":
				providerId = "openai";
				providerName = "OpenAI";
				baseUrl = "https://api.openai.com/v1/chat/completions";
				apiType = "openai-responses";
				defaultModel = "gpt-4";
				break;
			case "3":
				providerId = "bedrock";
				providerName = "AWS Bedrock";
				// baseUrl will be auto-generated from AWS_REGION
				apiType = "anthropic-messages";
				defaultModel = "anthropic.claude-sonnet-4-5-v1:0";
				break;
			case "4":
				providerId = "vertex-ai";
				providerName = "Google Vertex AI";
				apiType = "anthropic-messages";
				defaultModel = "claude-sonnet-4-5@20250929";
				break;
			case "5":
				providerId = "lmstudio";
				providerName = "LM Studio (local)";
				baseUrl = "http://127.0.0.1:1234/v1";
				apiType = "openai-responses";
				defaultModel = "lmstudio/gemma-3n";
				requiresApiKey = false;
				break;
			case "6":
				providerId = "ollama";
				providerName = "Ollama (local)";
				baseUrl = "http://localhost:11434/v1";
				apiType = "openai-responses";
				defaultModel = "ollama/llama3.1";
				requiresApiKey = false;
				break;
			default:
				console.log(chalk.red("\nInvalid choice. Defaulting to Anthropic."));
				providerId = "anthropic";
				providerName = "Anthropic";
				baseUrl = "https://api.anthropic.com";
				apiType = "anthropic-messages";
				defaultModel = "claude-sonnet-4-5";
		}

		let useEnv = true;
		let apiKeyField: Record<string, string> = {};
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
				const envVarName = `${providerId
					.toUpperCase()
					.replace(/-/g, "_")}_API_KEY`;
				apiKeyField = { apiKeyEnv: envVarName };
				console.log(chalk.dim(`\nUsing environment variable: ${envVarName}`));
			} else {
				const apiKey = await rl.question(chalk.cyan("\nEnter API key: "));
				apiKeyField = { apiKey: apiKey.trim() };
			}
		} else {
			useEnv = false;
			console.log(
				chalk.dim("\nLocal providers do not require API keys. Skipping step."),
			);
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
		const config: any = {
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
							contextWindow: 200000,
							maxTokens: 8192,
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
			const envVarName = (apiKeyField as any).apiKeyEnv;
			const envContent = existsSync(envExamplePath)
				? `\n# Added by composer init\n${envVarName}=your-api-key-here\n`
				: `# Composer Configuration\n${envVarName}=your-api-key-here\n`;

			if (existsSync(envExamplePath)) {
				const fs = await import("node:fs/promises");
				await fs.appendFile(envExamplePath, envContent);
			} else {
				writeFileSync(envExamplePath, envContent);
			}
			console.log(badge("Updated .env.example", undefined, "success"));
		}

		// Show next steps
		console.log(sectionHeading("🎉 Configuration initialized!"));
		console.log(muted("Next steps:"));

		if (useEnv) {
			const envVarName = (apiKeyField as any).apiKeyEnv;
			console.log(muted(`  1. Set ${envVarName} in your environment`));
		}
		if (createPrompts) {
			console.log(muted("  2. Edit .composer/prompts/system.md"));
		}
		console.log(muted("  3. Run: composer models list"));
		console.log(muted('  4. Start using: composer "your prompt"\n'));

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
		baseUrl: string;
		models: Array<{
			id: string;
			name: string;
			contextWindow: number;
			maxTokens: number;
			input?: Array<"text" | "image">;
		}>;
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
	console.log(sectionHeading("🖥️ Local provider helper"));
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
			const targets = [
				{ name: "LM Studio", url: LOCAL_PROVIDER_TEMPLATES.lmstudio.baseUrl },
				{ name: "Ollama", url: LOCAL_PROVIDER_TEMPLATES.ollama.baseUrl },
			];
			for (const target of targets) {
				console.log(await checkLocalEndpoint(target.name, target.url));
			}
			rl.close();
			return;
		}

		const templateKey = choice === "2" ? "ollama" : "lmstudio";
		const template = LOCAL_PROVIDER_TEMPLATES[templateKey];

		const scope = (
			await rl.question(
				chalk.cyan(
					"\nSave provider to:\n  1) Project (.composer/local.json)\n  2) Home (~/.composer/local.json)\n\nChoice (1-2): ",
				),
			)
		).trim();
		const targetDir =
			scope === "2"
				? join(homedir(), ".composer")
				: join(process.cwd(), ".composer");
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
			muted("Tip: run `composer config local` again to check connectivity."),
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
