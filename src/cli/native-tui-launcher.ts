/**
 * Launch the native `maestro-tui` binary for interactive mode.
 *
 * Resolution order (contract with release-packaging):
 * 1. `MAESTRO_TUI_BIN` env var (absolute path; error if set but missing)
 * 2. `<packageRoot>/vendor/maestro-tui/${platform}-${arch}/maestro-tui` (+ `.exe` on win32)
 * 3. `maestro-tui` on PATH
 * 4. Dev fallback: `packages/tui-rs/target/release|debug/maestro-tui` relative to package/repo root
 */

import { type SpawnOptions, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getGlobalInstallCommand } from "../package-metadata.js";

export type NativeTuiLaunchArgs = {
	provider?: string;
	model?: string;
	apiKey?: string;
	continue?: boolean;
	resume?: boolean;
	/** Create/reuse a git worktree (Grok-style). True = auto name; string = name. */
	worktree?: boolean | string;
	/** Non-interactive print mode (native single-shot). */
	print?: boolean;
	/** With print, emit JSONL. */
	json?: boolean;
	/** Write final assistant text to this path (exec parity). */
	outputLastMessage?: string;
	/** JSON Schema path or inline JSON for final answer validation. */
	outputSchema?: string;
	/** Native headless protocol server on stdio. */
	headless?: boolean;
	/** Trailing prompt tokens forwarded as positional args. */
	messages?: string[];
};

export function buildNativeHostedRunnerArgs(
	commandArgs: readonly string[],
	defaultPort?: number,
): string[] {
	const args = ["hosted-runner", ...commandArgs];
	const hasExplicitAddress = commandArgs.some(
		(arg) =>
			arg === "--listen" ||
			arg.startsWith("--listen=") ||
			arg === "--port" ||
			arg.startsWith("--port="),
	);
	if (defaultPort !== undefined && !hasExplicitAddress) {
		args.push("--port", String(defaultPort));
	}
	return args;
}

export type ResolveMaestroTuiBinaryOptions = {
	env?: NodeJS.ProcessEnv;
	packageRoot?: string;
	platform?: NodeJS.Platform;
	arch?: string;
	/** Override existence checks (tests). */
	exists?: (path: string) => boolean;
	/** Override PATH lookup (tests). */
	findOnPath?: (
		binaryName: string,
		env: NodeJS.ProcessEnv,
	) => string | undefined;
};

export class MaestroTuiBinaryNotFoundError extends Error {
	readonly code = "MAESTRO_TUI_NOT_FOUND" as const;

	constructor(message: string) {
		super(message);
		this.name = "MaestroTuiBinaryNotFoundError";
	}
}

function defaultPackageRoot(): string {
	const require = createRequire(import.meta.url);
	// Works for:
	// - src/cli/*.ts and dist/cli/*.js  -> ../../package.json
	// - bundled dist/cli-runtime.js     -> ../package.json
	const candidates = [
		"../../package.json",
		"../package.json",
		"./package.json",
	];
	for (const candidate of candidates) {
		try {
			return dirname(require.resolve(candidate));
		} catch {
			// try next layout
		}
	}
	// Last resort: walk up from this module looking for the monorepo package.json
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 8; i += 1) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(
		"Unable to resolve Maestro package root for maestro-tui binary lookup.",
	);
}

function binaryFileName(platform: NodeJS.Platform): string {
	return platform === "win32" ? "maestro-tui.exe" : "maestro-tui";
}

function vendorTriple(platform: NodeJS.Platform, arch: string): string {
	return `${platform}-${arch}`;
}

/**
 * Search PATH for an executable name. Returns the first absolute candidate that exists.
 */
export function findBinaryOnPath(
	binaryName: string,
	env: NodeJS.ProcessEnv = process.env,
	exists: (path: string) => boolean = existsSync,
): string | undefined {
	const pathEnv = env.PATH ?? env.Path ?? "";
	const separator = process.platform === "win32" ? ";" : ":";
	const extensions =
		process.platform === "win32"
			? (env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT"])
			: [""];

	for (const entry of pathEnv.split(separator)) {
		if (!entry) continue;
		for (const ext of extensions) {
			const candidate =
				process.platform === "win32" &&
				!binaryName.toLowerCase().endsWith(ext.toLowerCase())
					? resolve(entry, `${binaryName}${ext}`)
					: resolve(entry, binaryName);
			if (exists(candidate)) {
				return candidate;
			}
		}
		// Also try the bare name (Unix, or already-suffixed Windows name).
		const bare = resolve(entry, binaryName);
		if (exists(bare)) {
			return bare;
		}
	}
	return undefined;
}

function buildNotFoundMessage(options?: {
	platform?: NodeJS.Platform;
	arch?: string;
}): string {
	const platform = options?.platform ?? process.platform;
	const arch = options?.arch ?? process.arch;
	const triple = vendorTriple(platform, arch);
	const name = binaryFileName(platform);
	const npmInstall = getGlobalInstallCommand("npm");
	const bunInstall = getGlobalInstallCommand("bun");
	return [
		"Could not find the native maestro-tui binary required for interactive mode.",
		"",
		"Tried, in order:",
		"  1. MAESTRO_TUI_BIN (explicit override)",
		`  2. vendor/maestro-tui/${triple}/${name} (packaged npm/bun install)`,
		"  3. maestro-tui on PATH",
		"  4. packages/tui-rs/target/{release,debug}/maestro-tui (dev checkout)",
		"",
		"Dev checkout — build the Rust TUI:",
		"  cargo build --release --manifest-path packages/tui-rs/Cargo.toml",
		"  # then re-run maestro, or:",
		"  export MAESTRO_TUI_BIN=$PWD/packages/tui-rs/target/release/maestro-tui",
		"",
		"Published package — reinstall so platform binaries are present:",
		`  ${npmInstall}`,
		`  ${bunInstall}`,
		"",
		"The agent UI and headless/print/exec paths are the native Rust binary (maestro-tui).",
		"Only residual TS utilities (web, config, skill, …) run without this binary.",
	].join("\n");
}

/**
 * Resolve the maestro-tui binary path according to the packaging contract.
 * Throws MaestroTuiBinaryNotFoundError when no candidate exists.
 */
export function resolveMaestroTuiBinary(
	options: ResolveMaestroTuiBinaryOptions = {},
): string {
	const env = options.env ?? process.env;
	const packageRoot = options.packageRoot ?? defaultPackageRoot();
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const exists = options.exists ?? existsSync;
	const findOnPath = options.findOnPath ?? findBinaryOnPath;
	const name = binaryFileName(platform);

	// a. Explicit env override
	const envBin = env.MAESTRO_TUI_BIN?.trim();
	if (envBin) {
		const resolved = isAbsolute(envBin) ? envBin : resolve(envBin);
		if (!exists(resolved)) {
			throw new MaestroTuiBinaryNotFoundError(
				`MAESTRO_TUI_BIN is set to "${envBin}" but that path does not exist.\nUnset MAESTRO_TUI_BIN or point it at a built maestro-tui binary.`,
			);
		}
		return resolved;
	}

	// b. Vendor path (release-packaging contract — do not change)
	const vendorPath = join(
		packageRoot,
		"vendor",
		"maestro-tui",
		vendorTriple(platform, arch),
		name,
	);
	if (exists(vendorPath)) {
		return vendorPath;
	}

	// c. PATH
	const onPath = findOnPath(
		name === "maestro-tui.exe" ? "maestro-tui" : name,
		env,
	);
	// findBinaryOnPath may look for "maestro-tui" and apply PATHEXT on win32
	const pathCandidate =
		onPath ??
		(platform === "win32" ? findOnPath("maestro-tui.exe", env) : undefined);
	if (pathCandidate) {
		return pathCandidate;
	}

	// d. Dev fallback (release then debug), relative to package/repo root
	const releaseDev = join(
		packageRoot,
		"packages",
		"tui-rs",
		"target",
		"release",
		name,
	);
	if (exists(releaseDev)) {
		return releaseDev;
	}
	const debugDev = join(
		packageRoot,
		"packages",
		"tui-rs",
		"target",
		"debug",
		name,
	);
	if (exists(debugDev)) {
		return debugDev;
	}

	throw new MaestroTuiBinaryNotFoundError(
		buildNotFoundMessage({ platform, arch }),
	);
}

/**
 * Map already-parsed Maestro CLI args to flags maestro-tui actually accepts.
 * Do not invent flags.
 */
export function buildNativeTuiCliArgs(parsed: NativeTuiLaunchArgs): string[] {
	const args: string[] = [];
	if (parsed.provider) {
		args.push("--provider", parsed.provider);
	}
	if (parsed.model) {
		args.push("--model", parsed.model);
	}
	if (parsed.apiKey) {
		args.push("--api-key", parsed.apiKey);
	}
	if (parsed.continue) {
		args.push("--continue");
	}
	if (parsed.resume) {
		args.push("--resume");
	}
	if (parsed.worktree === true) {
		args.push("--worktree");
	} else if (
		typeof parsed.worktree === "string" &&
		parsed.worktree.length > 0
	) {
		args.push("--worktree", parsed.worktree);
	} else if (typeof parsed.worktree === "string") {
		args.push("--worktree");
	}
	if (parsed.headless) {
		args.push("--headless");
	}
	if (parsed.print) {
		args.push("--print");
	}
	if (parsed.json) {
		args.push("--json");
	}
	if (parsed.outputLastMessage) {
		args.push("--output-last-message", parsed.outputLastMessage);
	}
	if (parsed.outputSchema) {
		args.push("--output-schema", parsed.outputSchema);
	}
	if (parsed.messages && parsed.messages.length > 0) {
		args.push(...parsed.messages);
	}
	return args;
}

export type LaunchNativeTuiOptions = {
	parsed: NativeTuiLaunchArgs;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	resolveOptions?: ResolveMaestroTuiBinaryOptions;
	/** Inject spawn for tests. */
	spawnImpl?: typeof spawn;
};

const POSIX_SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = {
	SIGHUP: 1,
	SIGINT: 2,
	SIGQUIT: 3,
	SIGTERM: 15,
};

const FORWARDED_PARENT_SIGNALS = [
	"SIGINT",
	"SIGTERM",
	"SIGHUP",
	"SIGQUIT",
] as const satisfies readonly NodeJS.Signals[];

function exitCodeForSignal(signal: NodeJS.Signals): number {
	const signalNumber = POSIX_SIGNAL_NUMBERS[signal];
	return signalNumber === undefined ? 1 : 128 + signalNumber;
}

/**
 * Spawn maestro-tui with inherited stdio and return its exit code.
 * Signal terminations map to 128 + signal number when available, else 1.
 */
export function launchNativeTui(
	options: LaunchNativeTuiOptions,
): Promise<number> {
	const env = options.env ?? process.env;
	const binary = resolveMaestroTuiBinary({
		...options.resolveOptions,
		env: options.resolveOptions?.env ?? env,
	});
	const args = buildNativeTuiCliArgs(options.parsed);
	const cwd = options.cwd ?? process.cwd();
	const spawnImpl = options.spawnImpl ?? spawn;

	const spawnOptions: SpawnOptions = {
		stdio: "inherit",
		cwd,
		env,
	};

	return new Promise<number>((resolvePromise, reject) => {
		const child = spawnImpl(binary, args, spawnOptions);
		child.on("error", (error) => {
			reject(error);
		});
		child.on("exit", (code, signal) => {
			if (signal) {
				resolvePromise(exitCodeForSignal(signal));
				return;
			}
			resolvePromise(code ?? 1);
		});
	});
}

/**
 * True when Maestro should hand off to native maestro-tui (Rust agent).
 *
 * Grok-style default: trailing prompts open the interactive native TUI
 * (`maestro "fix the bug"` → maestro-tui with initial prompt).
 *
 * Still on TypeScript: residual utility subcommands (`web`, `config`, `skill`, …).
 * Agent paths (interactive, print/exec, headless/rpc) are native.
 */

/**
 * Spawn maestro-tui with raw CLI tokens (sessions|cost|status|hooks|print|exec|headless).
 */
export async function launchNativeCli(
	tokens: string[],
	options: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		resolveOptions?: ResolveMaestroTuiBinaryOptions;
		spawnImpl?: typeof spawn;
		/** Forward one parent termination signal and await the child's drain exit. */
		forwardSignals?: boolean;
		/** Override the parent signal source in tests. */
		parentSignalEmitter?: Pick<NodeJS.Process, "on" | "removeListener">;
	} = {},
): Promise<number> {
	const env = options.env ?? process.env;
	const binary = resolveMaestroTuiBinary({
		...options.resolveOptions,
		env,
	});
	const spawnImpl = options.spawnImpl ?? spawn;
	return new Promise<number>((resolvePromise, reject) => {
		const child = spawnImpl(binary, tokens, {
			stdio: "inherit",
			cwd: options.cwd ?? process.cwd(),
			env: { ...env },
		});
		const parentSignalEmitter = options.parentSignalEmitter ?? process;
		let forwardedSignal: NodeJS.Signals | undefined;
		const signalHandlers = new Map<NodeJS.Signals, () => void>();
		const removeSignalHandlers = () => {
			for (const [signal, handler] of signalHandlers) {
				parentSignalEmitter.removeListener(signal, handler);
			}
			signalHandlers.clear();
		};

		if (options.forwardSignals) {
			for (const signal of FORWARDED_PARENT_SIGNALS) {
				const handler = () => {
					if (forwardedSignal !== undefined) return;
					forwardedSignal = signal;
					try {
						if (!child.kill(signal)) {
							removeSignalHandlers();
							resolvePromise(exitCodeForSignal(signal));
						}
					} catch (error) {
						removeSignalHandlers();
						reject(error);
					}
				};
				signalHandlers.set(signal, handler);
				parentSignalEmitter.on(signal, handler);
			}
		}

		child.on("error", (error) => {
			removeSignalHandlers();
			reject(error);
		});
		child.on("exit", (code, signal) => {
			removeSignalHandlers();
			if (signal) {
				resolvePromise(exitCodeForSignal(signal));
				return;
			}
			resolvePromise(code ?? 1);
		});
	});
}

export function shouldLaunchNativeInteractiveTui(parsed: {
	command?: string;
	messages: string[];
	mode?: string;
	headless?: boolean;
}): boolean {
	if (parsed.command !== undefined) {
		return false;
	}
	if (parsed.headless || parsed.mode === "headless") {
		return false;
	}
	if (parsed.mode === "rpc") {
		return false;
	}
	// Explicit single-shot modes use native print (see shouldLaunchNativePrint).
	if (parsed.mode === "json" || parsed.mode === "text") {
		return false;
	}
	if (parsed.messages.length > 0) {
		const forceNative =
			process.env.MAESTRO_NATIVE_PROMPT === "1" ||
			process.env.MAESTRO_NATIVE_PROMPT === "true";
		const stdoutIsTty =
			typeof process.stdout.isTTY === "boolean" ? process.stdout.isTTY : false;
		// Piped scripts without an explicit mode use native print instead.
		if (!stdoutIsTty && !forceNative) {
			return false;
		}
		return true;
	}
	return true;
}

/**
 * True when Maestro should run native print mode (non-interactive single-shot/exec).
 * Replaces the TypeScript agent single-shot path for Grok-style scripting.
 */
export function shouldLaunchNativePrint(parsed: {
	command?: string;
	messages: string[];
	mode?: string;
	headless?: boolean;
	execJson?: boolean;
	execOutputSchema?: string;
	execOutputLast?: string;
}): boolean {
	if (parsed.headless || parsed.mode === "headless" || parsed.mode === "rpc") {
		return false;
	}
	// Full exec (incl. schema + output-last-message) is native.
	if (parsed.command === "exec") {
		return parsed.messages.length > 0;
	}
	if (parsed.command !== undefined) {
		return false;
	}
	if (parsed.messages.length === 0) {
		return false;
	}
	// --mode text|json or non-TTY pipe
	if (parsed.mode === "text" || parsed.mode === "json" || parsed.execJson) {
		return true;
	}
	const stdoutIsTty =
		typeof process.stdout.isTTY === "boolean" ? process.stdout.isTTY : false;
	if (!stdoutIsTty) {
		return true;
	}
	return false;
}

/**
 * True when Maestro should hand off to the native headless protocol server.
 * Replaces the TypeScript runHeadlessMode / runRpcMode agent bootstrap.
 */
export function shouldLaunchNativeHeadless(parsed: {
	command?: string;
	mode?: string;
	headless?: boolean;
}): boolean {
	if (parsed.command !== undefined && parsed.command !== "headless") {
		return false;
	}
	return (
		Boolean(parsed.headless) ||
		parsed.mode === "headless" ||
		parsed.mode === "rpc" ||
		parsed.command === "headless"
	);
}

/** CLI helper subcommands implemented natively (no Node agent bootstrap). */
export function isNativeCliHelperCommand(command?: string): boolean {
	return (
		command === "sessions" ||
		command === "cost" ||
		command === "stats" ||
		command === "models" ||
		command === "status" ||
		command === "hooks" ||
		command === "export" ||
		command === "import"
	);
}
