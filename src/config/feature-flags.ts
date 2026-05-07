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

type FeatureFlagEnv = {
	EVALOPS_FEATURE_FLAGS_PATH?: string | undefined;
};

export const MAESTRO_EVALOPS_MANAGED_KILL_SWITCH =
	"platform.kill_switches.maestro.evalops_managed";
export const MAESTRO_AUTONOMOUS_ACTIONS_KILL_SWITCH =
	"platform.kill_switches.maestro.autonomous_actions";
export const MAESTRO_PLATFORM_RUNTIME_BRIDGE_KILL_SWITCH =
	"platform.kill_switches.maestro.platform_runtime_bridge";
export const MAESTRO_PLATFORM_EVENTS_KILL_SWITCH =
	"platform.kill_switches.maestro.platform_events";
export const MAESTRO_DRAFT_AND_CONFIRM_DEFAULT_FLAG =
	"maestro.agent_authority.draft_and_confirm_default";
export const MAESTRO_PLATFORM_EVENTS_PUBLISHER_FLAG =
	"maestro.platform_events.publisher_enabled";
export const MAESTRO_PLATFORM_RUNTIME_AGENT_RUNTIME_OBSERVE_FLAG =
	"maestro.platform_runtime.agent_runtime_observe";
export const MAESTRO_PLATFORM_RUNTIME_TOOL_EXECUTION_BRIDGE_FLAG =
	"maestro.platform_runtime.tool_execution_bridge";

export type FeatureFlagDecision = {
	key: string;
	metadata: Record<string, unknown>;
	reason: string;
	value: boolean;
	variant: string;
};

export type ExperimentAssignment = {
	assigned: boolean;
	bucket: number;
	experimentId: string;
	exposureRecorded: boolean;
	flagKey: string;
	holdoutId?: string;
	inHoldout: boolean;
	layerId?: string;
	metadata: Record<string, unknown>;
	namespaceEnd: number;
	namespaceStart: number;
	reason: string;
	subject: string;
	variant: string;
	variantBucket: number;
};

export type FeatureFlagRequestContext = {
	attributes?: Record<string, string | number | boolean | null | undefined>;
	subject: string;
};

export type FeatureFlagRemoteOptions = {
	baseUrl?: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
};

const DEFAULT_IN_CLUSTER_FLAG_CONTROL_URL =
	"http://flag-control-service.evalops.svc.cluster.local:8080";
const DEFAULT_OUT_OF_CLUSTER_FLAG_CONTROL_URL =
	"https://flags.internal.evalops.dev";
const DEFAULT_REMOTE_TIMEOUT_MS = 2_000;

function getFeatureFlagsPath(
	env: FeatureFlagEnv = process.env,
): string | undefined {
	const configured = env.EVALOPS_FEATURE_FLAGS_PATH?.trim();
	return configured ? configured : undefined;
}

function getFeatureFlagRemoteBaseUrl(): string {
	return (
		process.env.EVALOPS_FEATURE_FLAGS_URL?.trim() ||
		process.env.EVALOPS_FLAG_CONTROL_URL?.trim() ||
		(process.env.KUBERNETES_SERVICE_HOST
			? DEFAULT_IN_CLUSTER_FLAG_CONTROL_URL
			: DEFAULT_OUT_OF_CLUSTER_FLAG_CONTROL_URL)
	).replace(/\/+$/, "");
}

function getFeatureFlagRemoteHeaders(
	headers?: Record<string, string>,
): Record<string, string> {
	const merged: Record<string, string> = { ...(headers ?? {}) };
	const token =
		process.env.EVALOPS_FEATURE_FLAGS_BEARER_TOKEN?.trim() ||
		process.env.EVALOPS_FLAG_CONTROL_BEARER_TOKEN?.trim();
	const hasAuthorization = Object.keys(merged).some(
		(key) => key.toLowerCase() === "authorization",
	);
	if (token && !hasAuthorization) {
		merged.Authorization = `Bearer ${token}`;
	}
	return merged;
}

function readFeatureFlagSnapshot(
	env: FeatureFlagEnv = process.env,
): FeatureFlagSnapshot | null {
	const path = getFeatureFlagsPath(env);
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

export function isFeatureFlagSnapshotConfigured(
	env: FeatureFlagEnv = process.env,
): boolean {
	return getFeatureFlagsPath(env) !== undefined;
}

export function isFeatureFlagEnabled(
	key: string,
	env: FeatureFlagEnv = process.env,
): boolean {
	const normalizedKey = key.trim();
	if (!normalizedKey) {
		return false;
	}

	const snapshot = readFeatureFlagSnapshot(env);
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

export function areMaestroPlatformEventsDisabled(
	env: FeatureFlagEnv = process.env,
): boolean {
	return isFeatureFlagEnabled(MAESTRO_PLATFORM_EVENTS_KILL_SWITCH, env);
}

export function isMaestroPlatformEventsPublisherEnabled(
	env: FeatureFlagEnv = process.env,
): boolean {
	return isFeatureFlagEnabled(MAESTRO_PLATFORM_EVENTS_PUBLISHER_FLAG, env);
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

export async function evaluateFeatureFlag(
	key: string,
	context: FeatureFlagRequestContext,
	defaultValue = false,
	options: FeatureFlagRemoteOptions = {},
): Promise<FeatureFlagDecision> {
	const normalizedKey = key.trim();
	if (!normalizedKey) {
		return fallbackDecision(
			normalizedKey,
			context,
			defaultValue,
			"missing_key",
		);
	}

	try {
		const response = await postJSON(
			`${remoteBaseUrl(options)}/ofrep/v1/evaluate/flags/${encodeURIComponent(normalizedKey)}`,
			JSON.stringify({ context: remoteContext(context) }),
			options,
		);
		if (response.status === 404) {
			return fallbackDecision(
				normalizedKey,
				context,
				defaultValue,
				"not_found",
			);
		}
		if (!response.ok) {
			return fallbackDecision(
				normalizedKey,
				context,
				defaultValue,
				`remote_status_${response.status}`,
			);
		}

		const payload = (await response.json()) as {
			key?: string;
			metadata?: Record<string, unknown>;
			reason?: string;
			value?: unknown;
			variant?: string;
		};
		if (typeof payload.value !== "boolean") {
			return fallbackDecision(
				normalizedKey,
				context,
				defaultValue,
				"invalid_remote_value",
			);
		}
		const metadata = getRecord(payload.metadata);
		return {
			key: payload.key?.trim() || normalizedKey,
			metadata,
			reason:
				getString(metadata.flag_reason) || payload.reason?.trim() || "remote",
			value: payload.value,
			variant: payload.variant?.trim() || booleanVariant(payload.value),
		};
	} catch (error) {
		return fallbackDecision(
			normalizedKey,
			context,
			defaultValue,
			error instanceof Error ? error.message : "remote_error",
		);
	}
}

export async function assignExperiment(
	experimentId: string,
	context: FeatureFlagRequestContext,
	options: FeatureFlagRemoteOptions & {
		metadata?: Record<string, unknown>;
		recordExposure?: boolean;
	} = {},
): Promise<ExperimentAssignment> {
	const normalizedExperimentId = experimentId.trim();
	if (!normalizedExperimentId) {
		return missingAssignment(
			normalizedExperimentId,
			context,
			"missing_experiment_id",
		);
	}
	const subject = context.subject.trim();
	if (!subject) {
		return missingAssignment(
			normalizedExperimentId,
			context,
			"missing_subject",
		);
	}

	try {
		const response = await postJSON(
			`${remoteBaseUrl(options)}/api/experiments/${encodeURIComponent(normalizedExperimentId)}/assign`,
			JSON.stringify({
				context: remoteContext(context),
				metadata: options.metadata ?? {},
				record_exposure: options.recordExposure,
				subject,
			}),
			options,
		);
		if (response.status === 404) {
			return missingAssignment(
				normalizedExperimentId,
				context,
				"missing_experiment",
			);
		}
		if (!response.ok) {
			return missingAssignment(
				normalizedExperimentId,
				context,
				`remote_status_${response.status}`,
			);
		}

		const payload = (await response.json()) as Record<string, unknown>;
		return {
			assigned: payload.assigned === true,
			bucket: getNumber(payload.bucket),
			experimentId: getString(payload.experiment_id) || normalizedExperimentId,
			exposureRecorded: payload.exposure_recorded === true,
			flagKey: getString(payload.flag_key),
			holdoutId: getString(payload.holdout_id) || undefined,
			inHoldout: payload.in_holdout === true,
			layerId: getString(payload.layer_id) || undefined,
			metadata: getRecord(payload.metadata),
			namespaceEnd: getNumber(payload.namespace_end),
			namespaceStart: getNumber(payload.namespace_start),
			reason: getString(payload.reason) || "remote",
			subject: getString(payload.subject) || subject,
			variant: getString(payload.variant),
			variantBucket: getNumber(payload.variant_bucket),
		};
	} catch (error) {
		return missingAssignment(
			normalizedExperimentId,
			context,
			error instanceof Error ? error.message : "remote_error",
		);
	}
}

function remoteBaseUrl(options: FeatureFlagRemoteOptions): string {
	const configured = options.baseUrl?.trim().replace(/\/+$/, "");
	return configured || getFeatureFlagRemoteBaseUrl();
}

function remoteContext(
	context: FeatureFlagRequestContext,
): Record<string, string | number | boolean> {
	const remote: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(context.attributes ?? {})) {
		const normalizedKey = key.trim();
		if (!normalizedKey || value == null) {
			continue;
		}
		if (normalizedKey === "subject" || normalizedKey === "targetingKey") {
			continue;
		}
		if (typeof value === "string") {
			const normalizedValue = value.trim();
			if (normalizedValue) {
				remote[normalizedKey] = normalizedValue;
			}
			continue;
		}
		remote[normalizedKey] = value;
	}
	const subject = context.subject.trim();
	if (subject) {
		remote.subject = subject;
		remote.targetingKey = subject;
	}
	return remote;
}

function remoteTimeoutMs(
	options: FeatureFlagRemoteOptions,
): number | undefined {
	if (options.timeoutMs == null) {
		return DEFAULT_REMOTE_TIMEOUT_MS;
	}
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
		return undefined;
	}
	return Math.max(1, Math.trunc(options.timeoutMs));
}

async function postJSON(
	url: string,
	body: string,
	options: FeatureFlagRemoteOptions,
): Promise<Response> {
	const controller = new AbortController();
	const timeoutMs = remoteTimeoutMs(options);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	if (timeoutMs != null) {
		timeout = setTimeout(() => controller.abort(), timeoutMs);
	}
	try {
		return await fetch(url, {
			body,
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				...getFeatureFlagRemoteHeaders(options.headers),
			},
			method: "POST",
			signal: controller.signal,
		});
	} finally {
		if (timeout != null) {
			clearTimeout(timeout);
		}
	}
}

function fallbackDecision(
	key: string,
	context: FeatureFlagRequestContext,
	defaultValue: boolean,
	reason: string,
): FeatureFlagDecision {
	return {
		key,
		metadata: {
			fallback_used: true,
			flag_subject: context.subject.trim(),
		},
		reason,
		value: defaultValue,
		variant: booleanVariant(defaultValue),
	};
}

function missingAssignment(
	experimentId: string,
	context: FeatureFlagRequestContext,
	reason: string,
): ExperimentAssignment {
	return {
		assigned: false,
		bucket: 0,
		experimentId,
		exposureRecorded: false,
		flagKey: "",
		inHoldout: false,
		metadata: { fallback_used: true },
		namespaceEnd: 0,
		namespaceStart: 0,
		reason,
		subject: context.subject.trim(),
		variant: "",
		variantBucket: 0,
	};
}

function booleanVariant(value: boolean): string {
	return value ? "true" : "false";
}

function getRecord(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function getString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function getNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function resetFeatureFlagCacheForTests(): void {
	featureFlagCache.lastKnownSnapshot = null;
	featureFlagCache.lastPath = undefined;
	featureFlagCache.lastStatMtimeMs = undefined;
}
