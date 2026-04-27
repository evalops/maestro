import {
	type MaestroCloseReason,
	recordMaestroSessionEvent,
} from "@evalops/ai/telemetry";
import type { AgentConfig, Task } from "../types.js";

const DEFAULT_IDENTITY_URL = "http://127.0.0.1:8080";
const DEFAULT_PROVIDER_REF_PROVIDER = "openai";
const DEFAULT_PROVIDER_REF_ENVIRONMENT = "prod";
const DEFAULT_DELEGATION_TTL_SECONDS = 60 * 60;
const GITHUB_AGENT_EVENT_BUS_SOURCE = "maestro.github-agent";

interface EvalOpsProviderRef {
	provider: string;
	environment: string;
	credential_name?: string;
	team_id?: string;
}

interface IdentityDelegationResponse {
	error?: string;
	expires_at?: string;
	token?: string;
}

function cloneEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	return Object.fromEntries(
		Object.entries(env).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}

function getEnvValue(
	env: NodeJS.ProcessEnv,
	names: readonly string[],
): string | undefined {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

function getIdentityBaseUrl(env: NodeJS.ProcessEnv): string {
	return (
		getEnvValue(env, ["MAESTRO_IDENTITY_URL", "EVALOPS_IDENTITY_URL"]) ??
		DEFAULT_IDENTITY_URL
	).replace(/\/+$/, "");
}

function getOrganizationId(env: NodeJS.ProcessEnv): string | undefined {
	return getEnvValue(env, [
		"MAESTRO_EVALOPS_ORG_ID",
		"EVALOPS_ORGANIZATION_ID",
		"MAESTRO_ENTERPRISE_ORG_ID",
	]);
}

function getProviderRef(env: NodeJS.ProcessEnv): EvalOpsProviderRef {
	const credentialName = getEnvValue(env, [
		"MAESTRO_EVALOPS_CREDENTIAL_NAME",
		"MAESTRO_LLM_GATEWAY_CREDENTIAL_NAME",
	]);
	const teamID = getEnvValue(env, [
		"MAESTRO_EVALOPS_TEAM_ID",
		"MAESTRO_LLM_GATEWAY_TEAM_ID",
	]);

	return {
		provider:
			getEnvValue(env, [
				"MAESTRO_EVALOPS_PROVIDER",
				"MAESTRO_LLM_GATEWAY_PROVIDER",
			]) ?? DEFAULT_PROVIDER_REF_PROVIDER,
		environment:
			getEnvValue(env, [
				"MAESTRO_EVALOPS_ENVIRONMENT",
				"MAESTRO_LLM_GATEWAY_ENVIRONMENT",
			]) ?? DEFAULT_PROVIDER_REF_ENVIRONMENT,
		...(credentialName ? { credential_name: credentialName } : {}),
		...(teamID ? { team_id: teamID } : {}),
	};
}

function buildEvalOpsDelegationEnvironment(
	token: string,
	organizationId: string,
	providerRef: EvalOpsProviderRef,
): Record<string, string> {
	return {
		MAESTRO_EVALOPS_ACCESS_TOKEN: token,
		MAESTRO_EVALOPS_ORG_ID: organizationId,
		MAESTRO_EVALOPS_PROVIDER: providerRef.provider,
		MAESTRO_EVALOPS_ENVIRONMENT: providerRef.environment,
		...(providerRef.credential_name
			? {
					MAESTRO_EVALOPS_CREDENTIAL_NAME: providerRef.credential_name,
				}
			: {}),
		...(providerRef.team_id
			? { MAESTRO_EVALOPS_TEAM_ID: providerRef.team_id }
			: {}),
	};
}

function buildGitHubTaskRuntimeEnvironment(task: Task): Record<string, string> {
	return {
		MAESTRO_SURFACE: "github-agent",
		MAESTRO_RUNTIME_MODE: "headless",
		MAESTRO_EVENT_BUS_SOURCE: GITHUB_AGENT_EVENT_BUS_SOURCE,
		MAESTRO_AGENT_ID: getAgentType(task),
		MAESTRO_AGENT_RUN_ID: task.id,
		MAESTRO_SESSION_ID: task.id,
		MAESTRO_REQUEST_ID:
			task.sourceIssue === undefined
				? task.id
				: `github:${task.type}:${task.sourceIssue}`,
		MAESTRO_EVENT_BUS_ATTR_TASK_TYPE: task.type,
		MAESTRO_EVENT_BUS_ATTR_TASK_ID: task.id,
		...(task.sourceIssue === undefined
			? {}
			: { MAESTRO_EVENT_BUS_ATTR_SOURCE_ISSUE: String(task.sourceIssue) }),
	};
}

function buildGitHubTaskEventEnvironment(
	task: Task,
	env: NodeJS.ProcessEnv,
): Record<string, string> {
	return {
		...cloneEnv(env),
		...buildGitHubTaskRuntimeEnvironment(task),
	};
}

function buildGitHubTaskEventMetadata(
	task: Task,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	const metadata: Record<string, unknown> = {
		task_id: task.id,
		task_type: task.type,
		source_issue: task.sourceIssue,
		priority: task.priority,
		attempts: task.attempts,
		...extra,
	};
	return Object.fromEntries(
		Object.entries(metadata).filter(([, value]) => value !== undefined),
	);
}

export interface GitHubTaskSessionCloseInput {
	status: "completed" | "failed";
	branch?: string;
	prUrl?: string;
	durationMs?: number;
	tokensUsed?: number;
	cost?: number;
	error?: string;
}

function closeReasonForGitHubTask(
	status: GitHubTaskSessionCloseInput["status"],
): MaestroCloseReason {
	return status === "completed"
		? "MAESTRO_CLOSE_REASON_COMPLETED"
		: "MAESTRO_CLOSE_REASON_ERROR";
}

export function recordGitHubTaskSessionStarted(
	task: Task,
	env: NodeJS.ProcessEnv = process.env,
): void {
	recordMaestroSessionEvent("MAESTRO_SESSION_STATE_STARTED", {
		sessionId: task.id,
		metadata: buildGitHubTaskEventMetadata(task),
		env: buildGitHubTaskEventEnvironment(task, env),
	});
}

export function recordGitHubTaskSessionClosed(
	task: Task,
	input: GitHubTaskSessionCloseInput,
	env: NodeJS.ProcessEnv = process.env,
): void {
	recordMaestroSessionEvent("MAESTRO_SESSION_STATE_CLOSED", {
		sessionId: task.id,
		closeReason: closeReasonForGitHubTask(input.status),
		closeMessage: input.error,
		metadata: buildGitHubTaskEventMetadata(task, {
			status: input.status,
			branch: input.branch,
			pr_url: input.prUrl,
			duration_ms: input.durationMs,
			tokens_used: input.tokensUsed,
			cost: input.cost,
		}),
		env: buildGitHubTaskEventEnvironment(task, env),
	});
}

function getAgentType(task: Task): string {
	switch (task.type) {
		case "issue":
			return "github_issue_worker";
		case "pr-review":
			return "github_review_worker";
		case "pr-feedback":
			return "github_feedback_worker";
		case "self-improvement":
			return "github_self_improvement_worker";
	}
}

function getCapabilities(task: Task): string[] {
	switch (task.type) {
		case "issue":
			return ["github_issue_task"];
		case "pr-review":
			return ["github_review_task"];
		case "pr-feedback":
			return ["github_review_feedback"];
		case "self-improvement":
			return ["github_self_improvement_task"];
	}
}

export async function buildGitHubTaskEnvironment(
	task: Task,
	config: Pick<AgentConfig, "maxTokensPerTask">,
	env: NodeJS.ProcessEnv = process.env,
	onWarning?: (message: string) => void,
): Promise<Record<string, string>> {
	const baseEnv = {
		...cloneEnv(env),
		...buildGitHubTaskRuntimeEnvironment(task),
	};
	if (config.maxTokensPerTask && !baseEnv.MAESTRO_MAX_OUTPUT_TOKENS) {
		baseEnv.MAESTRO_MAX_OUTPUT_TOKENS = String(config.maxTokensPerTask);
	}

	const accessToken = getEnvValue(env, ["MAESTRO_EVALOPS_ACCESS_TOKEN"]);
	const organizationId = getOrganizationId(env);
	if (!accessToken || !organizationId) {
		return baseEnv;
	}

	try {
		const response = await fetch(
			`${getIdentityBaseUrl(env)}/v1/delegation-tokens`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					agent_id: task.id,
					agent_type: getAgentType(task),
					capabilities: getCapabilities(task),
					run_id: task.id,
					surface: "maestro-github-agent",
					ttl_seconds: DEFAULT_DELEGATION_TTL_SECONDS,
				}),
			},
		);

		let payload: IdentityDelegationResponse | undefined;
		try {
			payload = (await response.json()) as IdentityDelegationResponse;
		} catch {
			payload = undefined;
		}

		if (!response.ok || !payload?.token || !payload.expires_at) {
			throw new Error(
				payload?.error ?? "EvalOps delegation token request failed",
			);
		}

		return {
			...baseEnv,
			...buildEvalOpsDelegationEnvironment(
				payload.token,
				organizationId,
				getProviderRef(env),
			),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onWarning?.(
			`Failed to issue delegated EvalOps token for GitHub worker; using inherited auth: ${message}`,
		);
		return baseEnv;
	}
}
