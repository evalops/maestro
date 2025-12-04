/**
 * Main Entry Point - Composer CLI Application
 *
 * This module orchestrates the complete initialization sequence for the Composer CLI,
 * including authentication, model resolution, session management, and runtime mode
 * selection. It serves as the single entry point that routes execution to the
 * appropriate mode (interactive TUI, single-shot, RPC, or exec).
 *
 * ## Initialization Sequence
 *
 * The startup process follows a specific order to ensure proper dependency resolution:
 *
 * ```
 * 1. Environment Loading
 *    ├── Load .env files (via dotenv)
 *    ├── Initialize OpenTelemetry for tracing
 *    └── Load model registry (async, before UI)
 *
 * 2. Enterprise Context (optional)
 *    ├── Initialize user/org tracking
 *    └── Set up audit logging if enterprise features enabled
 *
 * 3. CLI Argument Parsing
 *    ├── Parse command-line flags
 *    └── Handle --help, config commands, and other early exits
 *
 * 4. Authentication Resolution
 *    ├── Determine auth mode (auto, api-key, or claude-only)
 *    ├── Resolve credentials for the selected provider
 *    └── Build error messages for missing credentials
 *
 * 5. Safety & Sandboxing
 *    ├── Configure safe mode
 *    ├── Register background task shutdown hooks
 *    ├── Bootstrap LSP
 *    └── Initialize checkpointing for undo/redo
 *
 * 6. Model Resolution
 *    ├── Resolve provider and model from CLI args or defaults
 *    ├── Validate against policy restrictions
 *    └── Require valid credentials for selected provider
 *
 * 7. Session Initialization
 *    ├── Create or load session manager
 *    ├── Handle --continue, --resume, and exec resume modes
 *    └── Load previous messages if continuing session
 *
 * 8. Agent & Tool Setup
 *    ├── Build system prompt with project context
 *    ├── Configure approval service (prompt, auto, fail modes)
 *    ├── Initialize sandbox if requested (docker, local, none)
 *    ├── Create Agent with transport, tools, and context sources
 *    └── Initialize MCP servers for additional tools
 *
 * 9. Runtime Mode Selection
 *    ├── Interactive TUI: Full terminal interface with input/output
 *    ├── Single-shot: Process messages and output result
 *    ├── RPC: JSON-over-stdin/stdout for programmatic control
 *    └── Exec: Non-interactive batch execution with structured output
 * ```
 *
 * ## Authentication Modes
 *
 * The CLI supports multiple authentication strategies:
 *
 * | Mode     | Description                                      |
 * |----------|--------------------------------------------------|
 * | auto     | Try OAuth first, fall back to API key env vars   |
 * | api-key  | Require explicit API key (--api-key or env var)  |
 * | claude   | Force Anthropic OAuth (no API key fallback)      |
 *
 * ## Runtime Modes
 *
 * | Mode        | Trigger                       | Behavior                    |
 * |-------------|-------------------------------|-----------------------------|
 * | Interactive | No messages, not RPC          | Full TUI with readline      |
 * | Single-shot | Messages provided, text/json  | Process and exit            |
 * | RPC         | --mode=rpc                    | JSON protocol over stdio    |
 * | Exec        | composer exec [prompt]        | Batch with structured output|
 *
 * ## Error Handling
 *
 * Critical errors during initialization will print colored error messages
 * and exit with appropriate codes. The initialization is designed to fail
 * fast and provide actionable error messages.
 *
 * @module main
 */

import { createRequire } from "node:module";
import chalk from "chalk";
import {
	ActionApprovalService,
	type ApprovalMode,
} from "./agent/action-approval.js";
import {
	BackgroundTaskContextSource,
	FrameworkPreferenceContextSource,
	IDEContextSource,
	LspContextSource,
	TodoContextSource,
} from "./agent/context-providers.js";
import { Agent, ProviderTransport, type ThinkingLevel } from "./agent/index.js";
import {
	disposeCheckpointService,
	initCheckpointService,
} from "./checkpoints/index.js";
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
import { composerManager } from "./composers/index.js";
import { validateFrameworkPreference } from "./config/framework.js";
import {
	createNotificationFromAgentEvent,
	isNotificationEnabled,
	sendNotification,
} from "./hooks/notification-hooks.js";
import { loadEnv } from "./load-env.js";
import { bootstrapLsp } from "./lsp/bootstrap.js";
import { loadMcpConfig } from "./mcp/config.js";
import { mcpManager } from "./mcp/manager.js";
import { getAllMcpTools } from "./mcp/tool-bridge.js";
import { ensureModelsLoaded } from "./models/builtin.js";
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
import { initOpenTelemetry } from "./opentelemetry.js";
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
import { registerBackgroundTaskShutdownHooks } from "./runtime/background-task-hooks.js";
import { PolicyError, checkSessionLimits } from "./safety/policy.js";
import { configureSafeMode } from "./safety/safe-mode.js";
import {
	type SandboxMode,
	createSandbox,
	disposeSandbox,
} from "./sandbox/index.js";
import { SessionManager, toSessionModelMetadata } from "./session/manager.js";
import {
	codingTools,
	filterTools,
	readOnlyToolNames,
	toolRegistry,
} from "./tools/index.js";
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
import { isInsideGitRepository } from "./utils/git.js";

/**
 * Load version from package.json at runtime.
 * Uses Node's createRequire for compatibility with ESM imports
 * (avoids experimental import assertions syntax).
 */
const packageJson = createRequire(import.meta.url)("../package.json") as {
	version?: string;
};
const VERSION = packageJson.version ?? "unknown";
let enterpriseCleanupRegistered = false;
let checkpointCleanupRegistered = false;
let sandboxCleanupRegistered = false;

/**
 * Configuration options passed to the interactive TUI renderer.
 * These options customize the startup experience shown to users.
 */
interface InteractiveOptions {
	/** Subset of models available for switching (from --models flag) */
	modelScope?: RegisteredModel[];
	/** Changelog summary to display on startup (e.g., "v1.2.0 — New features") */
	startupChangelogSummary?: string | null;
	/** Update notification if a newer version is available */
	updateNotice?: UpdateCheckResult | null;
}

/**
 * Runs the full interactive Terminal UI (TUI) mode.
 *
 * This is the primary user-facing mode when composer is invoked without
 * command-line messages. It provides:
 * - Real-time streaming of model responses
 * - Interactive input with readline and autocomplete
 * - Tool execution with approval prompts
 * - Session persistence and recovery
 * - View switching (chat, tools, sessions, etc.)
 *
 * The function sets up the TUI renderer, subscribes to agent events,
 * and runs the main input loop until the user exits.
 *
 * @param agent - Configured Agent instance for LLM communication
 * @param sessionManager - Handles session persistence and recovery
 * @param version - Current CLI version for display
 * @param approvalService - Controls tool execution approval behavior
 * @param explicitApiKey - API key from --api-key flag (for display purposes)
 * @param options - Additional startup configuration (model scope, changelog, etc.)
 */
async function runInteractiveMode(
	agent: Agent,
	sessionManager: SessionManager,
	version: string,
	approvalService: ActionApprovalService,
	explicitApiKey?: string,
	options: InteractiveOptions = {},
): Promise<void> {
	// Initialize the TUI renderer which manages all terminal output
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

	// Initialize TUI - sets up terminal raw mode, cursor handling, and rendering
	await renderer.init();

	// Render any existing messages from a continued session (--continue mode)
	// This allows users to see their previous conversation context
	renderer.renderInitialMessages(agent.state);

	// Subscribe to agent events for real-time UI updates
	// The renderer handles streaming text, tool execution, errors, and completion
	agent.subscribe(async (event) => {
		await renderer.handleEvent(event, agent.state);
	});

	// Run the main interactive loop - blocks until user exits
	await runtime.runInteractiveLoop(renderer);
}

/**
 * Runs the CLI in single-shot (non-interactive) mode.
 *
 * Processes one or more messages from the command line and outputs
 * the result. Supports two output formats:
 *
 * - **text**: Outputs only the final assistant text response (human-readable)
 * - **json**: Outputs JSONL event stream for machine processing
 *
 * This mode is useful for scripting and automation:
 * ```bash
 * composer "What time is it?" --mode text
 * composer "Generate code" --mode json > output.jsonl
 * ```
 *
 * @param agent - Configured Agent instance
 * @param sessionManager - For session ID tracking
 * @param messages - Array of user messages to process sequentially
 * @param mode - Output format: "text" for human-readable, "json" for JSONL
 */
async function runSingleShotMode(
	agent: Agent,
	sessionManager: SessionManager,
	messages: string[],
	mode: Extract<Mode, "text" | "json">,
): Promise<void> {
	// Use session ID as thread ID for JSONL output correlation
	const threadId = sessionManager.getSessionId();

	// Set up JSONL writer for structured output in json mode
	// This enables machine-readable event streaming for integrations
	const jsonlWriter =
		mode === "json" ? new JsonlEventWriter(true, process.stdout) : null;

	// Turn ID generator for correlating user messages with responses
	const nextTurnId = (() => {
		let counter = 0;
		return () => `turn-${++counter}`;
	})();

	// Adapter translates agent events to JSONL format
	const adapter =
		jsonlWriter && createAgentJsonlAdapter(jsonlWriter, nextTurnId);

	// In JSON mode, emit thread start and subscribe to all events
	if (jsonlWriter) {
		emitThreadStart(jsonlWriter, threadId, { sessionId: threadId });
		agent.subscribe((event) => {
			adapter?.handle(event);
		});
	}

	try {
		// Process each message sequentially
		// This allows multi-message conversations in single-shot mode
		for (const message of messages) {
			if (jsonlWriter) {
				emitUserTurnEvent(jsonlWriter, nextTurnId, message);
			}
			await agent.prompt(message);
		}

		// In text mode, extract and output only the final text response
		// This provides clean output for shell pipelines and scripts
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
		// Ensure error is recorded in JSONL output for machine processing
		if (jsonlWriter) {
			emitThreadEnd(jsonlWriter, threadId, "error", threadId);
		}
		throw error;
	}
}

/**
 * Runs the CLI in RPC (Remote Procedure Call) mode.
 *
 * This mode provides a JSON-over-stdio protocol for programmatic control
 * of the agent. It's designed for IDE integrations, language servers,
 * and other tools that need to embed composer functionality.
 *
 * ## Protocol
 *
 * **Input (stdin)**: JSON objects, one per line
 * ```json
 * {"type": "prompt", "message": "Hello"}
 * {"type": "abort"}
 * ```
 *
 * **Output (stdout)**: Agent events as JSON objects, one per line
 * ```json
 * {"type": "message_start", ...}
 * {"type": "content_block_delta", ...}
 * {"type": "message_end", ...}
 * ```
 *
 * The process runs indefinitely until stdin closes or it receives
 * a termination signal.
 *
 * @param agent - Configured Agent instance
 * @param _sessionManager - Unused but kept for consistent function signature
 */
async function runRpcMode(
	agent: Agent,
	_sessionManager: SessionManager,
): Promise<void> {
	// Subscribe to all events and emit as JSON for client consumption
	agent.subscribe((event) => {
		console.log(JSON.stringify(event));
	});

	// Set up JSON-over-stdin readline interface
	// Each line is expected to be a complete JSON object
	const readline = await import("node:readline");
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: false, // Disable terminal features for raw JSON I/O
	});

	// Process incoming RPC commands line by line
	rl.on("line", async (line: string) => {
		try {
			const input = JSON.parse(line);

			// Dispatch based on command type
			// Currently supports: prompt (send message) and abort (cancel)
			if (input.type === "prompt" && input.message) {
				await agent.prompt(input.message);
			} else if (input.type === "abort") {
				agent.abort();
			}
		} catch (error: unknown) {
			// Emit parsing/execution errors as JSON for client handling
			const message = error instanceof Error ? error.message : String(error);
			console.log(JSON.stringify({ type: "error", error: message }));
		}
	});

	// Keep process alive indefinitely - exits when stdin closes
	return new Promise(() => {});
}

/**
 * Main entry point for the Composer CLI application.
 *
 * This function orchestrates the complete initialization sequence and routes
 * to the appropriate runtime mode. It performs all setup synchronously where
 * possible and handles errors with user-friendly messages.
 *
 * ## Execution Phases
 *
 * 1. **Early Initialization**: Environment, telemetry, model registry
 * 2. **Enterprise Setup**: Audit logging, user tracking (if applicable)
 * 3. **CLI Parsing**: Handle help, version, and subcommands (config, cost, models)
 * 4. **Authentication**: Resolve credentials for the selected provider
 * 5. **Session Setup**: Create or restore session state
 * 6. **Agent Creation**: Configure transport, tools, context sources
 * 7. **MCP Integration**: Connect to Model Context Protocol servers
 * 8. **Mode Dispatch**: Route to interactive, single-shot, RPC, or exec mode
 *
 * @param args - Command-line arguments (typically process.argv.slice(2))
 */
export async function main(args: string[]) {
	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 1: Environment and Telemetry Initialization
	// ─────────────────────────────────────────────────────────────────────────────

	// Load environment variables from .env files (project and user level)
	loadEnv();

	// Initialize OpenTelemetry tracing for observability
	// This is non-blocking (void) to avoid startup latency
	void initOpenTelemetry("composer-cli");

	// Pre-load model registry before any UI needs it
	// This includes built-in models and any custom models from user config
	await ensureModelsLoaded();

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 2: Enterprise Context Initialization
	// ─────────────────────────────────────────────────────────────────────────────

	// Initialize enterprise context for user/org tracking
	// This enables audit logging and policy enforcement in enterprise deployments
	const { enterpriseContext } = await import("./enterprise/context.js");
	await enterpriseContext.initialize();

	// Initialize audit integration if enterprise features are available
	// This logs all tool executions, model interactions, and session events
	if (enterpriseContext.isEnterprise()) {
		const { initializeAuditIntegration } = await import(
			"./enterprise/audit-integration.js"
		);
		initializeAuditIntegration();

		// Register cleanup handlers to properly end enterprise session on exit
		// This ensures audit logs capture session termination
		if (!enterpriseCleanupRegistered) {
			const cleanup = () => {
				enterpriseContext.endSession();
			};
			process.once("beforeExit", cleanup);
			process.once("SIGINT", () => {
				cleanup();
				process.exit(0);
			});
			process.once("SIGTERM", () => {
				cleanup();
				process.exit(0);
			});
			enterpriseCleanupRegistered = true;
		}
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 3: CLI Argument Parsing
	// ─────────────────────────────────────────────────────────────────────────────

	// Parse command-line arguments into structured options
	// This handles flags like --model, --provider, --continue, --resume, etc.
	const parsed = parseArgs(args);

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 4: Authentication Setup
	// ─────────────────────────────────────────────────────────────────────────────

	// Determine authentication mode:
	// - auto: Try OAuth first, fall back to API key environment variables
	// - api-key: Require explicit API key from --api-key or env var
	// - claude: Force Anthropic OAuth (no API key fallback)
	const authMode: AuthMode = parsed.authMode ?? "auto";

	// Explicitly disallow Codex/ChatGPT subscription tokens.
	if (process.env.CODEX_API_KEY) {
		console.warn(
			chalk.yellow(
				"CODEX_API_KEY detected but Codex subscriptions are not supported. The value will be ignored.",
			),
		);
	}
	if (parsed.command !== "help" && parsed.command !== "config") {
		const codexFlagsUsed = args.some((arg, index) => {
			if (arg === "--codex-api-key" || arg.startsWith("--codex-api-key=")) {
				return true;
			}
			if (arg === "--auth" && args[index + 1] === "chatgpt") return true;
			if (arg.startsWith("--auth=chatgpt")) return true;
			return false;
		});
		if (codexFlagsUsed) {
			console.error(
				chalk.red(
					"Codex/ChatGPT auth mode is no longer supported. Use a standard OpenAI API key instead.",
				),
			);
			process.exit(1);
		}
	}

	// Create authentication resolver that handles credential lookup
	// The resolver is called when making API requests to determine auth headers
	const authResolver = createAuthResolver({
		mode: authMode,
		explicitApiKey: parsed.apiKey,
	});

	// Helper to build user-friendly error messages for missing credentials
	// Returns both plain text (for errors) and colored (for terminal) versions
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
				'Run "composer anthropic login" (claude) or provide an API key for the selected provider before retrying.',
				chalk.dim(
					'Run "composer anthropic login" (claude) or provide an API key for the selected provider before retrying.',
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
	}

	// Validate sandbox mode (applies to both exec and interactive modes)
	const validSandboxModes = ["docker", "local", "none"];
	if (parsed.sandbox && !validSandboxModes.includes(parsed.sandbox)) {
		console.error(
			chalk.red(
				`Unknown sandbox mode "${parsed.sandbox}". Supported: ${validSandboxModes.join(", ")}`,
			),
		);
		process.exit(1);
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 5: Safety, LSP, and Checkpointing
	// ─────────────────────────────────────────────────────────────────────────────

	// Enable safe mode if requested (restricts dangerous operations)
	if (parsed.safeMode) {
		process.env.COMPOSER_SAFE_MODE = "1";
	}

	// Load custom models file if specified
	// This allows users to define additional models beyond the built-in ones
	if (parsed.modelsFile) {
		process.env.COMPOSER_MODELS_FILE = parsed.modelsFile;
		reloadModelConfig();
	}

	// Configure safe mode settings (e.g., disabling certain tools in sandboxed environments)
	configureSafeMode(true);

	// Register shutdown hooks for background tasks to ensure clean cleanup
	registerBackgroundTaskShutdownHooks();

	// Bootstrap Language Server Protocol for IDE integration
	// This enables features like go-to-definition, hover info, and diagnostics
	await bootstrapLsp();

	// Initialize checkpointing service for undo/redo functionality
	// PreToolUse hooks capture file snapshots before tool execution
	initCheckpointService(process.cwd());
	const disposeCheckpoint = (): void => disposeCheckpointService();
	if (!checkpointCleanupRegistered) {
		process.once("beforeExit", disposeCheckpoint);
		process.once("SIGINT", disposeCheckpoint);
		process.once("SIGTERM", disposeCheckpoint);
		checkpointCleanupRegistered = true;
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Early Exit: Help Command
	// ─────────────────────────────────────────────────────────────────────────────

	if (parsed.help) {
		printHelp(VERSION);
		return;
	}

	const frameworkWarning = validateFrameworkPreference();
	if (frameworkWarning) {
		console.warn(
			chalk.yellow(`Framework preference warning: ${frameworkWarning}`),
		);
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

	if (parsed.command === "hooks") {
		const { handleHooksCommand } = await import("./cli/commands/hooks.js");
		await handleHooksCommand(parsed.subcommand);
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

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 6: Special Command Handling (agents init)
	// ─────────────────────────────────────────────────────────────────────────────

	// Track agents init state for deferred execution
	let agentsInitPrompt: string | null = null;
	let agentsInitPath: string | null = null;

	// Handle "composer agents init" command to generate AGENTS.md
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

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 7: Session Management
	// ─────────────────────────────────────────────────────────────────────────────

	// Create session manager for conversation persistence
	// The session manager handles:
	// - Session file creation and storage (~/.composer/agent/sessions/)
	// - Message persistence in JSONL format
	// - Session resume and continuation
	// - Model/thinking level tracking across restarts
	const sessionManager = new SessionManager(
		parsed.continue && !parsed.resume, // continueSession: auto-load most recent
		parsed.session, // customSessionPath: explicit session file
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

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 8: Model Resolution
	// ─────────────────────────────────────────────────────────────────────────────

	// Resolve the provider and model to use for this session
	// Priority: CLI args > alias resolution > factory defaults > hardcoded defaults
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
	modelId ??= "claude-opus-4-5-20251101";

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
	let model: ReturnType<typeof resolveModel> | undefined;
	try {
		model = resolveModel(provider, modelId);
	} catch (error) {
		if (error instanceof PolicyError) {
			console.error(chalk.red(`\n${error.message}\n`));
			process.exit(1);
		}
		throw error;
	}

	if (!model) {
		console.error(
			chalk.red(
				`Unknown model "${provider}/${modelId}". Check your models config.`,
			),
		);
		process.exit(1);
	}
	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 9: System Prompt and Tool Configuration
	// ─────────────────────────────────────────────────────────────────────────────

	// Build the system prompt with project context
	// The system prompt includes:
	// - Base instructions for the agent
	// - Project context files (COMPOSER.md, AGENTS.md, etc.)
	// - Tool-specific instructions based on available tools
	const systemPromptToolNames = parsed.tools;
	const systemPrompt = buildSystemPrompt(
		parsed.systemPrompt,
		systemPromptToolNames,
	);

	// Determine approval mode for tool execution:
	// - "prompt": Ask user before each tool execution (default for interactive)
	// - "auto": Automatically approve all tools (default for non-interactive)
	// - "fail": Reject all tool executions (for read-only mode)
	const isInteractiveTui =
		parsed.messages.length === 0 && (parsed.mode ?? "text") !== "rpc";
	const defaultApprovalMode: ApprovalMode = isInteractiveTui
		? "prompt"
		: "auto";

	// Override approval mode based on exec flags
	const approvalModeOverride = (() => {
		if (parsed.command === "exec") {
			if (parsed.execReadOnly) return "fail"; // Read-only: reject all writes
			if (parsed.execFullAuto) return "auto"; // Full-auto: approve everything
		}
		return parsed.approvalMode ?? defaultApprovalMode;
	})();

	// Create approval service that controls tool execution authorization
	const approvalService = new ActionApprovalService(approvalModeOverride);

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 10: Tool Registry and Sandbox Setup
	// ─────────────────────────────────────────────────────────────────────────────

	// Build initial tools list - MCP tools will be added dynamically after connection
	// Apply --tools filter if user specified a subset of tools
	let baseTools = codingTools;
	if (parsed.tools && parsed.tools.length > 0) {
		const filteredTools = filterTools(parsed.tools);
		if (filteredTools.length === 0) {
			console.error(
				chalk.red(
					`No valid tools matched --tools filter: ${parsed.tools.join(", ")}`,
				),
			);
			console.log(
				chalk.dim(
					`Available tools: ${Object.keys(toolRegistry).sort().join(", ")}`,
				),
			);
			process.exit(1);
		}
		baseTools = filteredTools;
		console.log(
			chalk.dim(
				`Tools restricted to: ${filteredTools.map((t) => t.name).join(", ")}`,
			),
		);
	}
	const allTools = [...baseTools];

	// Create sandbox for isolated tool execution if requested
	// Sandbox modes:
	// - "docker": Run tools in a Docker container for isolation
	// - "local": Run tools locally with limited permissions
	// - "none": No sandboxing (default)
	const sandboxMode = (parsed.sandbox ?? process.env.COMPOSER_SANDBOX_MODE) as
		| SandboxMode
		| undefined;
	const sandbox = sandboxMode
		? await createSandbox({ mode: sandboxMode, cwd: process.cwd() })
		: undefined;

	// Register sandbox cleanup on exit (only if sandbox is active)
	if (sandbox) {
		const cleanupSandbox = async () => {
			await disposeSandbox(sandbox);
		};
		if (!sandboxCleanupRegistered) {
			process.once("beforeExit", () => void cleanupSandbox());
			process.once("SIGINT", () => {
				void cleanupSandbox();
				process.exit(0);
			});
			process.once("SIGTERM", () => {
				void cleanupSandbox();
				process.exit(0);
			});
			sandboxCleanupRegistered = true;
		}
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 11: Agent Creation
	// ─────────────────────────────────────────────────────────────────────────────

	// Create the main Agent instance that orchestrates LLM communication
	// The Agent handles:
	// - Message history management
	// - Streaming response handling
	// - Tool execution orchestration
	// - Context injection from various sources
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "off", // Extended thinking disabled by default
			tools: allTools,
			sandbox,
			sandboxMode: sandboxMode ?? null,
			sandboxEnabled: Boolean(sandbox),
			// Inject enterprise user context for audit logging
			user: (() => {
				const u = enterpriseContext.getUser();
				return u ? { id: u.userId, orgId: u.orgId } : undefined;
			})(),
		},
		// Transport handles LLM API communication with auth resolution
		transport: new ProviderTransport({
			getAuthContext: (providerName) => requireCredential(providerName, false),
			approvalService,
		}),
		// Context sources inject dynamic information into the system prompt
		// These provide real-time context like todos, background tasks, LSP state, etc.
		contextSources: [
			new TodoContextSource(), // Active todo list items
			new BackgroundTaskContextSource(), // Running background processes
			new LspContextSource(), // Language Server diagnostics
			new FrameworkPreferenceContextSource(), // Framework preferences
			new IDEContextSource(), // IDE integration state
		],
	});

	// Initialize composer manager for multi-agent orchestration
	// The composer manager handles spawning sub-agents and coordinating workflows
	composerManager.initialize(agent, systemPrompt, allTools, process.cwd());

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 12: MCP (Model Context Protocol) Integration
	// ─────────────────────────────────────────────────────────────────────────────

	// Initialize MCP servers to extend available tools
	// MCP servers provide additional capabilities like database access,
	// file system operations, API integrations, etc.
	const mcpConfig = loadMcpConfig(process.cwd(), { includeEnvLimits: true });
	if (mcpConfig.servers.length > 0) {
		// Listen for MCP server connections to add their tools
		mcpManager.on("connected", () => {
			const mcpTools = getAllMcpTools();
			if (mcpTools.length > 0) {
				const updatedTools = [...baseTools, ...mcpTools];
				agent.setTools(updatedTools);
				// Update composer manager's base tools (preserves active composer state)
				composerManager.updateBaseTools(updatedTools);
			}
		});

		// Listen for tool list changes to update agent tools dynamically
		// Debounced to handle rapid concurrent updates from multiple servers
		let toolsChangedTimeout: ReturnType<typeof setTimeout> | null = null;
		mcpManager.on("tools_changed", () => {
			if (toolsChangedTimeout) clearTimeout(toolsChangedTimeout);
			toolsChangedTimeout = setTimeout(() => {
				toolsChangedTimeout = null;
				const mcpTools = getAllMcpTools();
				const updatedTools = [...baseTools, ...mcpTools];
				agent.setTools(updatedTools);
				composerManager.updateBaseTools(updatedTools);
			}, 100);
		});

		// Clear pending timeout only when all servers have disconnected
		mcpManager.on("disconnected", () => {
			const hasConnectedServers = mcpManager
				.getStatus()
				.servers.some((s) => s.connected);
			if (!hasConnectedServers && toolsChangedTimeout) {
				clearTimeout(toolsChangedTimeout);
				toolsChangedTimeout = null;
			}
		});

		mcpManager.configure(mcpConfig).catch((err) => {
			console.warn("[mcp] Failed to initialize MCP servers:", err);
		});
	}

	// Determine mode early to know if we should print messages
	const isInteractive = parsed.messages.length === 0;
	const mode = parsed.mode || "text";
	const shouldPrintMessages = isInteractive || mode === "text";

	const isGitRepository = isInsideGitRepository();

	// Log sandbox status
	if (sandbox && shouldPrintMessages) {
		console.log(chalk.dim(`Sandbox enabled (mode: ${sandboxMode})`));
	}

	if (
		approvalModeOverride === "auto" &&
		!isGitRepository &&
		shouldPrintMessages
	) {
		console.log(
			chalk.yellow(
				"Auto approval is enabled outside a git repository. Changes will not be version controlled.",
			),
		);
	}

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

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 13: Session Restoration
	// ─────────────────────────────────────────────────────────────────────────────

	// Restore previous session state if continuing or resuming
	// This includes messages, model selection, and thinking level
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
				// Check concurrent session limit before starting
				// We define "active" as updated in the last hour
				let activeCount: number | undefined;
				try {
					const sessions = sessionManager.loadAllSessions();
					activeCount = sessions.filter(
						(s) => Date.now() - s.modified.getTime() < 60 * 60 * 1000,
					).length;
				} catch (error) {
					// Fallback to undefined to let checkSessionLimits decide (it will fail-closed if limit exists)
					console.error(
						chalk.yellow(
							`[Policy] Failed to count active sessions: ${error instanceof Error ? error.message : String(error)}`,
						),
					);
				}

				// Check against policy (+1 for the session we are about to create)
				const limitCheck = checkSessionLimits(
					{ startedAt: new Date() },
					// If loadAllSessions failed (activeCount undefined), we pass undefined to trigger fail-closed
					// If successful (activeCount number), we pass count + 1
					activeCount !== undefined
						? { activeSessionCount: activeCount + 1 }
						: undefined,
				);

				if (!limitCheck.allowed) {
					const msg = `\n[Policy] ${limitCheck.reason}`;
					if (isInteractive) {
						// In TUI, we might need to show error via renderer, but renderer isn't accessible here easily
						// We'll log to stderr which might break TUI layout, but it's a fatal error
						console.error(chalk.red(msg));
						// We can't easily stop the agent loop from here without throwing
						process.exit(1);
					} else {
						console.error(chalk.red(msg));
						process.exit(1);
					}
				}

				sessionManager.startSession(agent.state);

				// Record session start in enterprise context for audit logging
				if (enterpriseContext.isEnterprise()) {
					enterpriseContext.startSession(
						sessionManager.getSessionId(),
						(agent.state.model as RegisteredModel)?.id,
					);
					const session = enterpriseContext.getSession();
					if (session) {
						agent.setSession({
							id: session.sessionId,
							startedAt: session.startedAt,
						});
					}
				}
			}
		}

		const modelMetadata = toSessionModelMetadata(
			agent.state.model as RegisteredModel,
		);
		sessionManager.updateSnapshot(agent.state, modelMetadata);
	});

	// Subscribe to agent events for notification hooks (if configured)
	if (
		isNotificationEnabled("turn-complete") ||
		isNotificationEnabled("session-start") ||
		isNotificationEnabled("session-end") ||
		isNotificationEnabled("tool-execution") ||
		isNotificationEnabled("error")
	) {
		agent.subscribe((event) => {
			const payload = createNotificationFromAgentEvent(event, {
				cwd: process.cwd(),
				sessionId: sessionManager.getSessionId(),
				messages: agent.state.messages,
			});
			if (payload) {
				void sendNotification(payload);
			}
		});
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 14: Runtime Mode Dispatch
	// ─────────────────────────────────────────────────────────────────────────────

	// Route to the appropriate runtime mode based on command and arguments:
	// 1. agents init: Generate AGENTS.md file
	// 2. RPC mode: JSON-over-stdio protocol for programmatic control
	// 3. Interactive TUI: Full terminal interface
	// 4. Exec mode: Non-interactive batch execution
	// 5. Single-shot: Process CLI messages and exit
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
			sandboxMode: sandboxMode,
			outputSchema: parsed.execOutputSchema,
			outputLastMessage: parsed.execOutputLast,
		});
	} else {
		// CLI mode with messages
		await runSingleShotMode(agent, sessionManager, parsed.messages, mode);
	}
}
