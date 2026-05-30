import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { getAgentDir } from "../config/constants.js";
import {
	getGlobalInstallCommand,
	getPackageName,
} from "../package-metadata.js";
import { type UpdateCheckResult, checkForUpdate } from "./check.js";

const SKIP_ENV = "MAESTRO_SKIP_STARTUP_UPDATE";
const STARTUP_UPDATE_ENV = "MAESTRO_STARTUP_UPDATE";
const STARTUP_UPDATE_STATE_ENV = "MAESTRO_STARTUP_UPDATE_STATE";
const STARTUP_UPDATE_TTL_ENV = "MAESTRO_STARTUP_UPDATE_RETRY_MS";
const DEFAULT_INSTALL_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_MS = 24 * 60 * 60 * 1_000;

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
	checkForUpdateImpl?: (currentVersion: string) => Promise<UpdateCheckResult>;
	installPackage?: (
		packageName: string,
		version: string,
	) => {
		status: number | null;
		error?: Error;
	};
	restart?: () => { status: number | null; error?: Error };
	statePath?: string;
};

const OFF_VALUES = new Set(["0", "false", "off", "skip", "disabled"]);
const CHECK_ONLY_VALUES = new Set(["check", "notice", "notify"]);
const INSTALLABLE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const envValue = (env: NodeJS.ProcessEnv, key: string): string =>
	env[key]?.trim().toLowerCase() ?? "";

const shouldSkipForArgs = (args: string[]): string | null => {
	if (args[0] === "a2a") {
		return "a2a command";
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
	return null;
};

export const isInstalledPackageEntrypoint = (
	entrypoint: string | undefined,
	packageName = getPackageName(),
): boolean => {
	if (!entrypoint) {
		return false;
	}
	if (isPackageEntrypointPath(entrypoint, packageName)) {
		return true;
	}
	try {
		return isPackageEntrypointPath(realpathSync(entrypoint), packageName);
	} catch {
		return false;
	}
};

const isPackageEntrypointPath = (
	entrypoint: string,
	packageName: string,
): boolean => {
	const normalized = entrypoint.replace(/\\/g, "/");
	return normalized.includes(`/node_modules/${packageName}/dist/cli.js`);
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

const defaultInstallPackage = (packageName: string, version: string) => {
	const result = spawnSync(
		"npm",
		["install", "-g", `${packageName}@${version}`],
		{
			encoding: "utf-8",
			stdio: "pipe",
			timeout: DEFAULT_INSTALL_TIMEOUT_MS,
		},
	);
	return { status: result.status, error: result.error };
};

export async function attemptStartupUpdate(
	options: StartupUpdateOptions,
): Promise<StartupUpdateOutcome> {
	const env = options.env ?? process.env;
	const args = options.args ?? process.argv.slice(2);
	const argv = options.argv ?? process.argv;
	const packageName = options.packageName ?? getPackageName();
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
	if (!isInstalledPackageEntrypoint(argv[1], packageName)) {
		return { status: "skipped", reason: "not running installed npm package" };
	}

	const check = await (options.checkForUpdateImpl ?? checkForUpdate)(
		options.currentVersion,
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
	const install = (options.installPackage ?? defaultInstallPackage)(
		packageName,
		check.latestVersion,
	);
	if (install.error || install.status !== 0) {
		return {
			status: "failed",
			check,
			error:
				install.error?.message ??
				`${getGlobalInstallCommand("npm", `${packageName}@${check.latestVersion}`)} exited ${install.status}`,
		};
	}

	writeState(statePath, {
		version: check.latestVersion,
		lastAttemptAt: now,
		lastStatus: "updated",
	});

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
