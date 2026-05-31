export const SERVICE_AUTHORITY_MATRIX_VERSION =
	"evalops.maestro.service-authority.v1";

const PLATFORM_BASE_URL_ENV_NAMES = [
	"MAESTRO_PLATFORM_BASE_URL",
	"MAESTRO_EVALOPS_BASE_URL",
	"EVALOPS_BASE_URL",
	"PLATFORM_BASE_URL",
] as const;

export type MaestroServiceId =
	| "workspace_config"
	| "governance"
	| "approvals"
	| "traces"
	| "usage_analytics"
	| "intelligent_router"
	| "revenue_attribution"
	| "compliance";

export type ServiceAuthorityOwner = "platform" | "maestro";
export type ServiceAuthorityRuntimeMode =
	| "platform_authoritative"
	| "platform_unavailable"
	| "offline_adapter";

export interface ServiceAuthorityDescriptor {
	id: MaestroServiceId;
	displayName: string;
	owner: ServiceAuthorityOwner;
	localRole: "offline_adapter" | "cache" | "none";
	platformPrimitive: string;
	localFallbackAllowed: boolean;
}

export interface ServiceAuthorityResolution extends ServiceAuthorityDescriptor {
	matrixVersion: typeof SERVICE_AUTHORITY_MATRIX_VERSION;
	mode: ServiceAuthorityRuntimeMode;
	readAuthority: ServiceAuthorityOwner;
	writeAuthority: ServiceAuthorityOwner;
	localWritesAllowed: boolean;
	reason: string;
}

export const SERVICE_AUTHORITY_DESCRIPTORS: Record<
	MaestroServiceId,
	ServiceAuthorityDescriptor
> = {
	workspace_config: {
		id: "workspace_config",
		displayName: "Workspace policy and configuration",
		owner: "platform",
		localRole: "offline_adapter",
		platformPrimitive: "WorkspacePolicy",
		localFallbackAllowed: true,
	},
	governance: {
		id: "governance",
		displayName: "Governance policy and approvals",
		owner: "platform",
		localRole: "offline_adapter",
		platformPrimitive: "GovernancePolicy",
		localFallbackAllowed: true,
	},
	approvals: {
		id: "approvals",
		displayName: "Approval requests and decisions",
		owner: "platform",
		localRole: "offline_adapter",
		platformPrimitive: "ApprovalRequest",
		localFallbackAllowed: true,
	},
	traces: {
		id: "traces",
		displayName: "Execution traces and run timeline",
		owner: "platform",
		localRole: "cache",
		platformPrimitive: "MaestroTimeline",
		localFallbackAllowed: true,
	},
	usage_analytics: {
		id: "usage_analytics",
		displayName: "Usage, costs, and aggregate metrics",
		owner: "platform",
		localRole: "cache",
		platformPrimitive: "UsageMeter",
		localFallbackAllowed: true,
	},
	intelligent_router: {
		id: "intelligent_router",
		displayName: "Model routing decisions",
		owner: "platform",
		localRole: "offline_adapter",
		platformPrimitive: "ModelRouter",
		localFallbackAllowed: true,
	},
	revenue_attribution: {
		id: "revenue_attribution",
		displayName: "Revenue attribution",
		owner: "platform",
		localRole: "cache",
		platformPrimitive: "RevenueAttribution",
		localFallbackAllowed: false,
	},
	compliance: {
		id: "compliance",
		displayName: "Compliance controls and evidence",
		owner: "platform",
		localRole: "offline_adapter",
		platformPrimitive: "ComplianceEvidence",
		localFallbackAllowed: true,
	},
};

export function serviceAuthorityEnvName(serviceId: MaestroServiceId): string {
	return `MAESTRO_${serviceId.toUpperCase()}_AUTHORITY`;
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
	const value = env[key]?.trim().toLowerCase();
	return value ? value : undefined;
}

function envFlag(env: NodeJS.ProcessEnv, key: string): boolean {
	const value = envValue(env, key);
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

function platformConfigured(env: NodeJS.ProcessEnv): boolean {
	return PLATFORM_BASE_URL_ENV_NAMES.some((key) => Boolean(envValue(env, key)));
}

export function resolveServiceAuthority(
	serviceId: MaestroServiceId,
	env: NodeJS.ProcessEnv = process.env,
): ServiceAuthorityResolution {
	const descriptor = SERVICE_AUTHORITY_DESCRIPTORS[serviceId];
	const override =
		envValue(env, serviceAuthorityEnvName(serviceId)) ??
		envValue(env, "MAESTRO_SERVICE_AUTHORITY");
	const standalone =
		envFlag(env, "MAESTRO_STANDALONE") || envFlag(env, "MAESTRO_OFFLINE");
	const forceOffline =
		override === "offline" ||
		override === "local" ||
		override === "maestro" ||
		standalone;
	const forcePlatform = override === "platform";
	const usePlatform =
		descriptor.owner === "platform" &&
		(forcePlatform || (!forceOffline && platformConfigured(env)));

	if (usePlatform) {
		return {
			...descriptor,
			matrixVersion: SERVICE_AUTHORITY_MATRIX_VERSION,
			mode: "platform_authoritative",
			readAuthority: "platform",
			writeAuthority: "platform",
			localWritesAllowed: descriptor.localRole === "cache",
			reason: forcePlatform
				? "service-specific or global authority override selected Platform"
				: "Platform base URL is configured",
		};
	}

	if (!descriptor.localFallbackAllowed) {
		return {
			...descriptor,
			matrixVersion: SERVICE_AUTHORITY_MATRIX_VERSION,
			mode: "platform_unavailable",
			readAuthority: "platform",
			writeAuthority: "platform",
			localWritesAllowed: false,
			reason: forceOffline
				? "offline authority override requested but this service has no Maestro local fallback"
				: "Platform authority is unavailable and this service has no Maestro local fallback",
		};
	}

	return {
		...descriptor,
		matrixVersion: SERVICE_AUTHORITY_MATRIX_VERSION,
		mode: "offline_adapter",
		readAuthority: "maestro",
		writeAuthority: "maestro",
		localWritesAllowed: descriptor.localFallbackAllowed,
		reason: forceOffline
			? "offline authority override selected Maestro local adapter"
			: "Platform authority is unavailable; using Maestro local adapter",
	};
}

export function listServiceAuthorities(
	env: NodeJS.ProcessEnv = process.env,
): ServiceAuthorityResolution[] {
	return (Object.keys(SERVICE_AUTHORITY_DESCRIPTORS) as MaestroServiceId[])
		.sort()
		.map((serviceId) => resolveServiceAuthority(serviceId, env));
}
