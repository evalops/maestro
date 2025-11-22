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
import {
	EXEC_SESSION_SUMMARY_PREFIX,
	runExecCommand,
} from "./cli/commands/exec.js";
import { printHelp } from "./cli/help.js";
import {
	JsonlEventWriter,
	createAgentJsonlAdapter,
	emitThreadEnd,
	emitThreadStart,
	emitUserTurn as emitUserTurnEvent,
} from "./cli/jsonl-writer.js";
import { selectSession } from "./cli/session.js";
import {
	buildSystemPrompt,
	loadProjectContextFiles,
} from "./cli/system-prompt.js";
import { loadEnv } from "./load-env.js";
import { bootstrapLsp } from "./lsp/bootstrap.js";
import type { RegisteredModel } from "./models/registry.js";
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
import { resolveModelScope } from "./models/scope.js";
import {
	getEnvVarsForProvider,
	isKnownProvider,
} from "./providers/api-keys.js";
import {
	type AuthCredential,
	type AuthMode,
	createAuthResolver,
} from "./providers/auth.js";
import { AgentRuntimeController } from "./runtime/agent-runtime.js";
import { configureSafeMode } from "./safety/safe-mode.js";
import { SessionManager, toSessionModelMetadata } from "./session/manager.js";
import { codingTools } from "./tools/index.js";
import { TuiRenderer } from "./tui/tui-renderer.js";
import {
	formatChangelogVersion,
	getChangelogPath,
	getLatestEntry,
	getNewEntries,
	isChangelogHiddenFromEnv,
	parseChangelog,
	readLastShownChangelogVersion,
	summarizeChangelogEntry,
	writeLastShownChangelogVersion,
} from "./update/changelog.js";
import { type UpdateCheckResult, checkForUpdate } from "./update/check.js";

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
	readFileSync(join(__dirname, "../package.json"), "utf-8"),
);
const VERSION = packageJson.version;

interface InteractiveOptions {
	modelScope?: RegisteredModel[];
	startupChangelogSummary?: string | null;
	updateNotice?: UpdateCheckResult | null;
}

async function runInteractiveMode(
	agent: Agent,
	sessionManager: SessionManager,
	version: string,
	approvalService: ActionApprovalService,
	explicitApiKey?: string,
	options: InteractiveOptions = {},
): Promise<void> {
	const renderer = new TuiRenderer(
		agent,
		sessionManager,
		version,
		approvalService,
		explicitApiKey,
		options,
	);
	const runtime = new AgentRuntimeController({
		agent,
		renderer,
		onError: (error) => {
			const message =
				error instanceof Error ? error.message : "Unknown error occurred";
			renderer.showError(message);
		},
	});

	// Initialize TUI
	await renderer.init();

	// Render any existing messages (from --continue mode)
	renderer.renderInitialMessages(agent.state);

	// Subscribe to agent events
	agent.subscribe(async (event) => {
		// Pass all events to the renderer
		await renderer.handleEvent(event, agent.state);
	});

	await runtime.runInteractiveLoop(renderer);
}

async function runSingleShotMode(
	agent: Agent,
	sessionManager: SessionManager,
	messages: string[],
	mode: Extract<Mode, "text" | "json">,
): Promise<void> {
	const threadId = sessionManager.getSessionId();
	const jsonlWriter =
		mode === "json" ? new JsonlEventWriter(true, process.stdout) : null;
	const nextTurnId = (() => {
		let counter = 0;
		return () => `turn-${++counter}`;
	})();
	const adapter =
		jsonlWriter && createAgentJsonlAdapter(jsonlWriter, nextTurnId);

	if (jsonlWriter) {
		emitThreadStart(jsonlWriter, threadId, { sessionId: threadId });
		agent.subscribe((event) => {
			adapter?.handle(event);
		});
	}

	try {
		for (const message of messages) {
			if (jsonlWriter) {
				emitUserTurnEvent(jsonlWriter, nextTurnId, message);
			}
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

		if (jsonlWriter) {
			emitThreadEnd(jsonlWriter, threadId, "ok", threadId);
		}
	} catch (error) {
		if (jsonlWriter) {
			emitThreadEnd(jsonlWriter, threadId, "error", threadId);
		}
		throw error;
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

	const authMode: AuthMode = parsed.authMode ?? "auto";
	const codexCliToken = parsed.codexApiKey;
	const codexEnvToken = process.env.CODEX_API_KEY;
	const effectiveCodexToken = codexCliToken ?? codexEnvToken;
	const authResolver = createAuthResolver({
		mode: authMode,
		explicitApiKey: parsed.apiKey,
		codexApiKey: effectiveCodexToken,
		codexSource: codexCliToken ? "flag" : codexEnvToken ? "env" : undefined,
	});

	type AuthLine = { plain: string; colored: string };
	const buildMissingAuthLines = (providerName: string): AuthLine[] => {
		const lines: AuthLine[] = [];
		const push = (plain: string, colored?: string) => {
			lines.push({ plain, colored: colored ?? plain });
		};
		push(
			`Error: No credentials found for provider "${providerName}"`,
			chalk.red(`Error: No credentials found for provider "${providerName}"`),
		);
		if (authMode !== "api-key") {
			push(
				'Set CODEX_API_KEY/CODEX token (chatgpt) or run "composer anthropic login" (claude) before retrying.',
				chalk.dim(
					'Set CODEX_API_KEY/CODEX token (chatgpt) or run "composer anthropic login" (claude) before retrying.',
				),
			);
		}
		const envVars = getEnvVarsForProvider(providerName);
		if (envVars.length) {
			push(
				`Set ${envVars.join(" or ")} or provide --api-key for ${providerName}.`,
				chalk.dim(
					`Set ${envVars.join(" or ")} or provide --api-key for ${providerName}.`,
				),
			);
		} else {
			const customMeta = getCustomProviderMetadata(providerName);
			if (customMeta?.apiKeyEnv) {
				push(
					`Set ${customMeta.apiKeyEnv} environment variable or provide --api-key for ${providerName}.`,
					chalk.dim(
						`Set ${customMeta.apiKeyEnv} environment variable or provide --api-key for ${providerName}.`,
					),
				);
			}
		}
		return lines;
	};

	const requireCredential = async (
		providerName: string,
		fatal: boolean,
	): Promise<AuthCredential> => {
		const credential = await authResolver(providerName);
		if (credential) {
			return credential;
		}
		const lines = buildMissingAuthLines(providerName);
		if (fatal) {
			for (const line of lines) {
				console.error(line.colored);
			}
			process.exit(1);
		}
		const plain = lines.map((line) => line.plain).join("\n");
		throw new Error(plain);
	};

	if (parsed.command === "exec") {
		if (parsed.execFullAuto && parsed.execReadOnly) {
			console.error(
				chalk.red(
					"Cannot combine --full-auto with --read-only in composer exec.",
				),
			);
			process.exit(1);
		}
		if (
			parsed.execSandbox &&
			parsed.execSandbox !== "danger-full-access" &&
			parsed.execSandbox !== "default"
		) {
			console.error(
				chalk.red(
					`Unknown sandbox mode "${parsed.execSandbox}". Supported: default, danger-full-access`,
				),
			);
			process.exit(1);
		}
	}

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

	if (parsed.command === "openai") {
		const { handleOpenAICommand } = await import("./cli/commands/openai.js");
		await handleOpenAICommand(parsed.subcommand, parsed.messages);
		return;
	}

	if (parsed.command === "anthropic") {
		const { handleAnthropicCommand } = await import(
			"./cli/commands/anthropic.js"
		);
		await handleAnthropicCommand(parsed.subcommand, parsed.messages);
		return;
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

	let agentsInitPrompt: string | null = null;
	let agentsInitPath: string | null = null;

	if (parsed.command === "agents") {
		const { buildAgentsInitPrompt, handleAgentsInit } = await import(
			"./cli/commands/agents.js"
		);
		if (parsed.subcommand && parsed.subcommand !== "init") {
			console.error(
				chalk.red(
					`Unknown agents subcommand: ${parsed.subcommand}. Try "composer agents init"`,
				),
			);
			process.exit(1);
		}
		try {
			const targetArg = parsed.messages[0];
			const filePath = handleAgentsInit(targetArg, { force: parsed.force });
			agentsInitPath = filePath;
			agentsInitPrompt = buildAgentsInitPrompt(filePath);
			if (parsed.messages.length === 0) {
				parsed.messages = [agentsInitPrompt];
			}
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Failed to initialize AGENTS.md";
			console.error(chalk.red(message));
			process.exit(1);
		}
	}

	// Setup session manager
	const sessionManager = new SessionManager(
		parsed.continue && !parsed.resume,
		parsed.session,
	);

	let execResumeApplied = false;
	if (parsed.command === "exec") {
		let targetPath: string | null = null;
		if (parsed.execResumeId) {
			targetPath = sessionManager.getSessionFileById(parsed.execResumeId);
			if (!targetPath) {
				console.error(
					chalk.red(`No session found with id ${parsed.execResumeId}.`),
				);
				process.exit(1);
			}
		} else if (parsed.execUseLast) {
			const sessions = sessionManager.loadAllSessions();
			const lastExec = sessions.find((session) =>
				session.summary?.startsWith(EXEC_SESSION_SUMMARY_PREFIX),
			);
			if (!lastExec) {
				console.error(
					chalk.red("No previous composer exec sessions were found."),
				);
				process.exit(1);
			}
			targetPath = lastExec.path;
		}
		if (targetPath) {
			sessionManager.setSessionFile(targetPath);
			execResumeApplied = true;
		}
	}

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
	await requireCredential(provider, true);

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
	const approvalModeOverride = (() => {
		if (parsed.command === "exec") {
			if (parsed.execReadOnly) return "fail";
			if (parsed.execFullAuto) return "auto";
		}
		return parsed.approvalMode ?? defaultApprovalMode;
	})();
	const approvalService = new ActionApprovalService(approvalModeOverride);

	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "off",
			tools: codingTools,
		},
		transport: new ProviderTransport({
			getAuthContext: (providerName) => requireCredential(providerName, false),
			approvalService,
		}),
	});

	// Determine mode early to know if we should print messages
	const isInteractive = parsed.messages.length === 0;
	const mode = parsed.mode || "text";
	const shouldPrintMessages = isInteractive || mode === "text";

	let scopedModels: RegisteredModel[] = [];
	if (parsed.models && parsed.models.length > 0) {
		scopedModels = resolveModelScope(parsed.models);
		if (scopedModels.length === 0 && shouldPrintMessages) {
			console.log(
				chalk.yellow(
					`Warning: --models patterns (${parsed.models.join(", ")}) did not match any registered models`,
				),
			);
		}
	}

	// Load previous messages if continuing or resuming
	const shouldRestoreSession =
		parsed.continue || parsed.resume || execResumeApplied;
	if (shouldRestoreSession) {
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
	const isFreshInteractiveSession =
		isInteractive && !shouldRestoreSession && mode !== "rpc";

	if (shouldPrintMessages && !parsed.continue && !parsed.resume) {
		const contextFiles = loadProjectContextFiles();
		if (contextFiles.length > 0) {
			console.log(chalk.dim("Loaded project context from:"));
			for (const { path: filePath } of contextFiles) {
				console.log(chalk.dim(`  - ${filePath}`));
			}
		}
	}

	let startupChangelogSummary: string | null = null;
	let latestEntryVersion: string | null = null;
	if (isFreshInteractiveSession && !isChangelogHiddenFromEnv()) {
		const changelogEntries = parseChangelog(getChangelogPath());
		const lastVersion = readLastShownChangelogVersion();
		const latestEntry = lastVersion
			? getLatestEntry(getNewEntries(changelogEntries, lastVersion))
			: getLatestEntry(changelogEntries);
		if (latestEntry) {
			const versionLabel = formatChangelogVersion(latestEntry);
			const summaryLine = summarizeChangelogEntry(latestEntry);
			startupChangelogSummary = summaryLine
				? `v${versionLabel} — ${summaryLine}`
				: `v${versionLabel}`;
			latestEntryVersion = versionLabel;
		}
		if (latestEntryVersion) {
			writeLastShownChangelogVersion(latestEntryVersion);
		}
	}

	let updateNotice: UpdateCheckResult | null = null;
	if (isFreshInteractiveSession) {
		try {
			updateNotice = await Promise.race([
				checkForUpdate(VERSION),
				new Promise<UpdateCheckResult | null>((resolve) =>
					setTimeout(() => resolve(null), 1_000),
				),
			]);
		} catch {
			updateNotice = null;
		}
		if (updateNotice && !updateNotice.isUpdateAvailable) {
			updateNotice = null;
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
	if (agentsInitPrompt) {
		const cwd = process.cwd();
		const targetPath = agentsInitPath ?? "AGENTS.md";
		const displayPath =
			targetPath.startsWith(cwd) && targetPath !== cwd
				? `.${targetPath.slice(cwd.length)}`
				: targetPath;
		const runMode: Extract<Mode, "text" | "json"> =
			mode === "rpc" ? "text" : mode;
		console.log(chalk.green(`Drafting AGENTS.md at ${displayPath}...`));
		await runSingleShotMode(agent, sessionManager, [agentsInitPrompt], runMode);
		console.log(chalk.dim(`AGENTS.md generated at ${displayPath}`));
	} else if (mode === "rpc") {
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
			{
				modelScope: scopedModels,
				startupChangelogSummary,
				updateNotice,
			},
		);
	} else if (parsed.command === "exec") {
		await runExecCommand({
			agent,
			sessionManager,
			prompts: parsed.messages,
			jsonl: Boolean(parsed.execJson),
			sandboxMode: parsed.execSandbox ?? "default",
			outputSchema: parsed.execOutputSchema,
			outputLastMessage: parsed.execOutputLast,
		});
	} else {
		// CLI mode with messages
		await runSingleShotMode(agent, sessionManager, parsed.messages, mode);
	}
}
