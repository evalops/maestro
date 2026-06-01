import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "../cli/args.js";
import { getAgentDir } from "../config/constants.js";
import {
	getGlobalInstallCommand,
	getPackageName,
} from "../package-metadata.js";
import { withTimeout } from "../utils/async.js";
import {
	type UpdateCheckResult,
	checkForUpdate,
	resolveUpdateUrls,
} from "./check.js";

const SKIP_ENV = "MAESTRO_SKIP_STARTUP_UPDATE";
const STARTUP_UPDATE_ENV = "MAESTRO_STARTUP_UPDATE";
const STARTUP_UPDATE_STATE_ENV = "MAESTRO_STARTUP_UPDATE_STATE";
const STARTUP_UPDATE_TIMEOUT_ENV = "MAESTRO_STARTUP_UPDATE_TIMEOUT_MS";
const STARTUP_UPDATE_TTL_ENV = "MAESTRO_STARTUP_UPDATE_RETRY_MS";
const DEFAULT_INSTALL_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_STARTUP_UPDATE_TIMEOUT_MS = 350;
const NPM_PREFIX_TIMEOUT_MS = 350;
const BUN_PREFIX_TIMEOUT_MS = 350;

const PACKAGE_MANAGER_ENV_PATTERN =
	/^(?:npm_config_|NPM_CONFIG_|BUN_CONFIG_|bun_config_|YARN_|yarn_|PNPM_|pnpm_)/u;
const PACKAGE_MANAGER_ENV_BLOCKLIST = new Set([
	"NODE_OPTIONS",
	"NPM_TOKEN",
	"NODE_AUTH_TOKEN",
	"MAESTRO_UPDATE_URL",
	"MAESTRO_UPDATE_URLS",
	"MAESTRO_STARTUP_UPDATE_STATE",
]);
const PACKAGE_MANAGER_ENV_ALLOWLIST = new Set([
	"NPM_CONFIG_PREFIX",
	"npm_config_prefix",
]);

const bunInstallHomeFromGlobalPrefix = (prefix: string): string | undefined => {
	const normalized = prefix.replace(/\/+$/u, "");
	if (
		basename(normalized) !== "global" ||
		basename(dirname(normalized)) !== "install"
	) {
		return undefined;
	}
	return dirname(dirname(normalized));
};

const packageManagerEnv = (
	env: NodeJS.ProcessEnv,
	options: { packageManager?: PackageManager; prefix?: string } = {},
): NodeJS.ProcessEnv => {
	const sanitized: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) {
			continue;
		}
		if (PACKAGE_MANAGER_ENV_BLOCKLIST.has(key)) {
			continue;
		}
		if (
			PACKAGE_MANAGER_ENV_PATTERN.test(key) &&
			!PACKAGE_MANAGER_ENV_ALLOWLIST.has(key)
		) {
			continue;
		}
		sanitized[key] = value;
	}
	if (options.packageManager === "npm" && options.prefix) {
		sanitized.NPM_CONFIG_PREFIX = options.prefix;
		delete sanitized.npm_config_prefix;
	}
	if (options.packageManager === "bun" && options.prefix) {
		const bunInstall = bunInstallHomeFromGlobalPrefix(options.prefix);
		if (bunInstall) {
			sanitized.BUN_INSTALL = bunInstall;
		}
	}
	return sanitized;
};

type PackageManager = "npm" | "bun";

type GlobalInstallContext = {
	packageManager: PackageManager;
	prefix: string;
};

type StartupUpdateState = {
	version?: string;
	lastAttemptAt?: number;
	lastStatus?: "failed" | "updated";
};

export type StartupUpdateOutcome =
	| { status: "skipped"; reason: string }
	| { status: "current"; check: UpdateCheckResult }
	| { status: "available"; check: UpdateCheckResult }
	| { status: "failed"; check?: UpdateCheckResult; error: string }
	| { status: "updated"; check: UpdateCheckResult }
	| { status: "restarted"; check: UpdateCheckResult; exitCode: number };

type StartupUpdateOptions = {
	args?: string[];
	argv?: string[];
	currentVersion: string;
	env?: NodeJS.ProcessEnv;
	isTty?: boolean;
	now?: number;
	packageName?: string;
	checkForUpdateImpl?: (
		currentVersion: string,
		options?: { timeoutMs?: number; urls?: string[] },
	) => Promise<UpdateCheckResult>;
	checkTimeoutMs?: number;
	globalInstallContexts?: GlobalInstallContext[] | null;
	globalPrefix?: string | null;
	installPackage?: (
		packageManager: PackageManager,
		packageName: string,
		version: string,
	) => {
		status: number | null;
		error?: Error;
	};
	restart?: false | (() => { status: number | null; error?: Error });
	statePath?: string;
};

const OFF_VALUES = new Set(["0", "false", "off", "skip", "disabled"]);
const CHECK_ONLY_VALUES = new Set(["check", "notice", "notify"]);
const INSTALLABLE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const envValue = (env: NodeJS.ProcessEnv, key: string): string =>
	env[key]?.trim().toLowerCase() ?? "";

const toErrorMessage = (error: unknown): string => {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return "Unknown error";
};

const shouldSkipForArgs = (args: string[]): string | null => {
	if (args[0] === "a2a") {
		return "a2a command";
	}
	if (args[0] === "exec") {
		return "non-interactive command";
	}
	if (args[0] === "update") {
		return "manual update command";
	}
	if (
		args.includes("--version") ||
		args.includes("-v") ||
		args.includes("--help") ||
		args.includes("-h")
	) {
		return "immediate-exit command";
	}
	if (
		args.includes("--headless") ||
		args.includes("--json") ||
		args.includes("--rpc") ||
		args.includes("rpc")
	) {
		return "non-interactive command";
	}
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--mode" && args[i + 1] === "headless") {
			return "headless command";
		}
		if (
			arg?.startsWith("--mode=") &&
			arg.slice("--mode=".length) === "headless"
		) {
			return "headless command";
		}
	}
	if (parseArgs(args).messages.length > 0) {
		return "single-shot prompt";
	}
	return null;
};

const resolveDefaultGlobalInstallContexts = (
	entrypoint: string | undefined,
	packageName: string,
	env: NodeJS.ProcessEnv,
): GlobalInstallContext[] => {
	const inferred = inferGlobalInstallContextsFromEntrypoint(
		entrypoint,
		packageName,
	);
	return inferred.length > 0 ? inferred : resolveGlobalInstallContexts(env);
};

export const isInstalledPackageEntrypoint = (
	entrypoint: string | undefined,
	packageName = getPackageName(),
	globalPrefix?: string | null,
): boolean => {
	if (!entrypoint) {
		return false;
	}
	if (isPackageEntrypointPath(entrypoint, packageName, globalPrefix)) {
		return true;
	}
	try {
		return isPackageEntrypointPath(
			realpathSync(entrypoint),
			packageName,
			globalPrefix,
		);
	} catch {
		return false;
	}
};

const isPackageEntrypointPath = (
	entrypoint: string,
	packageName: string,
	globalPrefix?: string | null,
): boolean => {
	const normalized = entrypoint.replace(/\\/g, "/");
	const packageEntrypoint = `/node_modules/${packageName}/dist/cli.js`;
	if (!normalized.endsWith(packageEntrypoint)) {
		return false;
	}
	if (!globalPrefix) {
		return true;
	}
	const normalizedPrefix = globalPrefix
		.replace(/\\/g, "/")
		.replace(/\/+$/u, "");
	const normalizedPrefixes = new Set([normalizedPrefix]);
	try {
		normalizedPrefixes.add(
			realpathSync(globalPrefix).replace(/\\/g, "/").replace(/\/+$/u, ""),
		);
	} catch {
		// A missing prefix will fail the exact path checks below.
	}
	for (const prefix of normalizedPrefixes) {
		if (
			normalized === `${prefix}/lib/node_modules/${packageName}/dist/cli.js` ||
			normalized === `${prefix}/node_modules/${packageName}/dist/cli.js`
		) {
			return true;
		}
	}
	return false;
};

const inferGlobalInstallContextFromEntrypointPath = (
	entrypoint: string,
	packageName: string,
): GlobalInstallContext | null => {
	const normalized = entrypoint.replace(/\\/g, "/");
	const packageEntrypoint = `/node_modules/${packageName}/dist/cli.js`;
	if (!normalized.endsWith(packageEntrypoint)) {
		return null;
	}
	const prefixCandidate = normalized.slice(0, -packageEntrypoint.length);
	if (prefixCandidate.endsWith("/lib")) {
		return {
			packageManager: "npm",
			prefix: prefixCandidate.slice(0, -"/lib".length),
		};
	}
	if (prefixCandidate.endsWith("/install/global")) {
		return { packageManager: "bun", prefix: prefixCandidate };
	}
	return null;
};

const inferGlobalInstallContextsFromEntrypoint = (
	entrypoint: string | undefined,
	packageName: string,
): GlobalInstallContext[] => {
	if (!entrypoint) {
		return [];
	}
	const contexts: GlobalInstallContext[] = [];
	const direct = inferGlobalInstallContextFromEntrypointPath(
		entrypoint,
		packageName,
	);
	if (direct) {
		contexts.push(direct);
	}
	try {
		const real = inferGlobalInstallContextFromEntrypointPath(
			realpathSync(entrypoint),
			packageName,
		);
		if (
			real &&
			!contexts.some(
				(context) =>
					context.packageManager === real.packageManager &&
					context.prefix === real.prefix,
			)
		) {
			contexts.push(real);
		}
	} catch {
		// If the entrypoint cannot be resolved, fall back to prefix discovery.
	}
	return contexts;
};

const resolveStatePath = (
	env: NodeJS.ProcessEnv = process.env,
	override?: string,
): string => {
	if (override) {
		return override;
	}
	if (env[STARTUP_UPDATE_STATE_ENV]) {
		return resolve(env[STARTUP_UPDATE_STATE_ENV]);
	}
	return resolve(getAgentDir(), "startup-update-state.json");
};

const readState = (path: string): StartupUpdateState | null => {
	if (!existsSync(path)) {
		return null;
	}
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as StartupUpdateState;
	} catch {
		return null;
	}
};

const writeState = (path: string, state: StartupUpdateState): void => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
};

const retryMsFromEnv = (env: NodeJS.ProcessEnv): number => {
	const parsed = Number.parseInt(env[STARTUP_UPDATE_TTL_ENV] ?? "", 10);
	if (Number.isFinite(parsed) && parsed >= 0) {
		return parsed;
	}
	return DEFAULT_RETRY_MS;
};

const startupCheckTimeoutMsFromEnv = (env: NodeJS.ProcessEnv): number => {
	const parsed = Number.parseInt(env[STARTUP_UPDATE_TIMEOUT_ENV] ?? "", 10);
	if (Number.isFinite(parsed) && parsed > 0) {
		return parsed;
	}
	return DEFAULT_STARTUP_UPDATE_TIMEOUT_MS;
};

const startupSourceTimeoutMs = (
	totalTimeoutMs: number,
	sourceCount: number,
): number => Math.max(1, Math.floor(totalTimeoutMs / Math.max(1, sourceCount)));

const shouldThrottleAttempt = (
	state: StartupUpdateState | null,
	version: string,
	now: number,
	retryMs: number,
): boolean => {
	if (
		!state ||
		state.version !== version ||
		typeof state.lastAttemptAt !== "number" ||
		state.lastStatus !== "failed"
	) {
		return false;
	}
	return now - state.lastAttemptAt < retryMs;
};

const isInstallableVersion = (version: string): boolean =>
	INSTALLABLE_VERSION.test(version);

const defaultInstallPackage = (
	packageManager: PackageManager,
	packageName: string,
	version: string,
	env: NodeJS.ProcessEnv = process.env,
	prefix?: string,
) => {
	const result = spawnSync(
		packageManager,
		["install", "-g", `${packageName}@${version}`],
		{
			encoding: "utf-8",
			env: packageManagerEnv(env, { packageManager, prefix }),
			stdio: "pipe",
			timeout: DEFAULT_INSTALL_TIMEOUT_MS,
		},
	);
	return { status: result.status, error: result.error };
};

const resolveNpmGlobalPrefix = (
	env: NodeJS.ProcessEnv = process.env,
): string | null => {
	const result = spawnSync("npm", ["prefix", "-g"], {
		encoding: "utf-8",
		env,
		stdio: ["ignore", "pipe", "ignore"],
		timeout: NPM_PREFIX_TIMEOUT_MS,
	});
	if (result.error || result.status !== 0) {
		return null;
	}
	const prefix = result.stdout.trim();
	return prefix.length > 0 ? prefix : null;
};

const resolveBunGlobalPrefix = (
	env: NodeJS.ProcessEnv = process.env,
): string | null => {
	const result = spawnSync("bun", ["pm", "bin", "-g"], {
		encoding: "utf-8",
		env,
		stdio: ["ignore", "pipe", "ignore"],
		timeout: BUN_PREFIX_TIMEOUT_MS,
	});
	if (result.error || result.status !== 0) {
		return null;
	}
	const binDir = result.stdout.trim();
	if (!binDir) {
		return null;
	}
	const bunHome = basename(binDir) === "bin" ? dirname(binDir) : binDir;
	return join(bunHome, "install", "global");
};

const resolveGlobalInstallContexts = (
	env: NodeJS.ProcessEnv = process.env,
): GlobalInstallContext[] => {
	const contexts: GlobalInstallContext[] = [];
	const npmPrefix = resolveNpmGlobalPrefix(env);
	if (npmPrefix) {
		contexts.push({ packageManager: "npm", prefix: npmPrefix });
	}
	const bunPrefix = resolveBunGlobalPrefix(env);
	if (bunPrefix) {
		contexts.push({ packageManager: "bun", prefix: bunPrefix });
	}
	return contexts;
};

export async function attemptStartupUpdate(
	options: StartupUpdateOptions,
): Promise<StartupUpdateOutcome> {
	const env = options.env ?? process.env;
	const args = options.args ?? process.argv.slice(2);
	const argv = options.argv ?? process.argv;
	const packageName = options.packageName ?? getPackageName(env);
	const updateMode = envValue(env, STARTUP_UPDATE_ENV);
	const now = options.now ?? Date.now();

	if (env[SKIP_ENV]) {
		return { status: "skipped", reason: `${SKIP_ENV} is set` };
	}
	if (env.CI || env.NODE_ENV === "test") {
		return { status: "skipped", reason: "test or CI environment" };
	}
	if (OFF_VALUES.has(updateMode)) {
		return { status: "skipped", reason: `${STARTUP_UPDATE_ENV} is disabled` };
	}
	if (
		!(options.isTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY))
	) {
		return { status: "skipped", reason: "non-TTY startup" };
	}
	const argsSkipReason = shouldSkipForArgs(args);
	if (argsSkipReason) {
		return { status: "skipped", reason: argsSkipReason };
	}
	const globalInstallContexts =
		options.globalInstallContexts ??
		(options.globalPrefix === undefined
			? resolveDefaultGlobalInstallContexts(argv[1], packageName, env)
			: options.globalPrefix
				? [{ packageManager: "npm" as const, prefix: options.globalPrefix }]
				: []);
	if (globalInstallContexts.length === 0) {
		return {
			status: "skipped",
			reason:
				options.globalPrefix === null
					? "npm global prefix unavailable"
					: "global package prefix unavailable",
		};
	}
	const installContext = globalInstallContexts.find((context) =>
		isInstalledPackageEntrypoint(argv[1], packageName, context.prefix),
	);
	if (!installContext) {
		return {
			status: "skipped",
			reason: "not running installed global package",
		};
	}

	const checkTimeoutMs =
		options.checkTimeoutMs ?? startupCheckTimeoutMsFromEnv(env);
	const updateUrls = resolveUpdateUrls({}, env, packageName);
	const checkOptions = {
		timeoutMs: startupSourceTimeoutMs(checkTimeoutMs, updateUrls.length),
		urls: updateUrls,
	};
	const check = await withTimeout(
		(options.checkForUpdateImpl ?? checkForUpdate)(
			options.currentVersion,
			checkOptions,
		),
		checkTimeoutMs,
		`Startup update check timed out after ${checkTimeoutMs}ms`,
	).catch(
		(error): UpdateCheckResult => ({
			currentVersion: options.currentVersion,
			isUpdateAvailable: false,
			sourceUrl: "",
			error: toErrorMessage(error),
		}),
	);
	if (check.error) {
		return { status: "failed", check, error: check.error };
	}
	if (!check.isUpdateAvailable || !check.latestVersion) {
		return { status: "current", check };
	}
	if (CHECK_ONLY_VALUES.has(updateMode)) {
		return { status: "available", check };
	}
	if (!isInstallableVersion(check.latestVersion)) {
		return {
			status: "failed",
			check,
			error: `Refusing to install unsupported version ${check.latestVersion}`,
		};
	}

	const statePath = resolveStatePath(env, options.statePath);
	if (
		shouldThrottleAttempt(
			readState(statePath),
			check.latestVersion,
			now,
			retryMsFromEnv(env),
		)
	) {
		return { status: "available", check };
	}

	writeState(statePath, {
		version: check.latestVersion,
		lastAttemptAt: now,
		lastStatus: "failed",
	});
	const installPackage =
		options.installPackage ??
		((packageManager: PackageManager, name: string, version: string) =>
			defaultInstallPackage(
				packageManager,
				name,
				version,
				env,
				installContext.prefix,
			));
	const install = installPackage(
		installContext.packageManager,
		packageName,
		check.latestVersion,
	);
	if (install.error || install.status !== 0) {
		return {
			status: "failed",
			check,
			error:
				install.error?.message ??
				`${getGlobalInstallCommand(installContext.packageManager, `${packageName}@${check.latestVersion}`)} exited ${install.status}`,
		};
	}

	writeState(statePath, {
		version: check.latestVersion,
		lastAttemptAt: now,
		lastStatus: "updated",
	});

	if (options.restart === false) {
		return { status: "updated", check };
	}

	const restart =
		options.restart ??
		(() => {
			const result = spawnSync(process.execPath, argv.slice(1), {
				stdio: "inherit",
				env: { ...env, [SKIP_ENV]: "1" },
			});
			return { status: result.status, error: result.error };
		});
	const restarted = restart();
	if (restarted.error) {
		return { status: "updated", check };
	}
	return { status: "restarted", check, exitCode: restarted.status ?? 0 };
}
