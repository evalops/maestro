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
import type {
	ActionApprovalService,
	ApprovalMode,
} from "./agent/action-approval.js";
import { createBackgroundTextAgent } from "./agent/background-agent.js";
import {
	type Agent,
	type Api,
	type Model,
	isAssistantMessage,
} from "./agent/index.js";
import { getAllModes, getModelForMode } from "./agent/modes.js";
import { loadScriptedScenarioFromSource } from "./agent/providers/scripted.js";
import { scenarioSourceLabel } from "./agent/scenario-source.js";
import { applySessionEndHooks } from "./agent/session-lifecycle-hooks.js";
import { type ToolRetryMode, ToolRetryService } from "./agent/tool-retry.js";
import {
	applySessionStartHooks,
	runUserPromptWithRecovery,
} from "./agent/user-prompt-runtime.js";
import { PlatformBackedActionApprovalService } from "./approvals/platform-action-approval.js";
import { createAuthSetup, validateCodexFlags } from "./bootstrap/auth-setup.js";
import {
	disposeCheckpointService,
	initCheckpointService,
} from "./checkpoints/index.js";
import { TuiClientToolService } from "./cli-tui/client-tools/local-client-tool-service.js";
import { TuiRenderer } from "./cli-tui/tui-renderer.js";
import { sanitizeTerminalPreview } from "./cli-tui/utils/text-formatting.js";
import { type Mode, parseArgs } from "./cli/args.js";
import {
	EXEC_SESSION_SUMMARY_PREFIX,
	runExecCommand,
} from "./cli/commands/exec.js";
import {
	isHeadlessModeRequested,
	recordHeadlessRuntimeSelection,
	selectHeadlessRuntime,
	willDispatchHeadlessRuntime,
} from "./cli/headless-runtime-selection.js";
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
import {
	detectRuntimeConstraintContext,
	resolveExplicitSystemPromptSourcePaths,
} from "./cli/system-prompt.js";
import { validateFrameworkPreference } from "./config/framework.js";
import { loadRuntimeConfig } from "./config/runtime-config.js";
import { loadUnifiedContextManifest } from "./context/manifest.js";
import { loadEnv } from "./load-env.js";
import { bootstrapLsp } from "./lsp/bootstrap.js";
import { withMcpPostKeepMessages } from "./mcp/prompt-recovery.js";
import {
	createAutomaticMemoryConsolidationCoordinator,
	getMemoryConsolidationSystemPrompt,
} from "./memory/auto-consolidation.js";
import {
	createAutomaticMemoryExtractionCoordinator,
	getMemoryExtractionSystemPrompt,
} from "./memory/auto-extraction.js";
import { ensureModelsLoaded } from "./models/builtin.js";
import type { RegisteredModel } from "./models/registry.js";
import { reloadModelConfig } from "./models/registry.js";
import { initOpenTelemetry } from "./opentelemetry.js";
import { resolveMaestroSystemPrompt } from "./prompts/system-prompt.js";
import type { AuthMode } from "./providers/auth.js";
import { AgentRuntimeController } from "./runtime/agent-runtime.js";
import { registerBackgroundTaskShutdownHooks } from "./runtime/background-task-hooks.js";
import { configureSafeMode } from "./safety/safe-mode.js";
import { LocalSandbox } from "./sandbox/index.js";
import { captureSentryException, flushSentry, initSentry } from "./sentry.js";
import { ServerRequestActionApprovalService } from "./server/approval-service.js";
import { clientToolService } from "./server/client-tools-service.js";
import { ServerRequestToolRetryService } from "./server/tool-retry-service.js";
import { SessionManager } from "./session/manager.js";
import { recordStagedRolloutSurfaceUsage } from "./telemetry.js";
import { beaconTimeoutMs } from "./telemetry/beacon.js";
import { askUserClientTool } from "./tools/ask-user-client.js";
import type { UpdateCheckResult } from "./update/check.js";
import { createStartupProfilerFromEnv } from "./utils/checkpoint-profiler.js";
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
const STARTUP_TELEMETRY_EXIT_WAIT_GRACE_MS = 25;

let enterpriseCleanupRegistered = false;
let checkpointCleanupRegistered = false;
let sandboxCleanupRegistered = false;

function printAllAgentModes(): void {
	const lines = ["Agent modes:", ""];
	for (const { mode, config } of getAllModes({ includeHidden: true })) {
		const hiddenSuffix = config.visible === false ? " [hidden]" : "";
		lines.push(`${mode}${hiddenSuffix}`);
		lines.push(`  ${config.description}`);
		lines.push(`  model: ${getModelForMode(mode)}`);
	}
	console.log(lines.join("\n"));
}

/**
 * Configuration options passed to the interactive TUI renderer.
 * These options customize the startup experience shown to users.
 */
interface InteractiveOptions {
	clientToolService?: TuiClientToolService;
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

	let sessionEndReason: "user_exit" | "error" = "user_exit";
	try {
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
	} catch (error) {
		sessionEndReason = "error";
		throw error;
	} finally {
		await applySessionEndHooks({
			agent,
			sessionManager,
			cwd: process.cwd(),
			reason: sessionEndReason,
		});
	}
}

async function waitForStartupTelemetryForImmediateExit(
	startupTelemetry: Promise<void>,
): Promise<void> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			startupTelemetry,
			new Promise<void>((resolve) => {
				timeout = setTimeout(
					resolve,
					beaconTimeoutMs(process.env) + STARTUP_TELEMETRY_EXIT_WAIT_GRACE_MS,
				);
			}),
		]);
	} catch {
		// Startup telemetry is best effort and must not affect explicit exits.
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
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

	let sessionEndReason: "complete" | "error" = "complete";
	try {
		// Process each message sequentially
		// This allows multi-message conversations in single-shot mode
		for (const message of messages) {
			if (jsonlWriter) {
				emitUserTurnEvent(jsonlWriter, nextTurnId, message);
			}
			await runUserPromptWithRecovery({
				agent,
				sessionManager,
				cwd: process.cwd(),
				prompt: message,
				execute: () => agent.prompt(message),
				getPostKeepMessages: withMcpPostKeepMessages(),
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
		sessionEndReason = "error";
		// Ensure error is recorded in JSONL output for machine processing
		if (jsonlWriter) {
			emitThreadEnd(jsonlWriter, threadId, "error", threadId);
		}
		throw error;
	} finally {
		await applySessionEndHooks({
			agent,
			sessionManager,
			cwd: process.cwd(),
			reason: sessionEndReason,
		});
	}
}

function resolveSessionStartHookSource(params: {
	mode: Mode;
	command?: string;
	isInteractive: boolean;
	headless?: boolean;
	shouldRestoreSession?: boolean;
}): string {
	if (params.shouldRestoreSession) {
		return "resume";
	}
	if (params.command === "exec") {
		return "exec";
	}
	if (params.mode === "rpc") {
		return "rpc";
	}
	if (params.mode === "headless" || params.headless) {
		return "headless";
	}
	if (params.isInteractive) {
		return "interactive";
	}
	return "cli";
}

async function readReplayScenarioId(source: string): Promise<string> {
	try {
		return (await loadScriptedScenarioFromSource(source)).id;
	} catch {
		// The scripted provider surfaces schema and file errors during streaming.
	}
	return scenarioSourceLabel(source);
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
	const startupProfiler = createStartupProfilerFromEnv();
	startupProfiler.checkpoint("process:start");

	// Parse arguments early to check for version/help flags before heavy initialization
	const parsed = parseArgs(args);
	startupProfiler.checkpoint("cli:parsed");
	const startupTelemetry = import("./telemetry/cli-startup.js")
		.then(({ recordCliStartupTelemetry }) =>
			recordCliStartupTelemetry({
				args: parsed,
				clientVersion: VERSION,
				commandCountLockTimeoutMs: 0,
				rawArgs: args,
			}),
		)
		.catch(() => undefined);

	// Handle --version early exit (before any async operations)
	if (parsed.version) {
		console.log(`Maestro v${VERSION}`);
		await waitForStartupTelemetryForImmediateExit(startupTelemetry);
		process.exit(0);
	}

	// Handle --help early exit (before any logging redirection or heavy init)
	if (parsed.help) {
		const hiddenFlagTelemetry = parsed.helpHidden
			? recordStagedRolloutSurfaceUsage("hidden_flag_used", {
					surfaceId: "cli:--help-hidden",
					surfaceType: "cli_flag",
					owner: "platform-cli",
				})
			: Promise.resolve();
		printHelp(VERSION, { includeHidden: parsed.helpHidden });
		await waitForStartupTelemetryForImmediateExit(
			Promise.all([startupTelemetry, hiddenFlagTelemetry]).then(
				() => undefined,
			),
		);
		process.exit(0);
	}

	if (parsed.listModesAll) {
		const hiddenFlagTelemetry = recordStagedRolloutSurfaceUsage(
			"hidden_flag_used",
			{
				surfaceId: "cli:--list-modes-all",
				surfaceType: "cli_flag",
				owner: "agent-runtime",
			},
		);
		printAllAgentModes();
		await waitForStartupTelemetryForImmediateExit(
			Promise.all([startupTelemetry, hiddenFlagTelemetry]).then(
				() => undefined,
			),
		);
		process.exit(0);
	}

	if (parsed.error) {
		console.error(chalk.red(parsed.error));
		await waitForStartupTelemetryForImmediateExit(startupTelemetry);
		process.exit(1);
	}

	const isHeadlessMode = isHeadlessModeRequested(parsed);
	const willDispatchHeadlessMode = willDispatchHeadlessRuntime(parsed);

	const exitWithEarlyStartupError = (error: unknown): never => {
		const message = error instanceof Error ? error.message : String(error);
		if (isHeadlessMode) {
			process.stdout.write(
				`${JSON.stringify({
					type: "error",
					message: `Headless startup failed: ${message}`,
					fatal: true,
					error_type: "fatal",
				})}\n`,
			);
		} else {
			console.error(chalk.red(message));
		}
		process.exit(1);
	};

	try {
		validateCodexFlags(args, parsed.help ? "help" : parsed.command);
	} catch (error) {
		exitWithEarlyStartupError(error);
	}

	const replayScenarioPath =
		parsed.replayScenarioPath ?? process.env.MAESTRO_SCENARIO_PATH;
	if (replayScenarioPath) {
		parsed.replayScenarioPath = replayScenarioPath;
		process.env.MAESTRO_SCENARIO_PATH = replayScenarioPath;
		process.env.MAESTRO_SCENARIO_ID =
			await readReplayScenarioId(replayScenarioPath);
		process.env.MAESTRO_MODE = "replay";
		parsed.provider = "scripted-replay";
		parsed.model = "maestro-replay-v1";
	}

	// Handle `maestro hosted-runner` before importing web-server so hosted
	// defaults are visible to its module-level runtime profile.
	if (parsed.command === "hosted-runner") {
		const { handleHostedRunnerCommand } = await import(
			"./cli/commands/hosted-runner.js"
		);
		await handleHostedRunnerCommand(parsed.commandArgs ?? [], {
			defaultPort: parsed.port,
		});
		return;
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
		const { migrate } = await import("./db/migrate.js");
		const port =
			parsed.port ?? (Number.parseInt(process.env.PORT || "8080", 10) || 8080);
		await migrate();
		await startWebServer(port, { skipStartupMigration: true });
		return;
	}

	// Bootstrap/status commands need stdout to stay under their direct control.
	// In particular, `maestro init --json` must be parseable JSON with any
	// progress or diagnostic output on stderr, so route it before config loading
	// can emit normal CLI startup logs.
	if (parsed.command === "init") {
		const { handleInitCommand } = await import("./cli/commands/init.js");
		await handleInitCommand(parsed.commandArgs ?? []);
		return;
	}

	if (parsed.command === "status") {
		const { handleStatusCommand } = await import("./cli/commands/status.js");
		await handleStatusCommand();
		return;
	}

	if (parsed.command === "context") {
		const { handleContextCommand } = await import("./cli/commands/context.js");
		await handleContextCommand(parsed.subcommand, parsed.messages, {
			json: parsed.execJson,
			liveMcp: parsed.contextLiveMcp,
		});
		return;
	}

	if (parsed.command === "scenario") {
		const { handleScenarioCommand } = await import(
			"./cli/commands/scenario.js"
		);
		await handleScenarioCommand(parsed.subcommand, parsed.messages, {
			json: parsed.execJson,
			junitPath: parsed.junitPath,
		});
		return;
	}

	// If we're about to enter interactive TUI mode (no prompt messages and not RPC/exec),
	// or headless mode (stdout is JSON-only), redirect all logging/console output to a file.
	// This must run before config/model loading to catch any early warnings.
	const isLikelyInteractiveTui =
		!parsed.messages.length &&
		(parsed.mode === "text" || parsed.mode === undefined) &&
		parsed.command === undefined;
	if (isLikelyInteractiveTui || willDispatchHeadlessMode) {
		const {
			redirectLoggerToFile,
			redirectConsoleToLogger,
			redirectStderrToLogger,
			pipeProcessEventsToLogger,
		} = await import("./utils/logger.js");
		redirectLoggerToFile();
		redirectConsoleToLogger({ preserveErrorStderr: willDispatchHeadlessMode });
		if (!willDispatchHeadlessMode) {
			redirectStderrToLogger();
		}
		pipeProcessEventsToLogger();
	}

	const headlessRuntimeSelection = selectHeadlessRuntime(process.env, {
		allowLegacy: willDispatchHeadlessMode,
	});
	recordHeadlessRuntimeSelection(headlessRuntimeSelection);

	const runtimeConfig = loadRuntimeConfig(parsed, process.cwd());
	startupProfiler.checkpoint("config:loaded");
	const reasoningSummary =
		runtimeConfig.config.model_supports_reasoning_summaries === false
			? undefined
			: runtimeConfig.config.model_reasoning_summary === "none"
				? null
				: runtimeConfig.config.model_reasoning_summary;
	const exitWithStartupError = async (error: unknown): Promise<never> => {
		const message = error instanceof Error ? error.message : String(error);
		const stack = error instanceof Error ? error.stack : undefined;
		if (isHeadlessMode) {
			process.stdout.write(
				`${JSON.stringify({
					type: "error",
					message: `Headless startup failed: ${message}`,
					fatal: true,
					error_type: "fatal",
				})}\n`,
			);
			process.stderr.write(`${stack ?? message}\n`);
		} else {
			console.error(chalk.red(message));
		}
		captureSentryException(error);
		await flushSentry();
		process.exit(1);
	};

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 1: Environment and Telemetry Initialization
	// ─────────────────────────────────────────────────────────────────────────────

	// Initialize OpenTelemetry tracing for observability
	// This is non-blocking (void) to avoid startup latency
	void initOpenTelemetry("composer-cli");
	initSentry("maestro-cli");

	const modelLoadPromise = (async () => {
		await ensureModelsLoaded();
		startupProfiler.checkpoint("models:loaded");
	})();
	const enterpriseContextPromise = (async () => {
		const { enterpriseContext } = await import("./enterprise/context.js");
		await enterpriseContext.initialize();
		startupProfiler.checkpoint("enterprise:initialized");
		return enterpriseContext;
	})();

	// Pre-load model registry and enterprise context in parallel. These are
	// independent startup costs, so overlapping them reduces cold-start latency.
	const [enterpriseContext] = await Promise.all([
		enterpriseContextPromise,
		modelLoadPromise,
	]);
	startupProfiler.checkpoint("bootstrap:parallel");

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

	const { requireCredential } = createAuthSetup({
		authMode,
		explicitApiKey: parsed.apiKey,
	});
	startupProfiler.checkpoint("auth:configured");

	if (parsed.command === "exec") {
		if (parsed.execFullAuto && parsed.execReadOnly) {
			await exitWithStartupError(
				"Cannot combine --full-auto with --read-only in maestro exec.",
			);
		}
	}

	// Validate sandbox mode (applies to both exec and interactive modes)
	const validSandboxModes = [
		"docker",
		"local",
		"native",
		"none",
		"read-only",
		"workspace-write",
		"danger-full-access",
	];
	if (parsed.sandbox && !validSandboxModes.includes(parsed.sandbox)) {
		await exitWithStartupError(
			`Unknown sandbox mode "${parsed.sandbox}". Supported: ${validSandboxModes.join(", ")}`,
		);
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
	startupProfiler.checkpoint("runtime:prepared");

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

	if (parsed.command === "evalops") {
		const { handleEvalOpsCommand } = await import("./cli/commands/evalops.js");
		await handleEvalOpsCommand(parsed.subcommand, parsed.commandArgs ?? []);
		return;
	}

	if (parsed.command === "codex") {
		const { handleCodexCommand } = await import("./cli/commands/codex.js");
		await handleCodexCommand(parsed.subcommand, parsed.commandArgs ?? []);
		return;
	}

	if (parsed.command === "hooks") {
		const { handleHooksCommand } = await import("./cli/commands/hooks.js");
		await handleHooksCommand(parsed.subcommand);
		return;
	}

	if (parsed.command === "run") {
		const { handleRunCommand } = await import("./cli/commands/run.js");
		await handleRunCommand(parsed.subcommand, parsed.messages, {
			json: parsed.execJson,
		});
		return;
	}

	if (parsed.command === "export") {
		const { handleExportCommand } = await import(
			"./cli/commands/session-transfer.js"
		);
		await handleExportCommand(
			parsed.messages[0],
			parsed.messages[1],
			parsed.exportFormat,
			{ redactSecrets: parsed.redactSecrets },
		);
		return;
	}

	if (parsed.command === "import") {
		const { handleImportCommand } = await import(
			"./cli/commands/session-transfer.js"
		);
		await handleImportCommand(parsed.messages[0]);
		return;
	}

	if (parsed.command === "memory") {
		const { handleMemoryCommand } = await import("./cli/commands/memory.js");
		await handleMemoryCommand(parsed.subcommand, parsed.messages);
		return;
	}

	if (parsed.command === "remote") {
		const { handleRemoteCommand } = await import("./cli/commands/remote.js");
		await handleRemoteCommand(parsed.subcommand, parsed.commandArgs ?? []);
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

	if (parsed.command === "stats") {
		const { handleStatsCommand } = await import("./cli/commands/stats.js");
		switch (parsed.subcommand) {
			case undefined:
			case "today":
			case "yesterday":
			case "week":
			case "7d":
			case "month":
			case "30d":
			case "all":
				await handleStatsCommand(parsed.subcommand, {
					sessionId: parsed.session,
					format: parsed.exportFormat,
				});
				return;
			default:
				console.error(
					chalk.red(`Unknown stats subcommand: ${parsed.subcommand}`),
				);
				console.log(chalk.dim("\nAvailable commands:"));
				console.log(
					chalk.dim("  maestro stats              - Show last 7 days"),
				);
				console.log(
					chalk.dim("  maestro stats --session <id> - Show one session"),
				);
				console.log(chalk.dim("  maestro stats today        - Show today"));
				console.log(
					chalk.dim("  maestro stats month        - Show last 30 days"),
				);
				console.log(chalk.dim("  maestro stats all          - Show all time"));
				console.log(
					chalk.dim("  maestro stats --format json|csv - Export usage data"),
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

	const quoteShellArg = (value: string): string => {
		if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
			return value;
		}
		if (process.platform === "win32") {
			const escaped = value
				.replace(
					/(\\*)"/g,
					(_match, slashes: string) => `${slashes}${slashes}\\"`,
				)
				.replace(/\\+$/g, (slashes) => `${slashes}${slashes}`);
			return `"${escaped}"`;
		}
		return `'${value.replaceAll("'", "'\\''")}'`;
	};
	const buildAgentsInitRerunCommand = (
		targetArg: string | undefined,
	): string =>
		targetArg
			? `maestro agents init ${quoteShellArg(targetArg)} --force`
			: "maestro agents init --force";

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
			const result = handleAgentsInit(targetArg, { force: parsed.force });
			if (result.action === "preview") {
				const rerunCommand = buildAgentsInitRerunCommand(targetArg);
				console.log(
					[
						`AGENTS instructions already exist at ${result.path}.`,
						`Preview the proposed update below, then re-run with \`${rerunCommand}\` to apply it.`,
						"",
						sanitizeTerminalPreview(result.diff ?? ""),
					].join("\n"),
				);
				return;
			}
			if (result.action === "updated") {
				console.log(`Updated AGENTS instructions at ${result.path}.`);
				return;
			}
			agentsInitPath = result.path;
			agentsInitPrompt = buildAgentsInitPrompt(result.path, result.sources);
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
	let scenarioRecorder:
		| import("./server/scenario-recorder.js").ScriptedScenarioRecorder
		| undefined;
	if (parsed.recordScenarioPath) {
		const { ScriptedScenarioRecorder } = await import(
			"./server/scenario-recorder.js"
		);
		scenarioRecorder = new ScriptedScenarioRecorder({
			outPath: parsed.recordScenarioPath,
			recordedFrom: () => sessionManager.getSessionId(),
		});
	}
	startupProfiler.checkpoint("session:created");

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

	let model!: Model<Api>;
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
		await exitWithStartupError(error);
	}
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
		: new PlatformBackedActionApprovalService(approvalModeOverride, {
				sessionIdProvider: () => sessionManager.getSessionId() ?? undefined,
			});
	const headlessClientToolService = isHeadlessMode
		? clientToolService.forSession(
				() => sessionManager.getSessionId() ?? undefined,
			)
		: undefined;
	const interactiveClientToolService =
		isInteractiveTui && !isHeadlessMode
			? new TuiClientToolService()
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

	let toolsResult!: Awaited<
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
		await exitWithStartupError(error);
	}
	const { allTools, sandbox, sandboxMode } = toolsResult;
	startupProfiler.checkpoint("tools:prepared", { tools: allTools.length });
	const useInteractiveClientTools = Boolean(interactiveClientToolService);
	const replaceAskUserTool = <T extends typeof allTools>(tools: T): T =>
		tools.map((tool) =>
			tool.name === "ask_user" ? askUserClientTool : tool,
		) as T;
	const configuredAllTools = useInteractiveClientTools
		? replaceAskUserTool(allTools)
		: allTools;

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 11: System Prompt Assembly
	// ─────────────────────────────────────────────────────────────────────────────

	// Build the system prompt with project context after sandbox setup so runtime
	// constraint fragments reflect the resolved sandbox state, not just the
	// requested CLI mode.
	const resolvedConstraintSandboxMode = sandbox
		? sandbox instanceof LocalSandbox
			? "local"
			: (sandboxMode ?? null)
		: "none";
	const systemPromptToolNames = parsed.tools;
	const runtimeConstraints = detectRuntimeConstraintContext({
		cwd: process.cwd(),
		sandboxMode: resolvedConstraintSandboxMode,
		sandboxEnabled:
			Boolean(sandbox) && resolvedConstraintSandboxMode !== "local",
		readOnly: parsed.execReadOnly || parsed.readonly ? true : undefined,
	});
	const { systemPrompt, promptMetadata, promptContextManifest } =
		await resolveMaestroSystemPrompt({
			customPrompt: parsed.systemPrompt,
			toolNames: systemPromptToolNames,
			appendPrompt: parsed.appendSystemPrompt,
			runtimeConstraints,
			cwd: process.cwd(),
		});
	const unifiedContextManifest = loadUnifiedContextManifest(process.cwd(), {
		projectDocs: promptContextManifest,
	});
	startupProfiler.checkpoint("prompt:assembled", {
		system_bytes: systemPrompt.length,
	});
	const systemPromptSourcePaths = resolveExplicitSystemPromptSourcePaths(
		parsed.systemPrompt,
		parsed.appendSystemPrompt,
	);
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
	// PHASE 12: Agent Creation
	// ─────────────────────────────────────────────────────────────────────────────

	const { createAgentInstance } = await import(
		"./bootstrap/agent-creation-setup.js"
	);
	const { setTaskBudgetTotal } = await import("./agent/task-budget-access.js");
	const enterpriseUser = (() => {
		const u = enterpriseContext.getUser();
		return u ? { id: u.userId, orgId: u.orgId } : undefined;
	})();
	const { agent } = createAgentInstance({
		systemPrompt,
		promptMetadata,
		systemPromptSourcePaths,
		promptContextManifest,
		unifiedContextManifest,
		model,
		reasoningSummary,
		allTools: configuredAllTools,
		sandbox,
		sandboxMode: sandboxMode ?? null,
		approvalService,
		toolRetryService,
		clientToolService:
			headlessClientToolService ?? interactiveClientToolService,
		requireCredential,
		enterpriseUser,
		readonly: parsed.readonly,
		composer: parsed.composer,
		cwd: process.cwd(),
	});
	setTaskBudgetTotal(agent, parsed.taskBudget);
	startupProfiler.checkpoint("agent:ready");

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
		baseTools: configuredAllTools,
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 12: MCP (Model Context Protocol) Integration
	// ─────────────────────────────────────────────────────────────────────────────

	const { initializeMcpServers } = await import("./bootstrap/mcp-setup.js");
	initializeMcpServers({
		agent,
		baseTools: configuredAllTools,
		cwd: process.cwd(),
	});
	startupProfiler.checkpoint("mcp:bootstrap_queued");

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

	await applySessionStartHooks({
		agent,
		sessionManager,
		cwd: process.cwd(),
		source: resolveSessionStartHookSource({
			mode,
			command: parsed.command,
			isInteractive,
			headless: parsed.headless,
			shouldRestoreSession,
		}),
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 14.5: Event Subscriptions
	// ─────────────────────────────────────────────────────────────────────────────

	const { setupEventSubscriptions } = await import(
		"./bootstrap/event-subscriptions-setup.js"
	);
	const automaticMemoryConsolidation =
		createAutomaticMemoryConsolidationCoordinator({
			createAgent: async () =>
				createBackgroundTextAgent({
					model: agent.state.model as Model<Api>,
					systemPrompt: getMemoryConsolidationSystemPrompt(),
					cwd: process.cwd(),
					getAuthContext: (provider) => requireCredential(provider, false),
				}),
			getModel: () => agent.state.model as Model<Api>,
		});
	const automaticMemoryExtraction = createAutomaticMemoryExtractionCoordinator({
		createAgent: async () =>
			createBackgroundTextAgent({
				model: agent.state.model as Model<Api>,
				systemPrompt: getMemoryExtractionSystemPrompt(),
				cwd: process.cwd(),
				getAuthContext: (provider) => requireCredential(provider, false),
			}),
		getModel: () => agent.state.model as Model<Api>,
		onProcessed: () => automaticMemoryConsolidation.schedule(),
		sessionManager,
	});
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
		automaticMemoryExtraction,
		scenarioReplay:
			parsed.replayScenarioPath && process.env.MAESTRO_SCENARIO_ID
				? {
						path: scenarioSourceLabel(parsed.replayScenarioPath),
						scenarioId: process.env.MAESTRO_SCENARIO_ID,
					}
				: undefined,
		scenarioRecorder,
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
	try {
		if (agentsInitPrompt) {
			startupProfiler.terminal("exec:ready", { mode: "agents" });
			const cwd = process.cwd();
			const targetPath = agentsInitPath ?? "AGENTS.md";
			const displayPath =
				targetPath.startsWith(cwd) && targetPath !== cwd
					? `.${targetPath.slice(cwd.length)}`
					: targetPath;
			const runMode: Extract<Mode, "text" | "json"> =
				mode === "rpc" || mode === "headless" ? "text" : mode;
			console.log(chalk.green(`Drafting AGENTS.md at ${displayPath}...`));
			await runSingleShotMode(
				agent,
				sessionManager,
				[agentsInitPrompt],
				runMode,
			);
			console.log(chalk.dim(`AGENTS.md generated at ${displayPath}`));
		} else if (mode === "headless" || parsed.headless) {
			// Headless mode - for native TUI communication
			startupProfiler.terminal("headless:ready");
			await runHeadlessMode(
				agent,
				sessionManager,
				approvalService,
				toolRetryService,
				{ runtimeSelection: headlessRuntimeSelection },
			);
		} else if (mode === "rpc") {
			// RPC mode - headless operation
			startupProfiler.terminal("rpc:ready");
			const { runRpcMode } = await import("./cli/rpc-mode.js");
			await runRpcMode(agent, sessionManager);
		} else if (isInteractive) {
			// No messages and not RPC - use TUI
			startupProfiler.terminal("ui:ready");
			await runInteractiveMode(
				agent,
				sessionManager,
				VERSION,
				approvalService,
				toolRetryService,
				parsed.apiKey,
				{
					clientToolService: interactiveClientToolService,
					modelScope: scopedModels,
					startupChangelogSummary,
					updateNotice,
				},
			);
		} else if (parsed.command === "exec") {
			startupProfiler.terminal("exec:ready");
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
			startupProfiler.terminal("cli:ready");
			await runSingleShotMode(agent, sessionManager, parsed.messages, mode);
		}
	} finally {
		await automaticMemoryExtraction.flush();
		await automaticMemoryConsolidation.flush();
	}
}
