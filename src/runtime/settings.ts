/**
 * Settings substrate.
 *
 * # Why this exists (the larger surface area)
 *
 * `RuntimeEnv` (PR #2776) made env reads a typed, frozen snapshot. That
 * was the env layer. There's also a *file* layer (`~/.maestro/*.json`,
 * `.maestro/config.toml`, etc.) and a *CLI flags* layer, both of which
 * are sources for the same logical configuration. Droid's
 * `SettingsManager` is the production-scale example of what happens
 * when these resolve through one substrate: hierarchical, typed,
 * attributed by source level.
 *
 * `Settings` is that substrate for us. It composes `RuntimeEnv` with
 * (eventually) TOML config and CLI flag overrides into one frozen
 * typed value. Consumers take `Settings` as a parameter instead of
 * scattering ambient env reads + ad-hoc TOML loads +
 * args.x parsing across files.
 *
 * # Why a separate primitive on top of RuntimeEnv
 *
 * `RuntimeEnv` is flat (env vars only). `Settings` is hierarchical
 * (logger / telemetry / meter / oauth / evalops, each grouping related
 * fields). This lets consumers take a *scoped* slice of settings —
 * `Settings["telemetry"]` is a complete contract for a telemetry
 * consumer, with no exposure to logger or meter knobs.
 *
 * # Resolution semantics
 *
 * Precedence (higher wins):
 *
 *   1. CLI overrides (explicit user intent at process start)
 *   2. `RuntimeEnv` (the substrate-typed env layer)
 *   3. defaults (hardcoded in this file — lowest)
 *
 * Future sources to add as the substrate grows (matching droid's
 * `SettingsManager` shape, in the order they should be threaded):
 *
 *   1.5. system-managed file (IT/MDM deployment, hardcoded platform path)
 *   2.5. user file (`~/.maestro/settings.json`)
 *   3.5. project file (`<git-root>/.maestro/settings.json`)
 *   4.5. profile-scoped overlay (selected via `--profile`)
 *
 * Each source contributes a `DeepPartial<Settings>` and the resolver
 * merges them in precedence order. The result is `Object.freeze`d at
 * each level so consumers can't accidentally mutate.
 *
 * # What this primitive does *not* do
 *
 * - No singleton. No `getInstance()`. Each consumer that needs Settings
 *   either takes it as a parameter or constructs its own via the
 *   factory below.
 * - No file watching. CLI processes are short; live config reload is
 *   a daemon concern that we don't have.
 * - No EventEmitter, no `notifyX()` callbacks, no five-different-reset-
 *   mechanisms. The pattern droid's `SettingsManager` evolved into is
 *   exactly the failure mode we're avoiding (see PR #2772 — same shape
 *   as their `disableWatching()` cleanup leak).
 *
 * # Migration
 *
 * `scripts/check-settings-reads.mjs` (PR #2779) ratchets `.maestro/*`
 * file reads. The companion env-reads ratchet (PR #2776) covers
 * `process.env`. Together they channel new code through this
 * primitive. Existing consumers migrate opportunistically — touch a
 * file, route its config through `Settings`, drop the corresponding
 * baseline entries.
 */

import { type RuntimeEnv, defaultRuntimeEnv } from "./env.js";

export interface LoggerSettings {
	readonly level: "debug" | "info" | "warn" | "error";
	readonly jsonFormat: boolean;
	readonly splitStreams: boolean;
}

export interface TelemetrySettings {
	/**
	 * Tri-state: explicit opt-in (`true`), explicit opt-out (`false`),
	 * or no signal (`null` — the consumer's default applies).
	 */
	readonly enabled: boolean | null;
	readonly beaconFile: string | null;
	readonly endpoint: string | null;
	readonly apiKey: string | null;
	/**
	 * Beacon request timeout in ms. `null` means use the consumer's default.
	 */
	readonly timeoutMs: number | null;
	/**
	 * Sampling probability in `[0, 1]`. `null` means full sampling.
	 */
	readonly sampleRate: number | null;
}

export interface MeterSettings {
	readonly baseUrl: string | null;
	readonly organizationId: string | null;
	readonly accessToken: string | null;
}

export interface OAuthSettings {
	readonly disableKeychain: boolean;
}

export interface EvalOpsSettings {
	readonly orgId: string | null;
	readonly accessToken: string | null;
}

export interface MaestroHomeSettings {
	readonly home: string;
	readonly agentDir: string | null;
}

export interface Settings {
	readonly logger: LoggerSettings;
	readonly telemetry: TelemetrySettings;
	readonly meter: MeterSettings;
	readonly oauth: OAuthSettings;
	readonly evalops: EvalOpsSettings;
	readonly maestro: MaestroHomeSettings;
}

/**
 * Like `Partial<T>` but deep — every nested record is also partial.
 * CLI overrides typically touch one leaf field at a time.
 */
export type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export interface ResolveSettingsOptions {
	readonly env: RuntimeEnv;
	/**
	 * Explicit overrides from CLI flags or programmatic callers. Win
	 * over `env`. Useful for tests too — pass a literal to get exactly
	 * the settings you want.
	 */
	readonly cliOverrides?: DeepPartial<Settings>;
}

function fromRuntimeEnv(env: RuntimeEnv): Settings {
	return {
		logger: {
			level: env.logLevel,
			jsonFormat: env.logJsonFormat,
			splitStreams: env.logSplitStreams,
		},
		telemetry: {
			enabled: env.telemetryEnabled,
			beaconFile: env.beaconFile,
			endpoint: env.beaconEndpoint,
			apiKey: env.beaconApiKey,
			timeoutMs: env.beaconTimeoutMs,
			sampleRate: env.telemetrySampleRate,
		},
		meter: {
			baseUrl: env.meterBaseUrl,
			organizationId: env.meterOrganizationId,
			accessToken: env.meterAccessToken,
		},
		oauth: {
			disableKeychain: env.disableKeychain,
		},
		evalops: {
			orgId: env.evalopsOrgId,
			accessToken: env.evalopsAccessToken,
		},
		maestro: {
			home: env.maestroHome,
			agentDir: env.maestroAgentDir,
		},
	};
}

function pickOverride<T>(override: T | undefined, base: T): T {
	return override === undefined ? base : override;
}

/**
 * Resolve typed `Settings` from the substrate sources.
 *
 * Pure function — same inputs always produce the same output. No I/O,
 * no module-level state, no singletons. Tests construct `RuntimeEnv`
 * with `createRuntimeEnv({...})` and `Settings` with `resolveSettings`,
 * and the result is what the unit under test sees.
 */
export function resolveSettings(options: ResolveSettingsOptions): Settings {
	const base = fromRuntimeEnv(options.env);
	const overrides = options.cliOverrides ?? {};

	return Object.freeze({
		logger: Object.freeze({
			level: pickOverride(overrides.logger?.level, base.logger.level),
			jsonFormat: pickOverride(
				overrides.logger?.jsonFormat,
				base.logger.jsonFormat,
			),
			splitStreams: pickOverride(
				overrides.logger?.splitStreams,
				base.logger.splitStreams,
			),
		}),
		telemetry: Object.freeze({
			enabled: pickOverride(
				overrides.telemetry?.enabled,
				base.telemetry.enabled,
			),
			beaconFile: pickOverride(
				overrides.telemetry?.beaconFile,
				base.telemetry.beaconFile,
			),
			endpoint: pickOverride(
				overrides.telemetry?.endpoint,
				base.telemetry.endpoint,
			),
			apiKey: pickOverride(overrides.telemetry?.apiKey, base.telemetry.apiKey),
			timeoutMs: pickOverride(
				overrides.telemetry?.timeoutMs,
				base.telemetry.timeoutMs,
			),
			sampleRate: pickOverride(
				overrides.telemetry?.sampleRate,
				base.telemetry.sampleRate,
			),
		}),
		meter: Object.freeze({
			baseUrl: pickOverride(overrides.meter?.baseUrl, base.meter.baseUrl),
			organizationId: pickOverride(
				overrides.meter?.organizationId,
				base.meter.organizationId,
			),
			accessToken: pickOverride(
				overrides.meter?.accessToken,
				base.meter.accessToken,
			),
		}),
		oauth: Object.freeze({
			disableKeychain: pickOverride(
				overrides.oauth?.disableKeychain,
				base.oauth.disableKeychain,
			),
		}),
		evalops: Object.freeze({
			orgId: pickOverride(overrides.evalops?.orgId, base.evalops.orgId),
			accessToken: pickOverride(
				overrides.evalops?.accessToken,
				base.evalops.accessToken,
			),
		}),
		maestro: Object.freeze({
			home: pickOverride(overrides.maestro?.home, base.maestro.home),
			agentDir: pickOverride(
				overrides.maestro?.agentDir,
				base.maestro.agentDir,
			),
		}),
	});
}

let cachedDefault: Settings | null = null;
let cachedDefaultEnv: RuntimeEnv | null = null;

/**
 * Process-wide default `Settings`, derived from `defaultRuntimeEnv()`
 * with no CLI overrides. Lazy, cached on first call. The bootstrap
 * entry point for code not yet migrated to take `Settings` as a
 * parameter.
 *
 * Production code that's been migrated should *not* call this; it
 * should accept a `Settings` parameter. Tests should construct their
 * own via `resolveSettings({ env: createRuntimeEnv({...}) })`.
 */
export function defaultSettings(): Settings {
	const env = defaultRuntimeEnv();
	let settings = cachedDefault;
	if (cachedDefaultEnv !== env || settings === null) {
		settings = resolveSettings({ env });
		cachedDefault = settings;
		cachedDefaultEnv = env;
	}
	return settings;
}

/**
 * Drop the cached default. Tests that mutate `process.env` after
 * `defaultSettings()` was first called need this so the next read
 * reflects the new env state. Mirrors `resetDefaultRuntimeEnvForTests`.
 */
export function resetDefaultSettingsForTests(): void {
	cachedDefault = null;
	cachedDefaultEnv = null;
}
