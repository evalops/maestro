/**
 * Main Entry Point - Maestro CLI Application
 *
 * This module orchestrates the complete initialization sequence for the Maestro CLI,
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
 *    ├── Determine auth mode (auto or api-key)
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

import chalk from "chalk";
import type {
	ActionApprovalService,
	ApprovalMode,
} from "./agent/action-approval.js";
import type { Agent, Api, Model } from "./agent/index.js";
import { applySessionStartHooks } from "./agent/session-start-hooks.js";
import { type ToolRetryMode, ToolRetryService } from "./agent/tool-retry.js";
import type { ClientToolExecutionService } from "./agent/transport.js";
import { PlatformBackedActionApprovalService } from "./approvals/platform-action-approval.js";
import { createAuthSetup, validateCodexFlags } from "./bootstrap/auth-setup.js";
import {
	disposeCheckpointService,
	initCheckpointService,
} from "./checkpoints/index.js";
import { type Mode, parseArgs } from "./cli/args.js";
import { EXEC_SESSION_SUMMARY_PREFIX } from "./cli/commands/exec-constants.js";
import {
	isHeadlessModeRequested,
	recordHeadlessRuntimeSelection,
	selectHeadlessRuntime,
	willDispatchHeadlessRuntime,
} from "./cli/headless-runtime-selection.js";
import { printHelp } from "./cli/help.js";
import {
	buildNativeHostedRunnerArgs,
	launchNativeCli,
	launchNativeTui,
	shouldLaunchNativeHeadless,
	shouldLaunchNativeInteractiveTui,
	shouldLaunchNativePrint,
} from "./cli/native-tui-launcher.js";
import { detectRuntimeConstraintContext } from "./cli/system-prompt.js";
import { validateFrameworkPreference } from "./config/framework.js";
import type { ComposerConfig } from "./config/index.js";
import {
	buildCliConfigOverrides,
	loadRuntimeConfig,
} from "./config/runtime-config.js";
import { loadAndFinalizeEnv } from "./load-env.js";
import { bootstrapLsp } from "./lsp/bootstrap.js";
import type { McpConfig } from "./mcp/types.js";
import { createLazyAutoMemoryCoordinators } from "./memory/lazy-auto-memory.js";
import { ensureModelsLoaded } from "./models/builtin.js";
import { reloadModelConfig } from "./models/registry.js";
import { getPackageVersion } from "./package-metadata.js";
import { setConfiguredPackageRuntimeContext } from "./packages/runtime.js";
import { resolveMaestroSystemPrompt } from "./prompts/system-prompt.js";
import type { AuthMode } from "./providers/auth.js";
import { parseOptionalBoolean } from "./runtime/env.js";
import { defaultSettings } from "./runtime/settings.js";
import { configureSafeMode } from "./safety/safe-mode.js";
import type { SessionManager } from "./session/manager.js";
import { beaconTimeoutMs } from "./telemetry/beacon.js";
import { recordStagedRolloutSurfaceUsageLazy } from "./telemetry/staged-rollout-lazy.js";
import { createStartupProfilerFromEnv } from "./utils/checkpoint-profiler.js";
import { isInsideGitRepository } from "./utils/git.js";
const VERSION = getPackageVersion();
const STARTUP_TELEMETRY_EXIT_WAIT_GRACE_MS = 25;

let enterpriseCleanupRegistered = false;
let checkpointCleanupRegistered = false;
const sandboxCleanupRegistered = false;

async function cleanupNonInteractiveRuntimeResources(): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<"timeout">((resolve) => {
		timeout = setTimeout(() => resolve("timeout"), 5_000);
	});
	const cleanupPromise = (async (): Promise<"done"> => {
		try {
			const [{ mcpManager }, { lspManager }] = await Promise.all([
				import("./mcp/manager.js"),
				import("./lsp/manager.js"),
			]);
			await Promise.allSettled([
				mcpManager.disconnectAll(),
				lspManager.shutdownAll(),
			]);
		} catch {
			// Best-effort shutdown must not mask the command's original result.
		}
		return "done";
	})();
	try {
		await Promise.race([cleanupPromise, timeoutPromise]);
	} finally {
		void cleanupPromise.catch(() => undefined);
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	switch (value?.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		default:
			return false;
	}
}

function shouldStartOpenTelemetry(env: NodeJS.ProcessEnv): boolean {
	if (
		isTruthyEnvFlag(env.MAESTRO_INTERNAL_TELEMETRY_DISABLED) ||
		isTruthyEnvFlag(env.EVALOPS_INTERNAL_TELEMETRY_DISABLED)
	) {
		return false;
	}
	// Honor the same tri-state parse the substrate uses for
	// `MAESTRO_OTEL` (true/false/1/0, case-insensitive). Previously this
	// path only matched the literal "1" / "0", so `MAESTRO_OTEL=true`
	// silently fell through and OTel never started even though
	// `getOpenTelemetryStatus` reported it as opt-in.
	// Match `createRuntimeEnv`'s trim-then-parse so `MAESTRO_OTEL=" true"`
	// (leading whitespace) doesn't read as a different tri-state than the
	// substrate would resolve. Bugbot caught this divergence on PR #2784.
	const rawOtelFlag = env.MAESTRO_OTEL?.trim();
	const otelEnabled = parseOptionalBoolean(rawOtelFlag ? rawOtelFlag : null);
	if (otelEnabled === false) {
		return false;
	}
	if (otelEnabled === true) {
		return true;
	}
	const hasOtlpEndpoint = Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT);
	const hasExplicitExporter = [
		env.OTEL_TRACES_EXPORTER,
		env.OTEL_METRICS_EXPORTER,
		env.OTEL_LOGS_EXPORTER,
	].some((exporter) => exporter && exporter !== "none");
	return hasOtlpEndpoint || hasExplicitExporter;
}

function startObservability(env: NodeJS.ProcessEnv): void {
	if (shouldStartOpenTelemetry(env)) {
		void import("./opentelemetry.js")
			.then(({ initOpenTelemetry }) => initOpenTelemetry("composer-cli"))
			.catch(() => undefined);
	}
	if (env.SENTRY_DSN?.trim()) {
		void import("./sentry.js")
			.then(({ initSentry }) => initSentry("maestro-cli"))
			.catch(() => undefined);
	}
}

async function captureStartupError(error: unknown): Promise<void> {
	if (!process.env.SENTRY_DSN?.trim()) {
		return;
	}
	try {
		const { captureSentryException, flushSentry, initSentry } = await import(
			"./sentry.js"
		);
		initSentry("maestro-cli");
		captureSentryException(error);
		await flushSentry();
	} catch {
		// Startup error reporting is best-effort and must not mask the root error.
	}
}

async function printAllAgentModes(): Promise<void> {
	const { getAllModes, getModelForMode } = await import("./agent/modes.js");
	const lines = ["Agent modes:", ""];
	for (const { mode, config } of getAllModes({ includeHidden: true })) {
		const hiddenSuffix = config.visible === false ? " [hidden]" : "";
		lines.push(`${mode}${hiddenSuffix}`);
		lines.push(`  ${config.description}`);
		lines.push(`  model: ${getModelForMode(mode)}`);
	}
	console.log(lines.join("\n"));
}

function shouldRegisterBackgroundTaskShutdownHooks(
	command: ReturnType<typeof parseArgs>["command"],
	parsedTools: readonly string[] | undefined,
): boolean {
	if (command !== "exec") {
		return true;
	}
	if (!parsedTools || parsedTools.length === 0) {
		return true;
	}
	return (
		parsedTools.includes("bash") || parsedTools.includes("background_tasks")
	);
}

/**
 * Hand off interactive mode to the native maestro-tui binary (Rust agent).
 * Forwards only flags maestro-tui accepts and propagates the child exit code.
 */
async function runNativeInteractiveMode(
	parsed: {
		provider?: string;
		model?: string;
		apiKey?: string;
		continue?: boolean;
		resume?: boolean;
		worktree?: boolean | string;
		messages: string[];
	},
	writeError: (message: string) => void,
): Promise<never> {
	try {
		const exitCode = await launchNativeTui({
			parsed: {
				provider: parsed.provider,
				model: parsed.model,
				apiKey: parsed.apiKey,
				continue: parsed.continue,
				resume: parsed.resume,
				worktree: parsed.worktree,
				messages: parsed.messages,
			},
			cwd: process.cwd(),
			env: process.env,
		});
		process.exit(exitCode);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeError(message);
		process.exit(1);
	}
}

async function runNativePrintMode(
	parsed: {
		provider?: string;
		model?: string;
		apiKey?: string;
		messages: string[];
		mode?: string;
		execJson?: boolean;
		command?: string;
		execOutputSchema?: string;
		execOutputLast?: string;
	},
	writeError: (message: string) => void,
): Promise<never> {
	try {
		const json = parsed.mode === "json" || Boolean(parsed.execJson);
		const exitCode = await launchNativeTui({
			parsed: {
				provider: parsed.provider,
				model: parsed.model,
				apiKey: parsed.apiKey,
				print: true,
				json,
				outputLastMessage: parsed.execOutputLast,
				outputSchema: parsed.execOutputSchema,
				messages: parsed.messages,
			},
			cwd: process.cwd(),
			env: process.env,
		});
		process.exit(exitCode);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeError(message);
		process.exit(1);
	}
}

/**
 * Hand off headless/RPC protocol mode to native maestro-tui --headless.
 * Stdio is the headless protocol surface; do not bootstrap the TS agent.
 */
async function runNativeHeadlessMode(
	writeError: (message: string) => void,
): Promise<never> {
	try {
		const exitCode = await launchNativeTui({
			parsed: { headless: true, messages: [] },
			cwd: process.cwd(),
			env: process.env,
		});
		process.exit(exitCode);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Protocol clients expect JSON errors on stdout when possible.
		process.stdout.write(
			`${JSON.stringify({
				type: "error",
				message: `Headless startup failed: ${message}`,
				fatal: true,
				error_type: "fatal",
			})}\n`,
		);
		writeError(message);
		process.exit(1);
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
					beaconTimeoutMs(defaultSettings().telemetry) +
						STARTUP_TELEMETRY_EXIT_WAIT_GRACE_MS,
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

async function readReplayScenarioMetadata(
	source: string,
): Promise<{ scenarioId: string; sourceLabel: string }> {
	const { scenarioSourceLabel } = await import("./agent/scenario-source.js");
	const sourceLabel = scenarioSourceLabel(source);
	try {
		const { loadScriptedScenarioFromSource } = await import(
			"./agent/providers/scripted.js"
		);
		return {
			scenarioId: (await loadScriptedScenarioFromSource(source)).id,
			sourceLabel,
		};
	} catch {
		// The scripted provider surfaces schema and file errors during streaming.
	}
	return { scenarioId: sourceLabel, sourceLabel };
}

async function resolveConstraintSandboxMode(params: {
	sandbox: unknown;
	sandboxMode: string | undefined;
}): Promise<"none" | "local" | string | null> {
	if (!params.sandbox) {
		return "none";
	}
	const { LocalSandbox } = await import("./sandbox/local-sandbox.js");
	return params.sandbox instanceof LocalSandbox
		? "local"
		: (params.sandboxMode ?? null);
}

/**
 * Main entry point for the Maestro CLI application.
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
	const originalStderrWrite = process.stderr.write.bind(process.stderr) as (
		chunk: string,
	) => boolean;
	const writeStartupErrorToStderr = (message: string): void => {
		originalStderrWrite(message.endsWith("\n") ? message : `${message}\n`);
	};

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 0: Early Exit Checks (before any async initialization)
	// ─────────────────────────────────────────────────────────────────────────────

	// Load environment variables from .env files (project and user level),
	// scrub repo-controlled security overrides, then refresh RuntimeEnv.
	loadAndFinalizeEnv();
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
			? recordStagedRolloutSurfaceUsageLazy("hidden_flag_used", {
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
		const hiddenFlagTelemetry = recordStagedRolloutSurfaceUsageLazy(
			"hidden_flag_used",
			{
				surfaceId: "cli:--list-modes-all",
				surfaceType: "cli_flag",
				owner: "agent-runtime",
			},
		);
		await printAllAgentModes();
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

	if (parsed.command === "modes") {
		const { handleModesCommand } = await import("./cli/commands/modes.js");
		await handleModesCommand(parsed.subcommand, parsed.messages, {
			provider: parsed.provider,
			json: parsed.execJson,
		});
		await waitForStartupTelemetryForImmediateExit(startupTelemetry);
		return;
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
			writeStartupErrorToStderr(chalk.red(message));
		}
		process.exit(1);
	};

	try {
		validateCodexFlags(args, parsed.help ? "help" : parsed.command);
	} catch (error) {
		exitWithEarlyStartupError(error);
	}

	if (parsed.command === "codex") {
		const { handleCodexCommand } = await import("./cli/commands/codex.js");
		const commandArgs = [...(parsed.commandArgs ?? [])];
		if (parsed.subcommand === "login" && parsed.force) {
			commandArgs.push("--force");
		}
		await handleCodexCommand(parsed.subcommand, commandArgs);
		await waitForStartupTelemetryForImmediateExit(startupTelemetry);
		return;
	}

	const replayScenarioPath =
		parsed.replayScenarioPath ?? process.env.MAESTRO_SCENARIO_PATH;
	let scenarioReplay:
		| {
				path: string;
				scenarioId: string;
		  }
		| undefined;
	if (replayScenarioPath) {
		parsed.replayScenarioPath = replayScenarioPath;
		process.env.MAESTRO_SCENARIO_PATH = replayScenarioPath;
		const replayScenario = await readReplayScenarioMetadata(replayScenarioPath);
		process.env.MAESTRO_SCENARIO_ID = replayScenario.scenarioId;
		process.env.MAESTRO_MODE = "replay";
		parsed.provider = "scripted-replay";
		parsed.model = "maestro-replay-v1";
		scenarioReplay = {
			path: replayScenario.sourceLabel,
			scenarioId: replayScenario.scenarioId,
		};
	}

	// Hosted execution is owned by the native Rust runtime. Keep this before the
	// web-server import so the legacy TypeScript hosted server cannot bootstrap.
	if (parsed.command === "hosted-runner") {
		process.exit(
			await launchNativeCli(
				buildNativeHostedRunnerArgs(parsed.commandArgs ?? [], parsed.port),
				{ forwardSignals: true },
			),
		);
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

		const port =
			parsed.port ?? (Number.parseInt(process.env.PORT || "8080", 10) || 8080);
		const webRuntimeConfig = loadRuntimeConfig(parsed, process.cwd());
		if (parsed.profile) {
			process.env.MAESTRO_PROFILE = parsed.profile;
		}
		const { startWebServer } = await import("./web-server.js");
		const { migrate } = await import("./db/migrate.js");
		await migrate();
		await startWebServer(port, {
			profileName: webRuntimeConfig.explicitProfileName,
			cliOverrides: webRuntimeConfig.explicitCliOverrides,
			skipStartupMigration: true,
		});
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
		await waitForStartupTelemetryForImmediateExit(startupTelemetry);
		process.exit(await launchNativeCli(["status"]));
	}

	if (parsed.command === "mission") {
		const { handleMissionCommand } = await import("./cli/commands/mission.js");
		await handleMissionCommand(parsed.subcommand, parsed.messages, {
			json: parsed.execJson,
		});
		return;
	}

	if (parsed.command === "update") {
		const { handleUpdateCommand } = await import("./cli/commands/update.js");
		await handleUpdateCommand(parsed.commandArgs ?? []);
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

	if (parsed.command === "skill") {
		const { handleSkillCommand } = await import("./cli/commands/skill.js");
		const cliOverrides = buildCliConfigOverrides(parsed);
		const overrideProfile =
			typeof cliOverrides.profile === "string"
				? cliOverrides.profile
				: undefined;
		const profileName = parsed.profile ?? overrideProfile;
		await handleSkillCommand(parsed.subcommand, parsed.commandArgs ?? [], {
			profileName,
			cliOverrides,
		});
		return;
	}

	// Agent paths hand off to native maestro-tui before the TypeScript bootstrap.
	// Residual TS: web, config, skill, mission, and other utility subcommands.
	if (shouldLaunchNativeHeadless(parsed)) {
		await waitForStartupTelemetryForImmediateExit(startupTelemetry);
		await runNativeHeadlessMode(writeStartupErrorToStderr);
	}

	if (shouldLaunchNativeInteractiveTui(parsed)) {
		await waitForStartupTelemetryForImmediateExit(startupTelemetry);
		await runNativeInteractiveMode(parsed, writeStartupErrorToStderr);
	}

	if (shouldLaunchNativePrint(parsed)) {
		await waitForStartupTelemetryForImmediateExit(startupTelemetry);
		await runNativePrintMode(parsed, writeStartupErrorToStderr);
	}

	// If we're about to enter headless mode (stdout is JSON-only), redirect all
	// logging/console output to a file. This must run before config/model loading
	// to catch any early warnings. Keep error-level console on stderr so fatal
	// headless startup failures remain protocol-visible on stdout/stderr as designed.
	if (willDispatchHeadlessMode) {
		const {
			redirectLoggerToFile,
			redirectConsoleToLogger,
			pipeProcessEventsToLogger,
		} = await import("./utils/logger.js");
		redirectLoggerToFile();
		redirectConsoleToLogger({ preserveErrorStderr: true });
		pipeProcessEventsToLogger();
	}

	const headlessRuntimeSelection = selectHeadlessRuntime(process.env, {
		allowLegacy: willDispatchHeadlessMode,
	});
	recordHeadlessRuntimeSelection(headlessRuntimeSelection);

	const runtimeConfig = loadRuntimeConfig(parsed, process.cwd());
	setConfiguredPackageRuntimeContext(process.cwd(), {
		profileName: runtimeConfig.explicitProfileName,
		cliOverrides: runtimeConfig.explicitCliOverrides,
	});
	startupProfiler.checkpoint("config:loaded");
	const reasoningSummary =
		runtimeConfig.config.model_supports_reasoning_summaries === false
			? undefined
			: runtimeConfig.config.model_reasoning_summary === "none"
				? null
				: runtimeConfig.config.model_reasoning_summary;
	let earlyExecJsonThreadId: string | null = null;
	const exitWithStartupError = async (error: unknown): Promise<never> => {
		const message = error instanceof Error ? error.message : String(error);
		const stack = error instanceof Error ? error.stack : undefined;
		if (earlyExecJsonThreadId) {
			const { JsonlEventWriter, emitThreadEnd } = await import(
				"./cli/jsonl-writer.js"
			);
			const jsonlWriter = new JsonlEventWriter(true, process.stdout);
			const timestamp = new Date().toISOString();
			jsonlWriter.emit({
				type: "error",
				message,
				timestamp,
				stack,
			});
			emitThreadEnd(
				jsonlWriter,
				earlyExecJsonThreadId,
				"error",
				earlyExecJsonThreadId,
			);
			jsonlWriter.emit({
				type: "done",
				status: "error",
				timestamp: new Date().toISOString(),
				sessionId: earlyExecJsonThreadId,
			});
			earlyExecJsonThreadId = null;
		}
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
			writeStartupErrorToStderr(chalk.red(message));
		}
		await captureStartupError(error);
		process.exit(1);
	};
	const withExecJsonStartupCleanup = async <T>(
		operation: () => T | Promise<T>,
	): Promise<T> => {
		try {
			return await operation();
		} catch (error) {
			if (earlyExecJsonThreadId) {
				await exitWithStartupError(error);
			}
			throw error;
		}
	};

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 1: Environment and Telemetry Initialization
	// ─────────────────────────────────────────────────────────────────────────────

	// Initialize OpenTelemetry tracing for observability
	// This is non-blocking (void) to avoid startup latency
	startObservability(process.env);

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

	// Register shutdown hooks for background tasks only when the selected tool
	// set can start managed background work.
	const useBackgroundTaskShutdownHooks =
		shouldRegisterBackgroundTaskShutdownHooks(parsed.command, parsed.tools);
	if (useBackgroundTaskShutdownHooks) {
		const { registerBackgroundTaskShutdownHooks } = await import(
			"./runtime/background-task-hooks.js"
		);
		registerBackgroundTaskShutdownHooks();
	}

	// Bootstrap Language Server Protocol for IDE integration
	// This enables features like go-to-definition, hover info, and diagnostics
	await bootstrapLsp();

	// Initialize checkpointing service for undo/redo functionality
	// PreToolUse hooks capture file snapshots before tool execution
	initCheckpointService(process.cwd());
	const disposeCheckpoint = (): void => disposeCheckpointService();
	if (!checkpointCleanupRegistered) {
		const exitAfterCheckpointSignal = !useBackgroundTaskShutdownHooks;
		process.once("beforeExit", disposeCheckpoint);
		process.once("SIGINT", () => {
			disposeCheckpoint();
			if (exitAfterCheckpointSignal) {
				process.exit(130);
			}
		});
		process.once("SIGTERM", () => {
			disposeCheckpoint();
			if (exitAfterCheckpointSignal) {
				process.exit(0);
			}
		});
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

	if (parsed.command === "hooks") {
		await waitForStartupTelemetryForImmediateExit(startupTelemetry);
		process.exit(
			await launchNativeCli(["hooks", parsed.subcommand ?? "status"]),
		);
	}

	if (parsed.command === "run") {
		const { handleRunCommand } = await import("./cli/commands/run.js");
		await handleRunCommand(parsed.subcommand, parsed.messages, {
			json: parsed.execJson,
		});
		return;
	}

	if (parsed.command === "sessions") {
		const sub = parsed.subcommand ?? "list";
		const tokens = ["sessions", sub, ...parsed.messages];
		if (parsed.exportFormat) {
			tokens.push("--format", parsed.exportFormat);
		}
		await waitForStartupTelemetryForImmediateExit(startupTelemetry);
		process.exit(await launchNativeCli(tokens));
	}

	if (parsed.command === "export") {
		const tokens = ["export", ...parsed.messages];
		if (parsed.exportFormat) {
			tokens.push("--format", parsed.exportFormat);
		}
		await waitForStartupTelemetryForImmediateExit(startupTelemetry);
		process.exit(await launchNativeCli(tokens));
	}

	if (parsed.command === "import") {
		await waitForStartupTelemetryForImmediateExit(startupTelemetry);
		process.exit(await launchNativeCli(["import", ...parsed.messages]));
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

	if (parsed.command === "a2a") {
		const { handleA2ACommand } = await import("./cli/commands/a2a.js");
		await handleA2ACommand(parsed.commandArgs ?? []);
		return;
	}

	if (parsed.command === "operating-plane") {
		const { handleOperatingPlaneCommand } = await import(
			"./cli/commands/operating-plane.js"
		);
		await handleOperatingPlaneCommand(parsed.commandArgs ?? []);
		return;
	}

	if (parsed.command === "anthropic") {
		const { handleAnthropicCommand } = await import(
			"./cli/commands/anthropic.js"
		);
		await handleAnthropicCommand();
		return;
	}

	// Handle cost commands
	if (parsed.command === "painter") {
		const { handlePainterCommand } = await import("./cli/commands/painter.js");
		await handlePainterCommand(parsed.subcommand, parsed.commandArgs ?? []);
		return;
	}
	if (parsed.command === "cost") {
		const sub = parsed.subcommand ?? "today";
		if (
			sub === "today" ||
			sub === "yesterday" ||
			sub === "week" ||
			sub === "month" ||
			sub === "all" ||
			sub === "clear" ||
			sub === "breakdown" ||
			sub === undefined
		) {
			await waitForStartupTelemetryForImmediateExit(startupTelemetry);
			process.exit(await launchNativeCli(["cost", sub]));
		}
		console.error(chalk.red(`Unknown cost subcommand: ${parsed.subcommand}`));
		console.log(chalk.dim("\nAvailable commands:"));
		console.log(
			chalk.dim("  maestro cost [today]     - Show today's costs (default)"),
		);
		console.log(
			chalk.dim("  maestro cost yesterday   - Show yesterday's costs"),
		);
		console.log(chalk.dim("  maestro cost week        - Show last 7 days"));
		console.log(chalk.dim("  maestro cost month       - Show last 30 days"));
		console.log(chalk.dim("  maestro cost all         - Show all time costs"));
		console.log(chalk.dim("  maestro cost breakdown   - Detailed breakdown"));
		console.log(chalk.dim("  maestro cost clear       - Clear usage data"));
		process.exit(1);
	}

	if (parsed.command === "stats") {
		const tokens = ["stats"];
		if (parsed.subcommand) {
			tokens.push(parsed.subcommand);
		}
		if (parsed.exportFormat) {
			tokens.push("--format", parsed.exportFormat);
		}
		if (parsed.execJson) {
			tokens.push("--json");
		}
		if (parsed.session) {
			tokens.push("--session", parsed.session);
		}
		await waitForStartupTelemetryForImmediateExit(startupTelemetry);
		process.exit(await launchNativeCli(tokens));
	}

	if (parsed.command === "value") {
		const { handleValueCommand } = await import("./cli/commands/value.js");
		switch (parsed.subcommand) {
			case undefined:
			case "today":
			case "yesterday":
			case "week":
			case "7d":
			case "month":
			case "30d":
			case "all":
				await handleValueCommand(parsed.subcommand, {
					format: parsed.exportFormat,
					outputDir: parsed.outputDir,
					writeArtifacts: parsed.valueWrite,
				});
				return;
			default:
				console.error(
					chalk.red(`Unknown value subcommand: ${parsed.subcommand}`),
				);
				console.log(chalk.dim("\nAvailable commands:"));
				console.log(
					chalk.dim("  maestro value              - Show last 30 days"),
				);
				console.log(
					chalk.dim("  maestro value week         - Show last 7 days"),
				);
				console.log(
					chalk.dim("  maestro value all          - Show all local evidence"),
				);
				console.log(
					chalk.dim("  maestro value --format json|md - Export value report"),
				);
				console.log(
					chalk.dim(
						"  maestro value --write --output-dir .maestro/value-reports - Persist report artifacts",
					),
				);
				process.exit(1);
		}
	}

	// Handle models commands (native catalog)
	if (parsed.command === "models") {
		const tokens = ["models"];
		if (parsed.subcommand) {
			tokens.push(parsed.subcommand);
		}
		if (parsed.provider) {
			tokens.push("--provider", parsed.provider);
		}
		await waitForStartupTelemetryForImmediateExit(startupTelemetry);
		process.exit(await launchNativeCli(tokens));
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// PHASE 6: Special Command Handling (agents init)
	// ─────────────────────────────────────────────────────────────────────────────

	// Track agents init state for deferred execution
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
		const {
			buildAgentsInitPrompt,
			handleAgentsInit,
			handleAgentsProfileCommand,
		} = await import("./cli/commands/agents.js");
		if (parsed.subcommand === "profile") {
			try {
				handleAgentsProfileCommand(parsed.commandArgs ?? parsed.messages, {
					force: parsed.force,
					json: parsed.execJson,
				});
				return;
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Failed to manage specialist profile";
				console.error(chalk.red(message));
				process.exit(1);
			}
		}
		if (parsed.subcommand && parsed.subcommand !== "init") {
			console.error(
				chalk.red(
					`Unknown agents subcommand: ${parsed.subcommand}. Try "maestro agents init" or "maestro agents profile list"`,
				),
			);
			process.exit(1);
		}
		try {
			const agentsArgs = parsed.commandArgs ?? parsed.messages;
			const targetArg = agentsArgs[0];
			const result = handleAgentsInit(targetArg, { force: parsed.force });
			if (result.action === "preview") {
				const { sanitizeTerminalPreview } = await import(
					"./utils/terminal-text.js"
				);
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
			const agentsInitPrompt = buildAgentsInitPrompt(
				result.path,
				result.sources,
			);
			// Generate via native agent — no TypeScript Agent bootstrap.
			const cwd = process.cwd();
			const targetPath = result.path;
			const displayPath =
				targetPath.startsWith(cwd) && targetPath !== cwd
					? `.${targetPath.slice(cwd.length)}`
					: targetPath;
			console.log(chalk.green(`Drafting AGENTS.md at ${displayPath}...`));
			await waitForStartupTelemetryForImmediateExit(startupTelemetry);
			await runNativePrintMode(
				{
					provider: parsed.provider,
					model: parsed.model,
					apiKey: parsed.apiKey,
					messages: [agentsInitPrompt],
					mode: "text",
				},
				writeStartupErrorToStderr,
			);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Failed to initialize AGENTS.md";
			console.error(chalk.red(message));
			process.exit(1);
		}
	}

	// Native-only agent modes. TypeScript Agent bootstrap has been removed.
	// Utility commands already returned above. Hand off everything remaining
	// to maestro-tui (interactive / print / headless).
	await waitForStartupTelemetryForImmediateExit(startupTelemetry);

	// Scenario replay: exec/print stay on the native print path (smoke +
	// scripting). Interactive/headless/rpc still use headless protocol when
	// a scenario is attached without an exec/print surface.
	const replayForcesHeadless =
		Boolean(scenarioReplay) &&
		!shouldLaunchNativePrint(parsed) &&
		parsed.command !== "exec";

	if (shouldLaunchNativeHeadless(parsed) || replayForcesHeadless) {
		await runNativeHeadlessMode(writeStartupErrorToStderr);
	}
	if (shouldLaunchNativeInteractiveTui(parsed) && !scenarioReplay) {
		await runNativeInteractiveMode(parsed, writeStartupErrorToStderr);
	}
	if (
		shouldLaunchNativePrint(parsed) ||
		(parsed.messages.length > 0 &&
			(parsed.command === undefined || parsed.command === "exec")) ||
		(Boolean(scenarioReplay) && parsed.command === "exec")
	) {
		await runNativePrintMode(parsed, writeStartupErrorToStderr);
	}

	if (
		process.env.MAESTRO_ALLOW_TS_AGENT === "1" ||
		process.env.MAESTRO_ALLOW_TS_AGENT === "true"
	) {
		writeStartupErrorToStderr(
			[
				"MAESTRO_ALLOW_TS_AGENT is set, but the TypeScript Agent runtime has been removed.",
				"Use native maestro-tui for interactive, print/exec, and headless/rpc.",
			].join("\n"),
		);
		process.exit(1);
	}

	writeStartupErrorToStderr(
		[
			"No agent work requested, or this path is not implemented in the Node shim.",
			'Use `maestro` (native TUI), `maestro exec "…"`, or `maestro --headless`.',
			"Utility commands: config, web, skill, init, hosted-runner, …",
		].join("\n"),
	);
	process.exit(1);
}
