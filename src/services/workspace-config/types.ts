export interface WorkspaceModelPreferences {
	defaultModel?: string;
	preferredProvider?: string;
	allowedModels: string[];
	blockedModels: string[];
}

export interface WorkspaceSafetyRules {
	allowedTools: string[];
	blockedTools: string[];
	requiredSkills: string[];
	fileBoundaries: string[];
	requireApprovals?: boolean;
	maxTokensPerSession?: number;
}

export interface WorkspaceRateLimits {
	requestsPerMinute?: number;
	tokensPerMinute?: number;
	maxConcurrentSessions?: number;
	maxTokensPerSession?: number;
}

export interface WorkspaceConfigInput {
	workspaceId: string;
	modelPreferences?: Partial<WorkspaceModelPreferences>;
	safetyRules?: Partial<WorkspaceSafetyRules>;
	rateLimits?: Partial<WorkspaceRateLimits>;
}

export interface WorkspaceConfigPatchInput {
	modelPreferences?: Partial<WorkspaceModelPreferences>;
	safetyRules?: Partial<WorkspaceSafetyRules>;
	rateLimits?: Partial<WorkspaceRateLimits>;
}

export interface WorkspaceConfig {
	workspaceId: string;
	modelPreferences: WorkspaceModelPreferences;
	safetyRules: WorkspaceSafetyRules;
	rateLimits: WorkspaceRateLimits;
	createdAt: string;
	updatedAt: string;
}

export interface WorkspaceConfigSummary {
	workspaceId: string;
	modelPreferences: WorkspaceModelPreferences;
	safetyRules: WorkspaceSafetyRules;
	rateLimits: WorkspaceRateLimits;
	createdAt: string;
	updatedAt: string;
}

export interface WorkspaceConfigListQuery {
	limit: number;
	offset: number;
}

export interface WorkspaceConfigListResult {
	configs: WorkspaceConfigSummary[];
	pagination: {
		limit: number;
		offset: number;
		nextOffset?: number;
		hasMore: boolean;
	};
}

export interface WorkspaceConfigRequestContext {
	workspaceId: string;
	config: WorkspaceConfig | null;
	source: "database" | "missing" | "unconfigured";
}

export interface WorkspacePolicyViolation {
	code:
		| "model_blocked"
		| "model_not_allowed"
		| "tool_blocked"
		| "tool_not_allowed"
		| "token_limit_exceeded"
		| "file_boundary_violation";
	message: string;
	workspaceId: string;
}
