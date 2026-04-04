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
 * | Exec        | maestro exec [prompt]        | Batch with structured output|
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
import { buildCompactionHookContext } from "./agent/compaction-hooks.js";
import {
	type Agent,
	type Api,
	type Model,
	isAssistantMessage,
} from "./agent/index.js";
import { runWithPromptRecovery } from "./agent/prompt-recovery.js";
import { type ToolRetryMode, ToolRetryService } from "./agent/tool-retry.js";
import { createAuthSetup, validateCodexFlags } from "./bootstrap/auth-setup.js";
import {
	disposeCheckpointService,
	initCheckpointService,
} from "./checkpoints/index.js";
import { TuiRenderer } from "./cli-tui/tui-renderer.js";
import { type Mode, parseArgs } from "./cli/args.js";
import {
	EXEC_SESSION_SUMMARY_PREFIX,
	runExecCommand,
} from "./cli/commands/exec.js";
import { runHeadlessMode } from "./cli/headless.js";
import { printHelp } from "./cli/help.js";
import {
	JsonlEventWriter,
	createAgentJsonlAdapter,
	emitThreadEnd,
	emitThreadStart,
	emitUserTurn as emitUserTurnEvent,
} from "./cli/jsonl-writer.js";
import { selectSession } from "./cli/session.js";
import { buildSystemPrompt } from "./cli/system-prompt.js";
import { validateFrameworkPreference } from "./config/framework.js";
import { loadRuntimeConfig } from "./config/runtime-config.js";
import { loadEnv } from "./load-env.js";
import { bootstrapLsp } from "./lsp/bootstrap.js";
import { ensureModelsLoaded } from "./models/builtin.js";
import type { RegisteredModel } from "./models/registry.js";
import { reloadModelConfig } from "./models/registry.js";
import { initOpenTelemetry } from "./opentelemetry.js";
import type { AuthMode } from "./providers/auth.js";
import { AgentRuntimeController } from "./runtime/agent-runtime.js";
import { registerBackgroundTaskShutdownHooks } from "./runtime/background-task-hooks.js";
import { configureSafeMode } from "./safety/safe-mode.js";
import { ServerRequestActionApprovalService } from "./server/approval-service.js";
import { clientToolService } from "./server/client-tools-service.js";
import { ServerRequestToolRetryService } from "./server/tool-retry-service.js";
import { SessionManager } from "./session/manager.js";
import type { UpdateCheckResult } from "./update/check.js";
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
	toolRetryService: ToolRetryService,
	explicitApiKey?: string,
	options: InteractiveOptions = {},
): Promise<void> {
	// Redirect logs to file to avoid polluting the TUI
	const { redirectLoggerToFile } = await import("./utils/logger.js");
	redirectLoggerToFile();

	// Initialize the TUI renderer which manages all terminal output
	const renderer = new TuiRenderer(
		agent,
		sessionManager,
		version,
		approvalService,
		toolRetryService,
		explicitApiKey,
		options,
	);
	const runtime = new AgentRuntimeController({
		agent,
		sessionManager,
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
			await runWithPromptRecovery({
				agent,
				sessionManager,
				hookContext: buildCompactionHookContext(sessionManager, process.cwd()),
				execute: () => agent.prompt(message),
			});
		}

		// In text mode, extract and output only the final text response
		// This provides clean output for shell pipelines and scripts
		if (mode === "text") {
			const lastMessage = agent.state.messages[agent.state.messages.length - 1];
			if (isAssistantMessage(lastMessage)) {
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
	// PHASE 0: Early Exit Checks (before any async initialization)
	// ─────────────────────────────────────────────────────────────────────────────

	// Load environment variables from .env files (project and user level)
	loadEnv();

	// Parse arguments early to check for version/help flags before heavy initialization
	const parsed = parseArgs(args);

	// Handle --version early exit (before any async operations)
	if (parsed.version) {
		console.log(`Maestro v${VERSION}`);
		process.exit(0);
	}

	// Handle --help early exit (before any logging redirection or heavy init)
	if (parsed.help) {
		printHelp(VERSION);
		process.exit(0);
	}

	// Handle `maestro web` early exit (start the bundled web server + UI).
	if (parsed.command === "web") {
		if (parsed.messages.length > 0) {
			console.error(
				chalk.red(
					"`maestro web` does not accept prompt arguments. Use `maestro` (interactive) or `maestro exec` instead.",
				),
			);
			process.exit(1);
		}

		const { startWebServer } = await import("./web-server.js");
		const port =
			parsed.port ?? (Number.parseInt(process.env.PORT || "8080", 10) || 8080);
		await startWebServer(port);
		return;
	}

	const runtimeConfig = loadRuntimeConfig(parsed, process.cwd());
	const reasoningSummary =
		runtimeConfig.config.model_supports_reasoning_summaries === false
			? undefined
			: runtimeConfig.config.model_reasoning_summary === "none"
				? null
				: runtimeConfig.config.model_reasoning_summary;

	// If we're about to enter interactive TUI mode (no prompt messages and not RPC/exec),
	// or headless mode (stdout is JSON-only), redirect all logging/console output to a file.
	// This must run before model loading to catch any early warnings.
	const isLikelyInteractiveTui =
		!parsed.messages.length &&
		(parsed.mode === "text" || parsed.mode === undefined) &&
		parsed.command === undefined;
	const isHeadlessMode = parsed.headless || parsed.mode === "headless";
	if (isLikelyInteractiveTui || isHeadlessMode) {
		const {
			redirectLoggerToFile,
			redirectConsoleToLogger,
			redirectStderrToLogger,
			pipeProcessEventsToLogger,
		} = await import("./utils/logger.js");
		redirectLoggerToFile();
		redirectConsoleToLogger();
		redirectStderrToLogger();
		pipeProcessEventsToLogger();
	}

	const startupProfilingEnabled = process.env.MAESTRO_STARTUP_PROFILE === "1";
	const logStartupPhase = (label: string, startedAt: number) => {
		if (!startupProfilingEnabled) return;
		console.error(
			`[startup] ${label}: ${Math.round(performance.now() - startedAt)}ms`,
		);
	};

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 1: Environment and Telemetry Initialization
	// ─────────────────────────────────────────────────────────────────────────────

	// Initialize OpenTelemetry tracing for observability
	// This is non-blocking (void) to avoid startup latency
	void initOpenTelemetry("composer-cli");

	const bootstrapParallelStart = performance.now();
	const modelLoadPromise = (async () => {
		const startedAt = performance.now();
		await ensureModelsLoaded();
		logStartupPhase("models.loaded", startedAt);
	})();
	const enterpriseContextPromise = (async () => {
		const startedAt = performance.now();
		const { enterpriseContext } = await import("./enterprise/context.js");
		await enterpriseContext.initialize();
		logStartupPhase("enterprise.initialized", startedAt);
		return enterpriseContext;
	})();

	// Pre-load model registry and enterprise context in parallel. These are
	// independent startup costs, so overlapping them reduces cold-start latency.
	const [enterpriseContext] = await Promise.all([
		enterpriseContextPromise,
		modelLoadPromise,
	]);
	logStartupPhase("bootstrap.parallel", bootstrapParallelStart);

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 2: Enterprise Context Initialization
	// ─────────────────────────────────────────────────────────────────────────────

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
			// Don't register signal handlers in test mode - vitest manages process lifecycle
			const isTestMode =
				process.env.VITEST === "true" || process.env.NODE_ENV === "test";
			if (!isTestMode) {
				process.once("beforeExit", cleanup);
				process.once("SIGINT", () => {
					cleanup();
					process.exit(0);
				});
				process.once("SIGTERM", () => {
					cleanup();
					process.exit(0);
				});
			}
			enterpriseCleanupRegistered = true;
		}
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 3: CLI Argument Parsing (already done earlier for early exits)
	// ─────────────────────────────────────────────────────────────────────────────

	// Arguments were already parsed earlier to check for --version flag
	// The parsed result is reused here

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 4: Authentication Setup
	// ─────────────────────────────────────────────────────────────────────────────

	// Determine authentication mode:
	// - auto: Try OAuth first, fall back to API key environment variables
	// - api-key: Require explicit API key from --api-key or env var
	// - claude: Force Anthropic OAuth (no API key fallback)
	const authMode: AuthMode = parsed.authMode ?? "auto";

	try {
		validateCodexFlags(args, parsed.command);
	} catch (error) {
		console.error(
			chalk.red(error instanceof Error ? error.message : String(error)),
		);
		process.exit(1);
	}

	const { requireCredential } = createAuthSetup({
		authMode,
		explicitApiKey: parsed.apiKey,
	});

	if (parsed.command === "exec") {
		if (parsed.execFullAuto && parsed.execReadOnly) {
			console.error(
				chalk.red(
					"Cannot combine --full-auto with --read-only in maestro exec.",
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
		process.env.MAESTRO_SAFE_MODE = "1";
	}

	// Load custom models file if specified
	// This allows users to define additional models beyond the built-in ones
	if (parsed.modelsFile) {
		process.env.MAESTRO_MODELS_FILE = parsed.modelsFile;
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
					chalk.dim("  maestro config validate  - Validate configuration"),
				);
				console.log(
					chalk.dim("  maestro config show      - Show configuration details"),
				);
				console.log(
					chalk.dim("  maestro config init      - Initialize configuration"),
				);
				console.log(
					chalk.dim("  maestro config local     - Manage local providers"),
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

	if (parsed.command === "memory") {
		const { handleMemoryCommand } = await import("./cli/commands/memory.js");
		await handleMemoryCommand(parsed.subcommand, parsed.messages);
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
						"  maestro cost [today]     - Show today's costs (default)",
					),
				);
				console.log(
					chalk.dim("  maestro cost yesterday   - Show yesterday's costs"),
				);
				console.log(chalk.dim("  maestro cost week        - Show last 7 days"));
				console.log(
					chalk.dim("  maestro cost month       - Show last 30 days"),
				);
				console.log(
					chalk.dim("  maestro cost all         - Show all time costs"),
				);
				console.log(
					chalk.dim("  maestro cost breakdown   - Detailed breakdown"),
				);
				console.log(chalk.dim("  maestro cost clear       - Clear usage data"));
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
						"  maestro models list             - List registered models",
					),
				);
				console.log(
					chalk.dim("  maestro models providers        - Summarize providers"),
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

	// Handle "maestro agents init" command to generate AGENTS.md
	if (parsed.command === "agents") {
		const { buildAgentsInitPrompt, handleAgentsInit } = await import(
			"./cli/commands/agents.js"
		);
		if (parsed.subcommand && parsed.subcommand !== "init") {
			console.error(
				chalk.red(
					`Unknown agents subcommand: ${parsed.subcommand}. Try "maestro agents init"`,
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
	// - Session file creation and storage (~/.maestro/agent/sessions/)
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
					chalk.red("No previous maestro exec sessions were found."),
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

	let model: Model<Api>;
	try {
		const { resolveModelFromArgs } = await import(
			"./bootstrap/model-resolution-setup.js"
		);
		const resolved = await resolveModelFromArgs({
			parsedProvider: parsed.provider,
			parsedModel: parsed.model,
			requireCredential,
		});
		model = resolved.model;
	} catch (error) {
		console.error(
			chalk.red(error instanceof Error ? error.message : String(error)),
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
		parsed.appendSystemPrompt,
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
	const approvalService = isHeadlessMode
		? new ServerRequestActionApprovalService(
				approvalModeOverride,
				() => sessionManager.getSessionId() ?? undefined,
			)
		: new ActionApprovalService(approvalModeOverride);
	const headlessClientToolService = isHeadlessMode
		? clientToolService.forSession(
				() => sessionManager.getSessionId() ?? undefined,
			)
		: undefined;
	const toolRetryMode: ToolRetryMode =
		isInteractiveTui && !isHeadlessMode ? "prompt" : "skip";
	const toolRetryService = isHeadlessMode
		? new ServerRequestToolRetryService(
				toolRetryMode,
				() => sessionManager.getSessionId() ?? undefined,
			)
		: new ToolRetryService(toolRetryMode);

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 10: Tool Registry and Sandbox Setup
	// ─────────────────────────────────────────────────────────────────────────────

	let toolsResult: Awaited<
		ReturnType<
			typeof import("./bootstrap/tools-setup.js").createToolsAndSandbox
		>
	>;
	try {
		const { createToolsAndSandbox } = await import(
			"./bootstrap/tools-setup.js"
		);
		toolsResult = await createToolsAndSandbox({
			parsedTools: parsed.tools,
			parsedSandbox: parsed.sandbox,
			cwd: process.cwd(),
		});
	} catch (error) {
		console.error(
			chalk.red(error instanceof Error ? error.message : String(error)),
		);
		process.exit(1);
	}
	const { allTools, baseTools, sandbox, sandboxMode } = toolsResult;

	// Register sandbox cleanup on exit (only if sandbox is active)
	if (sandbox && toolsResult.disposeSandbox) {
		const cleanupSandbox = toolsResult.disposeSandbox;
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

	const { createAgentInstance } = await import(
		"./bootstrap/agent-creation-setup.js"
	);
	const enterpriseUser = (() => {
		const u = enterpriseContext.getUser();
		return u ? { id: u.userId, orgId: u.orgId } : undefined;
	})();
	const { agent } = createAgentInstance({
		systemPrompt,
		model,
		reasoningSummary,
		allTools,
		sandbox,
		sandboxMode: sandboxMode ?? null,
		approvalService,
		toolRetryService,
		clientToolService: headlessClientToolService,
		requireCredential,
		enterpriseUser,
		readonly: parsed.readonly,
		composer: parsed.composer,
		cwd: process.cwd(),
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 11.5: TypeScript Hooks Initialization
	// ─────────────────────────────────────────────────────────────────────────────

	const { initializeTypeScriptHooks } = await import(
		"./bootstrap/hooks-setup.js"
	);
	const { tsHooks } = await initializeTypeScriptHooks({
		agent,
		sessionManager,
		cwd: process.cwd(),
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 12: MCP (Model Context Protocol) Integration
	// ─────────────────────────────────────────────────────────────────────────────

	const mcpInitStartedAt = performance.now();
	const { initializeMcpServers } = await import("./bootstrap/mcp-setup.js");
	initializeMcpServers({ agent, baseTools, cwd: process.cwd() });
	logStartupPhase("mcp.bootstrap_queued", mcpInitStartedAt);

	// Determine mode early to know if we should print messages
	const isInteractive = parsed.messages.length === 0;
	const mode = parsed.mode || "text";
	// Don't print messages in headless mode - stdout is for JSON only
	const shouldPrintMessages =
		(isInteractive || mode === "text") &&
		mode !== "headless" &&
		!parsed.headless;

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

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 13: Session Restoration
	// ─────────────────────────────────────────────────────────────────────────────

	const shouldRestoreSession =
		parsed.continue || parsed.resume || execResumeApplied;
	const isFreshInteractiveSession =
		isInteractive && !shouldRestoreSession && mode !== "rpc";

	const { restoreSessionState } = await import(
		"./bootstrap/session-restoration-setup.js"
	);
	const { startupChangelogSummary, updateNotice, scopedModels } =
		await restoreSessionState({
			agent,
			sessionManager,
			shouldRestoreSession,
			isContinueOrResume: Boolean(parsed.continue || parsed.resume),
			shouldPrintMessages,
			isFreshInteractiveSession,
			version: VERSION,
			models: parsed.models,
		});

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 14.5: Event Subscriptions
	// ─────────────────────────────────────────────────────────────────────────────

	const { setupEventSubscriptions } = await import(
		"./bootstrap/event-subscriptions-setup.js"
	);
	setupEventSubscriptions({
		agent,
		sessionManager,
		approvalMode: (approvalModeOverride ?? "prompt") as
			| "auto"
			| "prompt"
			| "fail",
		sandboxMode,
		tsHookCount: tsHooks.length,
		cwd: process.cwd(),
		enterpriseContext,
	});

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
			mode === "rpc" || mode === "headless" ? "text" : mode;
		console.log(chalk.green(`Drafting AGENTS.md at ${displayPath}...`));
		await runSingleShotMode(agent, sessionManager, [agentsInitPrompt], runMode);
		console.log(chalk.dim(`AGENTS.md generated at ${displayPath}`));
	} else if (mode === "headless" || parsed.headless) {
		// Headless mode - for native TUI communication
		await runHeadlessMode(
			agent,
			sessionManager,
			approvalService,
			toolRetryService,
		);
	} else if (mode === "rpc") {
		// RPC mode - headless operation
		const { runRpcMode } = await import("./cli/rpc-mode.js");
		await runRpcMode(agent, sessionManager);
	} else if (isInteractive) {
		// No messages and not RPC - use TUI
		await runInteractiveMode(
			agent,
			sessionManager,
			VERSION,
			approvalService,
			toolRetryService,
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
