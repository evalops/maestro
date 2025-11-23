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

/**
 * Handle `composer config validate` command
 */
export async function handleConfigValidate(): Promise<void> {
	console.log(chalk.bold("\n🔍 Validating Configuration\n"));

	const result: ConfigValidationResult = validateConfig();

	// Show config files
	if (result.summary.configFiles.length > 0) {
		console.log(chalk.dim("Config Files:"));
		for (const file of result.summary.configFiles) {
			const relPath = file.replace(homedir(), "~");
			console.log(chalk.dim(`  • ${relPath}`));
		}
		console.log();
	}

	// Show errors
	if (result.errors.length > 0) {
		console.log(chalk.red("✗ Errors:"));
		for (const error of result.errors) {
			console.log(chalk.red(`  • ${error}`));
		}
		console.log();
	}

	// Show warnings
	if (result.warnings.length > 0) {
		console.log(chalk.yellow("⚠  Warnings:"));
		for (const warning of result.warnings) {
			console.log(chalk.yellow(`  • ${warning}`));
		}
		console.log();
	}

	// Show summary
	console.log(chalk.dim("Summary:"));
	console.log(chalk.dim(`  • Providers: ${result.summary.providers}`));
	console.log(chalk.dim(`  • Models: ${result.summary.models}`));
	console.log(
		chalk.dim(`  • File References: ${result.summary.fileReferences.length}`),
	);
	console.log(
		chalk.dim(`  • Environment Variables: ${result.summary.envVars.length}`),
	);
	console.log();

	// Final verdict
	if (result.valid) {
		console.log(chalk.green("✓ Configuration is valid\n"));
		process.exit(0);
	} else {
		console.log(chalk.red("✗ Configuration has errors\n"));
		process.exit(1);
	}
}

/**
 * Handle `composer config show` command
 */
export async function handleConfigShow(): Promise<void> {
	console.log(chalk.bold("\n📋 Configuration Inspection\n"));

	const inspection: ConfigInspection = inspectConfig();

	// Show config sources
	console.log(chalk.bold("Config Sources:"));
	const hierarchy = getConfigHierarchy();
	for (const source of inspection.sources) {
		const relPath = source.path.replace(homedir(), "~");
		const status = source.exists ? chalk.green("✓") : chalk.dim("(not found)");
		const mark = hierarchy.includes(source.path) ? "•" : " ";
		console.log(`  ${mark} ${status} ${chalk.dim(relPath)}`);
	}
	console.log();

	// Show providers
	if (inspection.providers.length > 0) {
		console.log(chalk.bold(`Providers (${inspection.providers.length}):`));
		for (const provider of inspection.providers) {
			const statusMark = provider.apiKeySource
				? chalk.green("✓")
				: chalk.yellow("⚠");

			console.log(
				`  ${statusMark} ${chalk.cyan(provider.id)} (${provider.modelCount} models)`,
			);
			console.log(chalk.dim(`     ${provider.name}`));
			console.log(chalk.dim(`     Base URL: ${provider.baseUrl}`));

			if (provider.apiKeySource) {
				console.log(chalk.dim(`     API Key: ${provider.apiKeySource}`));
			} else {
				console.log(chalk.yellow("     API Key: not configured"));
			}

			// Show models
			if (provider.models.length <= 3) {
				for (const model of provider.models) {
					console.log(chalk.dim(`       • ${model.id}`));
				}
			} else {
				console.log(chalk.dim(`       • ${provider.models[0].id}`));
				console.log(chalk.dim(`       • ${provider.models[1].id}`));
				console.log(
					chalk.dim(`       ... and ${provider.models.length - 2} more`),
				);
			}
			console.log();
		}
	} else {
		console.log(chalk.yellow("No providers configured\n"));
	}

	// Show file references
	if (inspection.fileReferences.length > 0) {
		console.log(
			chalk.bold(`File References (${inspection.fileReferences.length}):`),
		);
		for (const ref of inspection.fileReferences) {
			const relPath = ref.path.replace(homedir(), "~");
			const status = ref.exists ? chalk.green("✓") : chalk.red("✗");
			const size = ref.size ? ` (${formatBytes(ref.size)})` : "";
			console.log(`  ${status} ${chalk.dim(relPath)}${chalk.dim(size)}`);
		}
		console.log();
	}

	// Show environment variables
	if (inspection.envVars.length > 0) {
		console.log(
			chalk.bold(`Environment Variables (${inspection.envVars.length}):`),
		);
		for (const envVar of inspection.envVars) {
			const status = envVar.set ? chalk.green("✓") : chalk.red("✗");
			const value = envVar.maskedValue || chalk.dim("(not set)");
			console.log(
				`  ${status} ${chalk.cyan(envVar.name)}: ${chalk.dim(value)}`,
			);
		}
		console.log();
	}

	process.exit(0);
}

/**
 * Handle `composer config init` command
 */
export async function handleConfigInit(): Promise<void> {
	console.log(chalk.bold("\n🚀 Initialize Composer Configuration\n"));

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
				console.log(chalk.dim("\nCancelled."));
				rl.close();
				return;
			}
		}

		// Step 1: Choose provider
		console.log(chalk.bold("\n1. Choose your provider:"));
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
		console.log(chalk.bold("\n2. How would you like to provide your API key?"));
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
			chalk.bold("\n3. Would you like to use file references for prompts?"),
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
		console.log(chalk.green(`\n✓ Created ${configPath}`));

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
			console.log(chalk.green(`✓ Created ${systemPromptPath}`));
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
			console.log(chalk.green("✓ Updated .env.example"));
		}

		// Show next steps
		console.log(chalk.bold("\n🎉 Configuration initialized!\n"));
		console.log(chalk.dim("Next steps:"));

		if (useEnv) {
			const envVarName = (apiKeyField as any).apiKeyEnv;
			console.log(chalk.dim(`  1. Set ${envVarName} in your environment`));
		}
		if (createPrompts) {
			console.log(chalk.dim("  2. Edit .composer/prompts/system.md"));
		}
		console.log(chalk.dim("  3. Run: composer models list"));
		console.log(chalk.dim('  4. Start using: composer "your prompt"\n'));

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
