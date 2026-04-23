import { getWorkspaceConfigContext } from "../../server/request-context.js";
import type { WorkspaceConfig, WorkspacePolicyViolation } from "./types.js";

export class WorkspacePolicyViolationError extends Error {
	constructor(public readonly violation: WorkspacePolicyViolation) {
		super(violation.message);
		this.name = "WorkspacePolicyViolationError";
	}
}

function modelCandidates(provider: string, modelId: string): Set<string> {
	return new Set([modelId, `${provider}/${modelId}`]);
}

function listContainsCandidate(
	list: string[],
	candidates: Set<string>,
): boolean {
	return list.some((entry) => candidates.has(entry));
}

export function evaluateModelPolicy(
	config: WorkspaceConfig | null | undefined,
	params: {
		provider: string;
		modelId: string;
	},
): WorkspacePolicyViolation | null {
	if (!config) return null;
	const candidates = modelCandidates(params.provider, params.modelId);
	if (
		listContainsCandidate(config.modelPreferences.blockedModels, candidates)
	) {
		return {
			code: "model_blocked",
			workspaceId: config.workspaceId,
			message: `Model ${params.provider}/${params.modelId} is blocked by workspace policy.`,
		};
	}
	if (
		config.modelPreferences.allowedModels.length > 0 &&
		!listContainsCandidate(config.modelPreferences.allowedModels, candidates)
	) {
		return {
			code: "model_not_allowed",
			workspaceId: config.workspaceId,
			message: `Model ${params.provider}/${params.modelId} is not allowed by workspace policy.`,
		};
	}
	return null;
}

export function evaluateToolPolicy(
	config: WorkspaceConfig | null | undefined,
	toolName: string,
): WorkspacePolicyViolation | null {
	if (!config) return null;
	if (config.safetyRules.blockedTools.includes(toolName)) {
		return {
			code: "tool_blocked",
			workspaceId: config.workspaceId,
			message: `Tool ${toolName} is blocked by workspace policy.`,
		};
	}
	if (
		config.safetyRules.allowedTools.length > 0 &&
		!config.safetyRules.allowedTools.includes(toolName)
	) {
		return {
			code: "tool_not_allowed",
			workspaceId: config.workspaceId,
			message: `Tool ${toolName} is not allowed by workspace policy.`,
		};
	}
	return null;
}

export function evaluateSessionTokenPolicy(
	config: WorkspaceConfig | null | undefined,
	tokens: number,
): WorkspacePolicyViolation | null {
	if (!config) return null;
	const maxTokens =
		config.safetyRules.maxTokensPerSession ??
		config.rateLimits.maxTokensPerSession;
	if (maxTokens !== undefined && tokens > maxTokens) {
		return {
			code: "token_limit_exceeded",
			workspaceId: config.workspaceId,
			message: `Session token budget ${maxTokens} exceeded by requested ${tokens} tokens.`,
		};
	}
	return null;
}

export function assertModelAllowedByWorkspacePolicy(params: {
	provider: string;
	modelId: string;
}): void {
	const context = getWorkspaceConfigContext();
	const violation = evaluateModelPolicy(context?.config, params);
	if (violation) {
		throw new WorkspacePolicyViolationError(violation);
	}
}
