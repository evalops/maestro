import { readFileSync, statSync } from "node:fs";

type FeatureFlag = {
	enabled?: boolean;
	key?: string;
};

type FeatureFlagSnapshot = {
	flags?: FeatureFlag[];
	schema_version?: number;
};

type FeatureFlagCache = {
	lastKnownSnapshot: FeatureFlagSnapshot | null;
	lastPath?: string;
	lastStatMtimeMs?: number;
};

const featureFlagCache: FeatureFlagCache = {
	lastKnownSnapshot: null,
};

export const MAESTRO_EVALOPS_MANAGED_KILL_SWITCH =
	"platform.kill_switches.maestro.evalops_managed";
export const MAESTRO_AUTONOMOUS_ACTIONS_KILL_SWITCH =
	"platform.kill_switches.maestro.autonomous_actions";
export const MAESTRO_PLATFORM_RUNTIME_BRIDGE_KILL_SWITCH =
	"platform.kill_switches.maestro.platform_runtime_bridge";
export const MAESTRO_DRAFT_AND_CONFIRM_DEFAULT_FLAG =
	"maestro.agent_authority.draft_and_confirm_default";
export const MAESTRO_PLATFORM_RUNTIME_AGENT_RUNTIME_OBSERVE_FLAG =
	"maestro.platform_runtime.agent_runtime_observe";
export const MAESTRO_PLATFORM_RUNTIME_TOOL_EXECUTION_BRIDGE_FLAG =
	"maestro.platform_runtime.tool_execution_bridge";

function getFeatureFlagsPath(): string | undefined {
	const configured = process.env.EVALOPS_FEATURE_FLAGS_PATH?.trim();
	return configured ? configured : undefined;
}

function readFeatureFlagSnapshot(): FeatureFlagSnapshot | null {
	const path = getFeatureFlagsPath();
	if (!path) {
		featureFlagCache.lastKnownSnapshot = null;
		featureFlagCache.lastPath = undefined;
		featureFlagCache.lastStatMtimeMs = undefined;
		return null;
	}

	try {
		const stats = statSync(path);
		if (
			featureFlagCache.lastPath === path &&
			featureFlagCache.lastStatMtimeMs === stats.mtimeMs
		) {
			return featureFlagCache.lastKnownSnapshot;
		}

		const snapshot = JSON.parse(
			readFileSync(path, "utf8"),
		) as FeatureFlagSnapshot;
		featureFlagCache.lastKnownSnapshot = snapshot;
		featureFlagCache.lastPath = path;
		featureFlagCache.lastStatMtimeMs = stats.mtimeMs;
		return snapshot;
	} catch {
		if (featureFlagCache.lastPath !== path) {
			featureFlagCache.lastKnownSnapshot = null;
		}
		featureFlagCache.lastPath = path;
		featureFlagCache.lastStatMtimeMs = undefined;
		return featureFlagCache.lastKnownSnapshot;
	}
}

export function isFeatureFlagEnabled(key: string): boolean {
	const normalizedKey = key.trim();
	if (!normalizedKey) {
		return false;
	}

	const snapshot = readFeatureFlagSnapshot();
	if (!snapshot?.flags?.length) {
		return false;
	}

	return snapshot.flags.some(
		(flag) => flag?.key?.trim() === normalizedKey && flag.enabled === true,
	);
}

export function areAutonomousActionsDisabled(): boolean {
	return isFeatureFlagEnabled(MAESTRO_AUTONOMOUS_ACTIONS_KILL_SWITCH);
}

export function isDraftAndConfirmDefaultEnabled(): boolean {
	return isFeatureFlagEnabled(MAESTRO_DRAFT_AND_CONFIRM_DEFAULT_FLAG);
}

export function isPlatformRuntimeBridgeDisabled(): boolean {
	return isFeatureFlagEnabled(MAESTRO_PLATFORM_RUNTIME_BRIDGE_KILL_SWITCH);
}

export function isPlatformRuntimeObserveEnabled(): boolean {
	return isFeatureFlagEnabled(
		MAESTRO_PLATFORM_RUNTIME_AGENT_RUNTIME_OBSERVE_FLAG,
	);
}

export function isPlatformToolExecutionBridgeEnabled(): boolean {
	return isFeatureFlagEnabled(
		MAESTRO_PLATFORM_RUNTIME_TOOL_EXECUTION_BRIDGE_FLAG,
	);
}

export function resetFeatureFlagCacheForTests(): void {
	featureFlagCache.lastKnownSnapshot = null;
	featureFlagCache.lastPath = undefined;
	featureFlagCache.lastStatMtimeMs = undefined;
}
