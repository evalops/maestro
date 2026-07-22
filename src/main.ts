/**
 * Main Entry Point - Maestro CLI Application
 *
 * Thin Node shim that loads env, parses CLI args, and hands agent work off to
 * the native `maestro-tui` binary (interactive, print/exec, headless/RPC).
 * Utility subcommands and hosted-runner also dispatch natively. The only
 * remaining TypeScript runtime path is `maestro web` (bundled web server).
 *
 * ## Startup flow
 *
 * ```
 * 1. loadAndFinalizeEnv + parseArgs
 * 2. Early exits: --version, --help, parse errors, list-modes-all
 * 3. validateCodexFlags
 * 4. Native utility commands → launchNativeCli
 * 5. Scenario env setup (optional)
 * 6. hosted-runner → launchNativeCli
 * 7. maestro web → TypeScript web server
 * 8. Interactive / print / headless → launchNativeTui
 * 9. Fallthrough → clear error (no TypeScript Agent bootstrap)
 * ```
 *
 * @module main
 */

import chalk from "chalk";
import { validateCodexFlags } from "./bootstrap/auth-setup.js";
import { parseArgs } from "./cli/args.js";
import { isNativeUtilityCommand } from "./cli/direct-runtime-command.js";
import { isHeadlessModeRequested } from "./cli/headless-runtime-selection.js";
import { printHelp } from "./cli/help.js";
import {
	buildNativeHostedRunnerArgs,
	launchNativeCli,
	launchNativeTui,
	shouldLaunchNativeHeadless,
	shouldLaunchNativeInteractiveTui,
	shouldLaunchNativePrint,
} from "./cli/native-tui-launcher.js";
import { loadRuntimeConfig } from "./config/runtime-config.js";
import { loadAndFinalizeEnv } from "./load-env.js";
import { getPackageVersion } from "./package-metadata.js";
import { parseOptionalBoolean } from "./runtime/env.js";
import { defaultSettings } from "./runtime/settings.js";
import { beaconTimeoutMs } from "./telemetry/beacon.js";
import { recordStagedRolloutSurfaceUsageLazy } from "./telemetry/staged-rollout-lazy.js";
import { createStartupProfilerFromEnv } from "./utils/checkpoint-profiler.js";

const VERSION = getPackageVersion();
const STARTUP_TELEMETRY_EXIT_WAIT_GRACE_MS = 25;

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
 * Prepare scenario-replay env vars for the native runtime.
 * Scenario file loading stays lazy so main import does not pull scripted providers.
 */
async function applyScenarioReplayEnv(source: string): Promise<void> {
	process.env.MAESTRO_SCENARIO_PATH = source;
	process.env.MAESTRO_MODE = "replay";
	try {
		const { scenarioSourceLabel } = await import("./agent/scenario-source.js");
		const sourceLabel = scenarioSourceLabel(source);
		try {
			const { loadScriptedScenarioFromSource } = await import(
				"./agent/providers/scripted.js"
			);
			process.env.MAESTRO_SCENARIO_ID = (
				await loadScriptedScenarioFromSource(source)
			).id;
		} catch {
			// The native runtime surfaces schema and file errors during streaming.
			process.env.MAESTRO_SCENARIO_ID = sourceLabel;
		}
	} catch {
		process.env.MAESTRO_SCENARIO_ID = source;
	}
}

/**
 * Main entry point for the Maestro CLI application.
 *
 * Parses arguments, dispatches native utility / hosted-runner / web paths, and
 * hands agent modes to maestro-tui. There is no TypeScript Agent bootstrap.
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
		const exitCode = await launchNativeCli([
			"modes",
			"list",
			"--list-modes-all",
		]);
		await waitForStartupTelemetryForImmediateExit(startupTelemetry);
		process.exit(exitCode);
	}

	if (parsed.error) {
		console.error(chalk.red(parsed.error));
		await waitForStartupTelemetryForImmediateExit(startupTelemetry);
		process.exit(1);
	}

	const isHeadlessMode = isHeadlessModeRequested(parsed);

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

	if (isNativeUtilityCommand(parsed.command)) {
		// Utility commands own their complete lifecycle in Rust. Keep this handoff
		// ahead of replay setup so inherited scenario state cannot bootstrap the
		// TypeScript runtime or change a utility command's behavior. Direct dispatch
		// intentionally falls back here when startup telemetry is configured.
		startObservability(process.env);
		await waitForStartupTelemetryForImmediateExit(startupTelemetry);
		process.exit(await launchNativeCli(args));
	}

	const replayScenarioPath =
		parsed.replayScenarioPath ?? process.env.MAESTRO_SCENARIO_PATH;
	if (replayScenarioPath) {
		parsed.replayScenarioPath = replayScenarioPath;
		// Native maestro-tui reads scenario path / id from the environment.
		await applyScenarioReplayEnv(replayScenarioPath);
		parsed.provider = "scripted-replay";
		parsed.model = "maestro-replay-v1";
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

	// Native-only agent modes. TypeScript Agent bootstrap has been removed.
	await waitForStartupTelemetryForImmediateExit(startupTelemetry);

	if (shouldLaunchNativeHeadless(parsed)) {
		await runNativeHeadlessMode(writeStartupErrorToStderr);
	}

	if (shouldLaunchNativeInteractiveTui(parsed)) {
		await runNativeInteractiveMode(parsed, writeStartupErrorToStderr);
	}

	if (shouldLaunchNativePrint(parsed)) {
		await runNativePrintMode(parsed, writeStartupErrorToStderr);
	}

	// Fallthrough: nothing matched a native handoff or web.
	writeStartupErrorToStderr(
		[
			"No agent work requested, or this path is not implemented in the Node shim.",
			'Use `maestro` (native TUI), `maestro exec "…"`, or `maestro --headless`.',
			"Utility commands: web, hosted-runner, …",
		].join("\n"),
	);
	process.exit(1);
}
