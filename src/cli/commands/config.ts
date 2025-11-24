import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
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

			console.log(`  ${heading} ${themedSeparator()} ${keyBadge}`);
			console.log(`     ${muted(provider.name)}`);
			console.log(`     ${muted(`Base URL: ${provider.baseUrl}`)}`);

			// Show models
			if (provider.models.length <= 3) {
				for (const model of provider.models) {
					console.log(muted(`       • ${model.id}`));
				}
			} else {
				console.log(muted(`       • ${provider.models[0].id}`));
				console.log(muted(`       • ${provider.models[1].id}`));
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

		const providerChoice = await rl.question(chalk.cyan("\nProvider (1-4): "));

		let providerId: string;
		let providerName: string;
		let baseUrl: string | undefined;
		let apiType: string;
		let defaultModel: string;

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
			default:
				console.log(chalk.red("\nInvalid choice. Defaulting to Anthropic."));
				providerId = "anthropic";
				providerName = "Anthropic";
				baseUrl = "https://api.anthropic.com";
				apiType = "anthropic-messages";
				defaultModel = "claude-sonnet-4-5";
		}

		// Step 2: API key method
		console.log(
			`\n${badge("2. How would you like to provide your API key?", undefined, "info")}`,
		);
		console.log("  1) Environment variable (recommended)");
		console.log("  2) Direct in config (not recommended)");

		const keyChoice = await rl.question(chalk.cyan("\nChoice (1-2): "));
		const useEnv = keyChoice.trim() !== "2";

		let apiKeyField: Record<string, string> = {};
		if (useEnv) {
			const envVarName = `${providerId.toUpperCase().replace(/-/g, "_")}_API_KEY`;
			apiKeyField = { apiKeyEnv: envVarName };
			console.log(chalk.dim(`\nUsing environment variable: ${envVarName}`));
		} else {
			const apiKey = await rl.question(chalk.cyan("\nEnter API key: "));
			apiKeyField = { apiKey: apiKey.trim() };
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

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
