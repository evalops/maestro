import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Agent,
	ProviderTransport,
	type ThinkingLevel,
} from "@mariozechner/pi-agent";
import {
	type Api,
	type KnownProvider,
	type Model,
	getModel,
} from "@mariozechner/pi-ai";
import chalk from "chalk";
import { type Args, type Mode, parseArgs } from "./cli/args.js";
import { printHelp } from "./cli/help.js";
import { selectSession } from "./cli/session.js";
import {
	buildSystemPrompt,
	loadProjectContextFiles,
} from "./cli/system-prompt.js";
import { loadEnv } from "./load-env.js";
import { SessionManager } from "./session-manager.js";
import { codingTools } from "./tools/index.js";
import { TuiRenderer } from "./tui/tui-renderer.js";

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
	readFileSync(join(__dirname, "../package.json"), "utf-8"),
);
const VERSION = packageJson.version;

const envApiKeyMap: Record<KnownProvider, string[]> = {
	google: ["GEMINI_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
	xai: ["XAI_API_KEY"],
	groq: ["GROQ_API_KEY"],
	cerebras: ["CEREBRAS_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	zai: ["ZAI_API_KEY"],
};

function isKnownProvider(value: string): value is KnownProvider {
	return value in envApiKeyMap;
}

const resolveModel = (provider: KnownProvider, modelId: string): Model<Api> =>
	getModel(provider, modelId as never) as Model<Api>;

async function runInteractiveMode(
	agent: Agent,
	sessionManager: SessionManager,
	version: string,
): Promise<void> {
	const renderer = new TuiRenderer(agent, sessionManager, version);

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

		// Process the message - agent.prompt will add user message and trigger state updates
		try {
			await agent.prompt(userInput);
		} catch (error: unknown) {
			// Display error in the TUI by adding an error message to the chat
			renderer.showError(
				error instanceof Error ? error.message : "Unknown error occurred",
			);
		}
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

	if (parsed.help) {
		printHelp(VERSION);
		return;
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
	const provider: KnownProvider =
		parsed.provider && isKnownProvider(parsed.provider)
			? parsed.provider
			: "anthropic";
	const modelId = parsed.model || "claude-sonnet-4-5";

	// Helper function to get API key for a provider
	const getApiKeyForProvider = (providerName: string): string | undefined => {
		// Check if API key was provided via command line
		if (parsed.apiKey) {
			return parsed.apiKey;
		}

		const envVars = envApiKeyMap[providerName as KnownProvider];

		// Check each environment variable in priority order
		for (const envVar of envVars) {
			const key = process.env[envVar];
			if (key) {
				return key;
			}
		}

		return undefined;
	};

	// Get initial API key
	const initialApiKey = getApiKeyForProvider(provider);
	if (!initialApiKey) {
		const envVars = envApiKeyMap[provider];
		const envVarList = envVars.join(" or ");
		console.error(
			chalk.red(`Error: No API key found for provider "${provider}"`),
		);
		console.error(
			chalk.dim(`Set ${envVarList} environment variable or use --api-key flag`),
		);
		process.exit(1);
	}

	// Create agent
	const model = resolveModel(provider, modelId);
	const systemPrompt = buildSystemPrompt(parsed.systemPrompt);

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
					agent.setModel(restoredModel);
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
	});

	// Route to appropriate mode
	if (mode === "rpc") {
		// RPC mode - headless operation
		await runRpcMode(agent, sessionManager);
	} else if (isInteractive) {
		// No messages and not RPC - use TUI
		await runInteractiveMode(agent, sessionManager, VERSION);
	} else {
		// CLI mode with messages
		await runSingleShotMode(agent, sessionManager, parsed.messages, mode);
	}
}
