import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import {
	ActionApprovalService,
	type ApprovalMode,
} from "./agent/action-approval.js";
import { Agent, ProviderTransport, type ThinkingLevel } from "./agent/index.js";
import { type Args, type Mode, parseArgs } from "./cli/args.js";
import { printHelp } from "./cli/help.js";
import { selectSession } from "./cli/session.js";
import {
	buildSystemPrompt,
	loadProjectContextFiles,
} from "./cli/system-prompt.js";
import { loadEnv } from "./load-env.js";
import { bootstrapLsp } from "./lsp/bootstrap.js";
import {
	getCustomConfigPath,
	getCustomProviderMetadata,
	getFactoryDefaultModelSelection,
	getRegisteredModels,
	getSupportedProviders,
	reloadModelConfig,
	resolveAlias,
	resolveModel,
} from "./models/registry.js";
import type { RegisteredModel } from "./models/registry.js";
import {
	getEnvVarsForProvider,
	isKnownProvider,
	lookupApiKey,
} from "./providers/api-keys.js";
import { configureSafeMode } from "./safety/safe-mode.js";
import { SessionManager, toSessionModelMetadata } from "./session-manager.js";
import { codingTools } from "./tools/index.js";
import { PromptQueue } from "./tui/prompt-queue.js";
import { TuiRenderer } from "./tui/tui-renderer.js";

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
	readFileSync(join(__dirname, "../package.json"), "utf-8"),
);
const VERSION = packageJson.version;

async function runInteractiveMode(
	agent: Agent,
	sessionManager: SessionManager,
	version: string,
	approvalService: ActionApprovalService,
	explicitApiKey?: string,
): Promise<void> {
	const renderer = new TuiRenderer(
		agent,
		sessionManager,
		version,
		approvalService,
		explicitApiKey,
	);
	const promptQueue = new PromptQueue(
		async (text) => {
			await agent.prompt(text);
		},
		(error) => {
			renderer.showError(
				error instanceof Error ? error.message : "Unknown error occurred",
			);
		},
	);
	renderer.attachPromptQueue(promptQueue);

	// Initialize TUI
	await renderer.init();

	// Set interrupt callback
	renderer.setInterruptCallback(() => {
		agent.abort();
	});

	// Render any existing messages (from --continue mode)
	renderer.renderInitialMessages(agent.state);

	// Subscribe to agent events
	agent.subscribe(async (event) => {
		// Pass all events to the renderer
		await renderer.handleEvent(event, agent.state);
	});

	// Interactive loop
	while (true) {
		const userInput = await renderer.getUserInput();
		promptQueue.enqueue(userInput);
	}
}

async function runSingleShotMode(
	agent: Agent,
	_sessionManager: SessionManager,
	messages: string[],
	mode: Extract<Mode, "text" | "json">,
): Promise<void> {
	if (mode === "json") {
		// Subscribe to all events and output as JSON
		agent.subscribe((event) => {
			// Output event as JSON (same format as session manager)
			console.log(JSON.stringify(event));
		});
	}

	for (const message of messages) {
		await agent.prompt(message);
	}

	// In text mode, only output the final assistant message
	if (mode === "text") {
		const lastMessage = agent.state.messages[agent.state.messages.length - 1];
		if (lastMessage.role === "assistant") {
			for (const content of lastMessage.content) {
				if (content.type === "text") {
					console.log(content.text);
				}
			}
		}
	}
}

async function runRpcMode(
	agent: Agent,
	_sessionManager: SessionManager,
): Promise<void> {
	// Subscribe to all events and output as JSON
	agent.subscribe((event) => {
		console.log(JSON.stringify(event));
	});

	// Listen for JSON input on stdin
	const readline = await import("node:readline");
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: false,
	});

	rl.on("line", async (line: string) => {
		try {
			const input = JSON.parse(line);

			// Handle different RPC commands
			if (input.type === "prompt" && input.message) {
				await agent.prompt(input.message);
			} else if (input.type === "abort") {
				agent.abort();
			}
		} catch (error: unknown) {
			// Output error as JSON
			const message = error instanceof Error ? error.message : String(error);
			console.log(JSON.stringify({ type: "error", error: message }));
		}
	});

	// Keep process alive
	return new Promise(() => {});
}

export async function main(args: string[]) {
	loadEnv();

	const parsed = parseArgs(args);

	if (parsed.safeMode) {
		process.env.COMPOSER_SAFE_MODE = "1";
	}

	if (parsed.modelsFile) {
		process.env.COMPOSER_MODELS_FILE = parsed.modelsFile;
		reloadModelConfig();
	}

	configureSafeMode(true);

	// Bootstrap LSP with workspace root resolver and config overrides
	await bootstrapLsp();

	if (parsed.help) {
		printHelp(VERSION);
		return;
	}

	// Handle config commands
	if (parsed.command === "config") {
		const {
			handleConfigValidate,
			handleConfigShow,
			handleConfigInit,
			handleConfigLocal,
		} = await import("./cli/commands/config.js");

		switch (parsed.subcommand) {
			case "validate":
				await handleConfigValidate();
				return;
			case "show":
				await handleConfigShow();
				return;
			case "init":
				await handleConfigInit();
				return;
			case "local":
				await handleConfigLocal();
				return;
			default:
				console.error(
					chalk.red(
						`Unknown config subcommand: ${parsed.subcommand || "(none)"}`,
					),
				);
				console.log(chalk.dim("\nAvailable commands:"));
				console.log(
					chalk.dim("  composer config validate  - Validate configuration"),
				);
				console.log(
					chalk.dim("  composer config show      - Show configuration details"),
				);
				console.log(
					chalk.dim("  composer config init      - Initialize configuration"),
				);
				console.log(
					chalk.dim("  composer config local     - Manage local providers"),
				);
				process.exit(1);
		}
	}

	// Handle cost commands
	if (parsed.command === "cost") {
		const { handleCostSummary, handleCostClear, handleCostBreakdown } =
			await import("./cli/commands/cost.js");

		switch (parsed.subcommand) {
			case "clear":
				await handleCostClear();
				return;
			case "breakdown":
				await handleCostBreakdown();
				return;
			case "today":
			case "yesterday":
			case "week":
			case "month":
			case "all":
				await handleCostSummary(parsed.subcommand);
				return;
			case undefined:
				// Default to today
				await handleCostSummary("today");
				return;
			default:
				console.error(
					chalk.red(`Unknown cost subcommand: ${parsed.subcommand}`),
				);
				console.log(chalk.dim("\nAvailable commands:"));
				console.log(
					chalk.dim(
						"  composer cost [today]     - Show today's costs (default)",
					),
				);
				console.log(
					chalk.dim("  composer cost yesterday   - Show yesterday's costs"),
				);
				console.log(
					chalk.dim("  composer cost week        - Show last 7 days"),
				);
				console.log(
					chalk.dim("  composer cost month       - Show last 30 days"),
				);
				console.log(
					chalk.dim("  composer cost all         - Show all time costs"),
				);
				console.log(
					chalk.dim("  composer cost breakdown   - Detailed breakdown"),
				);
				console.log(
					chalk.dim("  composer cost clear       - Clear usage data"),
				);
				process.exit(1);
		}
	}

	// Handle models commands
	if (parsed.command === "models") {
		const { handleModelsList, handleModelsProviders } = await import(
			"./cli/commands/models.js"
		);
		const providerFilter = parsed.provider;
		switch (parsed.subcommand) {
			case "providers":
				await handleModelsProviders(providerFilter);
				return;
			case undefined:
			case "list":
				await handleModelsList(providerFilter);
				return;
			default:
				console.error(
					chalk.red(
						`Unknown models subcommand: ${parsed.subcommand || "(none)"}`,
					),
				);
				console.log(chalk.dim("\nAvailable commands:"));
				console.log(
					chalk.dim(
						"  composer models list             - List registered models",
					),
				);
				console.log(
					chalk.dim("  composer models providers        - Summarize providers"),
				);
				process.exit(1);
		}
	}

	// Setup session manager
	const sessionManager = new SessionManager(
		parsed.continue && !parsed.resume,
		parsed.session,
	);

	// Disable session saving if --no-session flag is set
	if (parsed.noSession) {
		sessionManager.disable();
	}

	// Handle --resume flag: show session selector
	if (parsed.resume) {
		const selectedSession = await selectSession(sessionManager);
		if (!selectedSession) {
			console.log(chalk.dim("No session selected"));
			return;
		}
		// Set the selected session as the active session
		sessionManager.setSessionFile(selectedSession);
	}

	// Determine provider and model
	let provider = parsed.provider;
	let modelId = parsed.model;

	// Check if model is an alias
	if (modelId && !provider) {
		const resolved = resolveAlias(modelId);
		if (resolved) {
			provider = resolved.provider;
			modelId = resolved.modelId;
			console.log(
				chalk.dim(`Using alias: ${parsed.model} → ${provider}/${modelId}`),
			);
		}
	}

	if (!provider || !modelId) {
		const factoryDefault = getFactoryDefaultModelSelection();
		if (factoryDefault) {
			if (!provider) {
				provider = factoryDefault.provider;
			}
			if (!modelId) {
				modelId = factoryDefault.modelId;
			}
		}
	}

	provider ??= "anthropic";
	modelId ??= "claude-sonnet-4-5";

	const supportedProviders = new Set(getSupportedProviders());
	if (!supportedProviders.has(provider)) {
		console.error(
			chalk.red(
				`Unknown provider "${provider}". Supported providers: ${Array.from(
					supportedProviders,
				)
					.sort()
					.join(", ")}`,
			),
		);
		process.exit(1);
	}
	// Helper function to get API key for a provider
	const getApiKeyForProvider = (providerName: string): string | undefined => {
		const result = lookupApiKey(providerName, parsed.apiKey);
		return result.key;
	};

	// Get initial API key
	const initialApiKey = getApiKeyForProvider(provider);
	if (!initialApiKey) {
		console.error(
			chalk.red(`Error: No API key found for provider "${provider}"`),
		);
		const envVars = getEnvVarsForProvider(provider);
		if (envVars.length) {
			const envVarList = envVars.join(" or ");
			console.error(
				chalk.dim(
					`Set ${envVarList} environment variable or use --api-key flag`,
				),
			);
		} else {
			const customMeta = getCustomProviderMetadata(provider);
			if (customMeta?.apiKeyEnv) {
				console.error(
					chalk.dim(
						`Set ${customMeta.apiKeyEnv} environment variable or provide --api-key for ${provider}`,
					),
				);
			}
		}
		process.exit(1);
	}

	// Create agent
	const model = resolveModel(provider, modelId);
	if (!model) {
		console.error(
			chalk.red(
				`Unknown model "${provider}/${modelId}". Check your models config.`,
			),
		);
		process.exit(1);
	}
	const systemPrompt = buildSystemPrompt(parsed.systemPrompt);

	const isInteractiveTui =
		parsed.messages.length === 0 && (parsed.mode ?? "text") !== "rpc";
	const defaultApprovalMode: ApprovalMode = isInteractiveTui
		? "prompt"
		: "auto";
	const approvalService = new ActionApprovalService(
		parsed.approvalMode ?? defaultApprovalMode,
	);

	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "off",
			tools: codingTools,
		},
		transport: new ProviderTransport({
			// Dynamic API key lookup based on current model's provider
			getApiKey: async () => {
				const currentProvider = agent.state.model.provider;
				const key = getApiKeyForProvider(currentProvider);
				if (!key) {
					throw new Error(
						`No API key found for provider "${currentProvider}". Please set the appropriate environment variable.`,
					);
				}
				return key;
			},
			approvalService,
		}),
	});

	// Determine mode early to know if we should print messages
	const isInteractive = parsed.messages.length === 0;
	const mode = parsed.mode || "text";
	const shouldPrintMessages = isInteractive || mode === "text";

	// Load previous messages if continuing or resuming
	if (parsed.continue || parsed.resume) {
		const messages = sessionManager.loadMessages();
		if (messages.length > 0) {
			if (shouldPrintMessages) {
				console.log(
					chalk.dim(`Loaded ${messages.length} messages from previous session`),
				);
			}
			agent.replaceMessages(messages);
		}

		// Load and restore model
		const savedModel = sessionManager.loadModel();
		if (savedModel) {
			// Parse provider/modelId from saved model string (format: "provider/modelId")
			const [savedProvider, savedModelId] = savedModel.split("/");
			if (savedProvider && savedModelId && isKnownProvider(savedProvider)) {
				try {
					const restoredModel = resolveModel(savedProvider, savedModelId);
					if (restoredModel) {
						agent.setModel(restoredModel);
					}
					if (shouldPrintMessages) {
						console.log(chalk.dim(`Restored model: ${savedModel}`));
					}
				} catch (error: unknown) {
					if (shouldPrintMessages) {
						const message =
							error instanceof Error ? error.message : String(error);
						console.error(
							chalk.yellow(
								`Warning: Could not restore model ${savedModel}: ${message}`,
							),
						);
					}
				}
			} else if (shouldPrintMessages) {
				console.error(
					chalk.yellow(
						`Warning: Could not restore model ${savedModel}: unknown provider`,
					),
				);
			}
		}

		// Load and restore thinking level
		const thinkingLevel = sessionManager.loadThinkingLevel() as ThinkingLevel;
		if (thinkingLevel) {
			agent.setThinkingLevel(thinkingLevel);
			if (shouldPrintMessages) {
				console.log(chalk.dim(`Restored thinking level: ${thinkingLevel}`));
			}
		}
	}

	// Note: Session will be started lazily after first user+assistant message exchange
	// (unless continuing/resuming, in which case it's already initialized)

	// Log loaded context files (they're already in the system prompt)
	if (shouldPrintMessages && !parsed.continue && !parsed.resume) {
		const contextFiles = loadProjectContextFiles();
		if (contextFiles.length > 0) {
			console.log(chalk.dim("Loaded project context from:"));
			for (const { path: filePath } of contextFiles) {
				console.log(chalk.dim(`  - ${filePath}`));
			}
		}
	}

	// Subscribe to agent events to save messages
	agent.subscribe((event) => {
		// Save messages on completion
		if (event.type === "message_end") {
			sessionManager.saveMessage(event.message);

			// Check if we should initialize session now (after first user+assistant exchange)
			if (sessionManager.shouldInitializeSession(agent.state.messages)) {
				sessionManager.startSession(agent.state);
			}
		}

		const modelMetadata = toSessionModelMetadata(
			agent.state.model as RegisteredModel,
		);
		sessionManager.updateSnapshot(agent.state, modelMetadata);
	});

	// Route to appropriate mode
	if (mode === "rpc") {
		// RPC mode - headless operation
		await runRpcMode(agent, sessionManager);
	} else if (isInteractive) {
		// No messages and not RPC - use TUI
		await runInteractiveMode(
			agent,
			sessionManager,
			VERSION,
			approvalService,
			parsed.apiKey,
		);
	} else {
		// CLI mode with messages
		await runSingleShotMode(agent, sessionManager, parsed.messages, mode);
	}
}
