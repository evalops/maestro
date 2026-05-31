#!/usr/bin/env node

declare const MAESTRO_BUNDLE_RUNTIME: boolean | undefined;

// Suppress punycode deprecation warning from dependencies
// This warning comes from old dependencies still using the deprecated punycode module
import {
	type ImmediateCliExit,
	getImmediateCliExit,
	shouldUseInstantCliExit,
} from "./cli/instant-exit.js";

const originalEmit = process.emit.bind(process) as (
	event: string | symbol,
	...args: unknown[]
) => boolean;
process.emit = ((event: string | symbol, ...args: unknown[]) => {
	if (event === "warning") {
		const [firstArg] = args;
		if (
			typeof firstArg === "object" &&
			firstArg !== null &&
			"name" in firstArg &&
			"code" in firstArg &&
			(firstArg as { name?: string; code?: string }).name ===
				"DeprecationWarning" &&
			(firstArg as { name?: string; code?: string }).code === "DEP0040"
		) {
			return false; // Suppress punycode deprecation
		}
	}
	return originalEmit(event, ...args);
}) as typeof process.emit;

function isHeadlessInvocation(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--headless") {
			return true;
		}
		if (arg === "--mode" && args[i + 1] === "headless") {
			return true;
		}
		if (
			arg?.startsWith("--mode=") &&
			arg.slice("--mode=".length) === "headless"
		) {
			return true;
		}
	}
	return false;
}

function emitHeadlessStartupError(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const stack = error instanceof Error ? error.stack : undefined;
	try {
		process.stdout.write(
			`${JSON.stringify({
				type: "error",
				message: `Headless startup failed: ${message}`,
				fatal: true,
				error_type: "fatal",
			})}\n`,
		);
	} catch {
		// If stdout is unavailable there is no protocol channel left to use.
	}
	process.stderr.write(`${stack ?? message}\n`);
}

async function reportFatalCliError(error: unknown): Promise<void> {
	try {
		const { captureSentryException, flushSentry, initSentry } = await import(
			"./sentry.js"
		);
		initSentry("maestro-cli");
		captureSentryException(error);
		await flushSentry();
	} catch {
		// Sentry reporting is best-effort and must not mask the original failure.
	}
}

async function refreshInstalledCliOnStartup(args: string[]): Promise<void> {
	try {
		const [{ getPackageVersion }, { attemptStartupUpdate }] = await Promise.all(
			[import("./package-metadata.js"), import("./update/startup-refresh.js")],
		);
		const outcome = await attemptStartupUpdate({
			args,
			currentVersion: getPackageVersion(),
		});
		if (outcome.status === "restarted") {
			process.exit(outcome.exitCode);
		}
	} catch {
		// Startup refresh is best-effort and must never prevent the CLI from booting.
	}
}

async function runImmediateCliExit(exit: ImmediateCliExit): Promise<void> {
	if (exit.kind === "version") {
		const { getPackageVersion } = await import("./package-metadata.js");
		console.log(`Maestro v${getPackageVersion()}`);
		return;
	}

	const [{ printHelp }, { getPackageVersion }] = await Promise.all([
		import("./cli/help.js"),
		import("./package-metadata.js"),
	]);
	printHelp(getPackageVersion(), { includeHidden: exit.includeHidden });
}

async function runCliRuntime(args: string[]): Promise<void> {
	if (typeof MAESTRO_BUNDLE_RUNTIME !== "undefined" && MAESTRO_BUNDLE_RUNTIME) {
		const { runCliRuntime: runRuntime } = await import("./cli-runtime.js");
		await runRuntime(args);
		return;
	}
	const runtimeEntry = "./cli-runtime." + "js";
	const { runCliRuntime: runRuntime } = await import(runtimeEntry);
	await runRuntime(args);
}

async function loadDirectRuntimeCommandModule() {
	if (typeof MAESTRO_BUNDLE_RUNTIME !== "undefined" && MAESTRO_BUNDLE_RUNTIME) {
		return import("./cli/direct-runtime-command.js");
	}
	const directRuntimeCommandEntry = "./cli/direct-runtime-command." + "js";
	return import(directRuntimeCommandEntry);
}

async function runCliCommandRuntime(args: string[]): Promise<boolean> {
	const { shouldAttemptDirectRuntimeDispatch } =
		await loadDirectRuntimeCommandModule();
	if (!shouldAttemptDirectRuntimeDispatch(args)) {
		return false;
	}
	if (typeof MAESTRO_BUNDLE_RUNTIME !== "undefined" && MAESTRO_BUNDLE_RUNTIME) {
		const { runCliCommandRuntime: runCommandRuntime } = await import(
			"./cli-command-runtime.js"
		);
		return runCommandRuntime(args);
	}
	const commandRuntimeEntry = "./cli-command-runtime." + "js";
	const { runCliCommandRuntime: runCommandRuntime } = await import(
		commandRuntimeEntry
	);
	return runCommandRuntime(args);
}

const run = async () => {
	try {
		const args = process.argv.slice(2);
		const immediateExit = getImmediateCliExit(args);
		let envLoaded = false;
		if (immediateExit !== null) {
			const { loadEnv } = await import("./load-env.js");
			loadEnv();
			envLoaded = true;
		}
		if (shouldUseInstantCliExit(immediateExit, process.env)) {
			await runImmediateCliExit(immediateExit);
			return;
		}

		if (!envLoaded) {
			const { loadEnv } = await import("./load-env.js");
			loadEnv();
		}
		await refreshInstalledCliOnStartup(args);
		if (await runCliCommandRuntime(args)) {
			return;
		}
		await runCliRuntime(args);
	} catch (err) {
		if (isHeadlessInvocation(process.argv.slice(2))) {
			emitHeadlessStartupError(err);
		} else {
			console.error(err);
		}
		await reportFatalCliError(err);
		process.exit(1);
	}
};

// Call without top-level await so Bun's bytecode compilation (which forbids TLA) can bundle this entry.
void run();
