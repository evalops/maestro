/**
 * Runtime environment substrate.
 *
 * # Why this exists
 *
 * Ambient `process.env` reads scattered through library code are the root
 * cause of an entire class of flakes:
 *
 *  - Logger config frozen at setup-file import time (PR #2768/#2769).
 *  - Meter test passing on runner-2, failing on runner-1 because the CI
 *    runner's env had `EVALOPS_ORG_ID` set (PR #2763).
 *  - CLI integration test `prints providers summary for filter` flaking
 *    intermittently because OAuth keychain mode was captured by the first
 *    test in a vitest worker (PRs #2752, #2761, #2762, #2766).
 *  - CLI aggregator's `setInterval` outliving the test that started it,
 *    later reading the *next* test's env-driven buffer path (PR #2772).
 *
 * Every one of those was the same shape: shared mutable state with no
 * causal ordering between writers and readers and no owner.
 *
 * The substrate fix is to make environment a *parameter*, not a *global*.
 * Library code receives a `RuntimeEnv`. Tests construct one with a literal.
 * The single place that reads `process.env` is `createRuntimeEnv` —
 * everything else passes the typed result around.
 *
 * # Migration strategy
 *
 * `defaultRuntimeEnv()` is a one-call-per-process snapshot of
 * `process.env`. Code not yet migrated can pick it up incrementally. The
 * `scripts/check-env-reads.mjs` baseline prevents *new* direct reads from
 * `process.env` in `src/` without going through `RuntimeEnv` first.
 *
 * # What's typed here
 *
 * The fields below are the env vars that have produced production flakes,
 * security gaps, or cross-test pollution in the last quarter. Untyped
 * vars stay as ambient `process.env` reads for now — the scanner just
 * prevents new ones being added — and graduate into this type as their
 * consumers are migrated.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeEnv {
	// --- Logger ---
	readonly logLevel: LogLevel;
	readonly logJsonFormat: boolean;
	readonly logSplitStreams: boolean;

	// --- EvalOps identity (the flake surface PR #2763 closed) ---
	/**
	 * Organization id resolved across the documented alias list.
	 * Source vars (first non-empty wins):
	 *  - MAESTRO_EVALOPS_ORG_ID
	 *  - EVALOPS_ORGANIZATION_ID
	 *  - EVALOPS_ORG_ID
	 *  - MAESTRO_ENTERPRISE_ORG_ID
	 */
	readonly evalopsOrgId: string | null;
	/**
	 * Access token resolved across the documented alias list.
	 * Source vars: MAESTRO_EVALOPS_ACCESS_TOKEN, EVALOPS_TOKEN.
	 */
	readonly evalopsAccessToken: string | null;

	// --- OAuth storage isolation (PRs #2752/#2761/#2762/#2766) ---
	readonly disableKeychain: boolean;
	readonly maestroHome: string;
	readonly maestroAgentDir: string | null;
	readonly missionStoreDir: string | null;
	readonly snapshotBlobDir: string | null;
	readonly skillTrustStrict: boolean;

	// --- CLI command aggregator / telemetry (PR #2772 timer leak) ---
	/**
	 * Tri-state parsed signal: true (opt-in), false (opt-out), null (no
	 * signal). For diagnostics that need the raw user string, see
	 * `telemetryFlag` below.
	 */
	readonly telemetryEnabled: boolean | null;
	/**
	 * Raw `MAESTRO_TELEMETRY` (or `PLAYWRIGHT_TELEMETRY` fallback) string,
	 * trimmed. Preserved separately from `telemetryEnabled` so diagnostic
	 * surfaces (e.g. `getTelemetryStatus().flagValue`) can show the literal
	 * user setting.
	 */
	readonly telemetryFlag: string | null;
	readonly beaconFile: string | null;
	readonly beaconEndpoint: string | null;
	readonly beaconApiKey: string | null;
	/**
	 * Beacon request timeout in ms. `null` means use the consumer's default.
	 */
	readonly beaconTimeoutMs: number | null;
	/**
	 * Telemetry sampling probability in `[0, 1]`. `null` means full sampling.
	 */
	readonly telemetrySampleRate: number | null;
	readonly cliCommandBeaconBufferFile: string | null;

	// --- OpenTelemetry SDK boot (`src/opentelemetry.ts`) ---
	/**
	 * Tri-state for `MAESTRO_OTEL`. `null` means no explicit signal —
	 * the OTel boot logic infers enablement from the presence of an
	 * exporter endpoint.
	 */
	readonly otelEnabled: boolean | null;
	/**
	 * Raw `MAESTRO_OTEL` string preserved for `getOpenTelemetryStatus`
	 * reason-string diagnostics that distinguish "MAESTRO_OTEL=1" from
	 * "MAESTRO_OTEL=0" in the human-readable reason.
	 */
	readonly otelFlag: string | null;
	readonly otelServiceName: string | null;
	readonly otelSampler: string | null;

	// --- OpenTelemetry exporter (`src/telemetry.ts`) ---
	/**
	 * Where the OTel exporter dumps a local log of telemetry events.
	 * Source vars (first non-empty wins, tilde-expanded):
	 *  - MAESTRO_TELEMETRY_FILE
	 *  - PLAYWRIGHT_TELEMETRY_FILE
	 *
	 * This is separate from `beaconFile` (`MAESTRO_BEACON_FILE`) — the
	 * OTel exporter writes structured events, the beacon writes one JSON
	 * line per event. Users that set only one of the two expect the other
	 * to remain off.
	 */
	readonly exporterFile: string | null;
	/**
	 * HTTP endpoint for the OTel exporter. Distinct from `beaconEndpoint`
	 * because `MAESTRO_BEACON_ENDPOINT` is a beacon-specific override that
	 * shouldn't redirect the OTel exporter.
	 *  - MAESTRO_TELEMETRY_ENDPOINT
	 *  - PLAYWRIGHT_TELEMETRY_ENDPOINT
	 */
	readonly exporterEndpoint: string | null;

	// --- Meter remote-mirror gate (PR #2763 failure) ---
	readonly meterBaseUrl: string | null;
	readonly meterAccessToken: string | null;
	readonly meterOrganizationId: string | null;

	// --- Ambient agent evidence ---
	readonly ambientLearnerFile: string | null;
	readonly ambientLearnerDefaultFile: string;
	readonly ambientSocketFile: string;
}

function trim(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const t = value.trim();
	return t.length > 0 ? t : null;
}

function firstNonEmpty(
	raw: NodeJS.ProcessEnv,
	names: readonly string[],
): string | null {
	for (const name of names) {
		const v = trim(raw[name]);
		if (v) return v;
	}
	return null;
}

const EVALOPS_ORG_ID_VARS = [
	"MAESTRO_EVALOPS_ORG_ID",
	"EVALOPS_ORGANIZATION_ID",
	"EVALOPS_ORG_ID",
	"MAESTRO_ENTERPRISE_ORG_ID",
] as const;

const EVALOPS_ACCESS_TOKEN_VARS = [
	"MAESTRO_EVALOPS_ACCESS_TOKEN",
	"EVALOPS_TOKEN",
] as const;

const METER_BASE_URL_VARS = [
	"MAESTRO_METER_BASE",
	"MAESTRO_METER_SERVICE_URL",
	"MAESTRO_PLATFORM_BASE_URL",
	"MAESTRO_EVALOPS_BASE_URL",
	"EVALOPS_BASE_URL",
] as const;

const METER_ACCESS_TOKEN_VARS = [
	"MAESTRO_METER_ACCESS_TOKEN",
	...EVALOPS_ACCESS_TOKEN_VARS,
] as const;

const METER_ORG_ID_VARS = [
	"MAESTRO_METER_ORGANIZATION_ID",
	...EVALOPS_ORG_ID_VARS,
] as const;

function parseLogLevel(value: string | null): LogLevel {
	switch (value) {
		case "debug":
		case "info":
		case "warn":
		case "error":
			return value;
		default:
			return "info";
	}
}

function parseBoolean(value: string | null): boolean {
	return value === "1" || value === "true";
}

export function parseOptionalBoolean(value: string | null): boolean | null {
	if (value === null) return null;
	const normalized = value.toLowerCase();
	if (normalized === "0" || normalized === "false") return false;
	if (normalized === "1" || normalized === "true") return true;
	return null;
}

function parseOptionalSampleRate(value: string | null): number | null {
	if (value === null) return null;
	const parsed = Number.parseFloat(value);
	if (!Number.isFinite(parsed)) return null;
	return Math.min(Math.max(parsed, 0), 1);
}

function parseOptionalPositiveInt(value: string | null): number | null {
	if (value === null) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveHomePath(
	value: string | null,
	raw: NodeJS.ProcessEnv,
): string | null {
	if (value === null) return null;
	// Match the legacy `resolveEnvPath` chain: honor an overridden HOME
	// (or USERPROFILE on Windows) before falling back to `homedir()`. This
	// keeps tests and tools that pin HOME to a temp dir working as they did
	// when this read went through `src/utils/path-expansion.ts`.
	const home = trim(raw.HOME) ?? trim(raw.USERPROFILE) ?? homedir();
	const expanded =
		value === "~"
			? home
			: value.startsWith("~/") || value.startsWith("~\\")
				? join(home, value.slice(2))
				: value;
	return resolve(expanded);
}

function homeFromEnv(raw: NodeJS.ProcessEnv): string {
	return trim(raw.HOME) ?? trim(raw.USERPROFILE) ?? homedir();
}

function resolveDataLocalDir(raw: NodeJS.ProcessEnv): string {
	const home = homeFromEnv(raw);
	if (process.platform === "darwin") {
		return join(home, "Library", "Application Support");
	}
	if (process.platform === "win32") {
		return (
			resolveHomePath(trim(raw.LOCALAPPDATA), raw) ??
			resolveHomePath(trim(raw.APPDATA), raw) ??
			join(home, "AppData", "Local")
		);
	}
	return (
		resolveHomePath(trim(raw.XDG_DATA_HOME), raw) ??
		join(home, ".local", "share")
	);
}

function resolveRuntimeDir(raw: NodeJS.ProcessEnv): string {
	if (process.platform === "darwin") {
		return resolveDataLocalDir(raw);
	}
	const xdgRuntimeDir = resolveHomePath(trim(raw.XDG_RUNTIME_DIR), raw);
	if (xdgRuntimeDir) return xdgRuntimeDir;
	return resolveDataLocalDir(raw);
}

/**
 * Build an immutable snapshot of the env vars this codebase cares about.
 *
 * Pure function: same input → same output. Call it once at process
 * startup (or in tests, with a literal) and thread the result through the
 * program. Do not call it on every operation — that defeats the purpose.
 */
export function createRuntimeEnv(raw: NodeJS.ProcessEnv): RuntimeEnv {
	return Object.freeze({
		logLevel: parseLogLevel(trim(raw.MAESTRO_LOG_LEVEL)),
		logJsonFormat: parseBoolean(trim(raw.MAESTRO_LOG_JSON)),
		logSplitStreams: parseBoolean(trim(raw.MAESTRO_LOG_SPLIT_STREAMS)),

		evalopsOrgId: firstNonEmpty(raw, EVALOPS_ORG_ID_VARS),
		evalopsAccessToken: firstNonEmpty(raw, EVALOPS_ACCESS_TOKEN_VARS),

		disableKeychain: parseBoolean(trim(raw.MAESTRO_DISABLE_KEYCHAIN)),
		maestroHome: trim(raw.MAESTRO_HOME) ?? join(homedir(), ".maestro"),
		maestroAgentDir: trim(raw.MAESTRO_AGENT_DIR),
		missionStoreDir: resolveHomePath(trim(raw.MAESTRO_MISSION_STORE_DIR), raw),
		snapshotBlobDir: resolveHomePath(trim(raw.MAESTRO_SNAPSHOT_BLOB_DIR), raw),
		skillTrustStrict: parseBoolean(trim(raw.MAESTRO_SKILL_TRUST_STRICT)),

		telemetryEnabled: parseOptionalBoolean(
			trim(raw.MAESTRO_TELEMETRY) ?? trim(raw.PLAYWRIGHT_TELEMETRY),
		),
		telemetryFlag:
			trim(raw.MAESTRO_TELEMETRY) ?? trim(raw.PLAYWRIGHT_TELEMETRY),
		beaconFile: resolveHomePath(trim(raw.MAESTRO_BEACON_FILE), raw),
		beaconEndpoint: firstNonEmpty(raw, [
			"MAESTRO_BEACON_ENDPOINT",
			"MAESTRO_TELEMETRY_ENDPOINT",
			"PLAYWRIGHT_TELEMETRY_ENDPOINT",
		]),
		beaconApiKey: trim(raw.MAESTRO_BEACON_API_KEY),
		beaconTimeoutMs: parseOptionalPositiveInt(
			trim(raw.MAESTRO_BEACON_TIMEOUT_MS),
		),
		telemetrySampleRate: parseOptionalSampleRate(
			trim(raw.MAESTRO_TELEMETRY_SAMPLE) ??
				trim(raw.PLAYWRIGHT_TELEMETRY_SAMPLE),
		),
		cliCommandBeaconBufferFile: trim(
			raw.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE,
		),

		otelEnabled: parseOptionalBoolean(trim(raw.MAESTRO_OTEL)),
		otelFlag: trim(raw.MAESTRO_OTEL),
		otelServiceName: trim(raw.MAESTRO_OTEL_SERVICE_NAME),
		otelSampler: trim(raw.MAESTRO_OTEL_SAMPLER),

		exporterFile:
			resolveHomePath(trim(raw.MAESTRO_TELEMETRY_FILE), raw) ??
			resolveHomePath(trim(raw.PLAYWRIGHT_TELEMETRY_FILE), raw),
		exporterEndpoint: firstNonEmpty(raw, [
			"MAESTRO_TELEMETRY_ENDPOINT",
			"PLAYWRIGHT_TELEMETRY_ENDPOINT",
		]),

		meterBaseUrl: firstNonEmpty(raw, METER_BASE_URL_VARS),
		meterAccessToken: firstNonEmpty(raw, METER_ACCESS_TOKEN_VARS),
		meterOrganizationId: firstNonEmpty(raw, METER_ORG_ID_VARS),
		ambientLearnerFile: resolveHomePath(
			trim(raw.MAESTRO_AMBIENT_LEARNER_FILE),
			raw,
		),
		ambientLearnerDefaultFile: join(
			resolveDataLocalDir(raw),
			"ambient-agent",
			"learner.json",
		),
		ambientSocketFile: join(resolveRuntimeDir(raw), "ambient-agent.sock"),
	});
}

type ProcessWithRuntimeEnvCache = typeof process & {
	__MAESTRO_DEFAULT_RUNTIME_ENV__?: RuntimeEnv;
	__MAESTRO_RUNTIME_ENV_EARLY_ACCESS_WARNED__?: boolean;
	__MAESTRO_RUNTIME_ENV_FINALIZED__?: boolean;
};

const processWithRuntimeEnvCache = process as ProcessWithRuntimeEnvCache;

function isTestProcess(): boolean {
	return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function maybeReportEarlyRuntimeEnvAccess(): void {
	if (processWithRuntimeEnvCache.__MAESTRO_RUNTIME_ENV_FINALIZED__) {
		return;
	}
	const message =
		"defaultRuntimeEnv() was read before loadAndFinalizeEnv() completed. " +
		"Bootstrap entry points must finish dotenv loading and security scrubbing before runtime env snapshots are created.";
	if (process.env.MAESTRO_RUNTIME_ENV_STRICT_BOOTSTRAP === "1") {
		throw new Error(message);
	}
	if (
		isTestProcess() ||
		processWithRuntimeEnvCache.__MAESTRO_RUNTIME_ENV_EARLY_ACCESS_WARNED__
	) {
		return;
	}
	processWithRuntimeEnvCache.__MAESTRO_RUNTIME_ENV_EARLY_ACCESS_WARNED__ = true;
	console.warn(`[maestro] ${message}`);
}

/**
 * Return the process-wide snapshot of `process.env`.
 *
 * Builds the snapshot lazily on first call so the timing of module load
 * doesn't matter — by the time anything calls this, env has finished
 * settling (CLI argv parsed, dotenv loaded, vitest setup files run). The
 * returned object is frozen and shared.
 *
 * Library code that's been migrated to the substrate should *not* call
 * this directly; it should accept a `RuntimeEnv` parameter. This export
 * exists as the bootstrap entry point and as a compatibility shim during
 * the migration.
 */
export function defaultRuntimeEnv(): RuntimeEnv {
	maybeReportEarlyRuntimeEnvAccess();
	if (!processWithRuntimeEnvCache.__MAESTRO_DEFAULT_RUNTIME_ENV__) {
		processWithRuntimeEnvCache.__MAESTRO_DEFAULT_RUNTIME_ENV__ =
			createRuntimeEnv(process.env);
	}
	return processWithRuntimeEnvCache.__MAESTRO_DEFAULT_RUNTIME_ENV__;
}

export function markRuntimeEnvFinalized(): void {
	processWithRuntimeEnvCache.__MAESTRO_RUNTIME_ENV_FINALIZED__ = true;
	Reflect.deleteProperty(
		processWithRuntimeEnvCache,
		"__MAESTRO_RUNTIME_ENV_EARLY_ACCESS_WARNED__",
	);
}

export function isRuntimeEnvFinalized(): boolean {
	return processWithRuntimeEnvCache.__MAESTRO_RUNTIME_ENV_FINALIZED__ === true;
}

/**
 * Drop the cached default snapshot so the next `defaultRuntimeEnv()` call
 * re-reads `process.env`.
 *
 * Prefer constructing a `RuntimeEnv` with `createRuntimeEnv` and injecting it.
 * This reset is reserved for process bootstrap paths that intentionally mutate
 * `process.env` before handing control to migrated modules.
 */
export function resetDefaultRuntimeEnv(): void {
	Reflect.deleteProperty(
		processWithRuntimeEnvCache,
		"__MAESTRO_DEFAULT_RUNTIME_ENV__",
	);
}

export function resetDefaultRuntimeEnvForTests(): void {
	resetDefaultRuntimeEnv();
	Reflect.deleteProperty(
		processWithRuntimeEnvCache,
		"__MAESTRO_RUNTIME_ENV_FINALIZED__",
	);
	Reflect.deleteProperty(
		processWithRuntimeEnvCache,
		"__MAESTRO_RUNTIME_ENV_EARLY_ACCESS_WARNED__",
	);
}
