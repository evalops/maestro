const TOOL_EXECUTION_BASE_URL_ENV_VARS = [
	"TOOL_EXECUTION_SERVICE_URL",
	"MAESTRO_TOOL_EXECUTION_SERVICE_URL",
	"MAESTRO_PLATFORM_BASE_URL",
	"MAESTRO_EVALOPS_BASE_URL",
	"EVALOPS_BASE_URL",
];

const TOOL_EXECUTION_TOKEN_ENV_VARS = [
	"TOOL_EXECUTION_SERVICE_TOKEN",
	"MAESTRO_TOOL_EXECUTION_SERVICE_TOKEN",
	"MAESTRO_EVALOPS_ACCESS_TOKEN",
	"EVALOPS_TOKEN",
];

const TOOL_EXECUTION_ORGANIZATION_ENV_VARS = [
	"TOOL_EXECUTION_SERVICE_ORGANIZATION_ID",
	"MAESTRO_TOOL_EXECUTION_ORGANIZATION_ID",
	"MAESTRO_EVALOPS_ORG_ID",
	"EVALOPS_ORGANIZATION_ID",
	"EVALOPS_ORG_ID",
	"MAESTRO_ENTERPRISE_ORG_ID",
];

const TOOL_EXECUTION_WORKSPACE_ENV_VARS = [
	"TOOL_EXECUTION_SERVICE_WORKSPACE_ID",
	"MAESTRO_TOOL_EXECUTION_WORKSPACE_ID",
	"MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
	"MAESTRO_EVALOPS_WORKSPACE_ID",
	"EVALOPS_WORKSPACE_ID",
	"MAESTRO_WORKSPACE_ID",
];

const EXECUTE_TOOL_PATH = "/toolexecution.v1.ToolExecutionService/ExecuteTool";
const SERVICE_PATH = "/toolexecution.v1.ToolExecutionService";
const DEFAULT_TIMEOUT_MS = 2500;

function trimString(value) {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function firstEnvValue(env, names) {
	for (const name of names) {
		const value = trimString(env[name]);
		if (value) return value;
	}
	return undefined;
}

function stripTrailingSlashes(value) {
	return value.replace(/\/+$/u, "");
}

function normalizeBaseUrl(baseUrl) {
	let normalized = stripTrailingSlashes(baseUrl.trim());
	for (const suffix of [EXECUTE_TOOL_PATH, SERVICE_PATH]) {
		if (normalized.endsWith(suffix)) {
			normalized = stripTrailingSlashes(normalized.slice(0, -suffix.length));
		}
	}
	return normalized;
}

function parsePositiveInt(value, fallback) {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function githubContext(env) {
	const serverUrl = trimString(env.GITHUB_SERVER_URL) ?? "https://github.com";
	const repository = trimString(env.GITHUB_REPOSITORY);
	const runId = trimString(env.GITHUB_RUN_ID);
	const runAttempt = trimString(env.GITHUB_RUN_ATTEMPT);
	const runUrl =
		repository && runId
			? `${stripTrailingSlashes(serverUrl)}/${repository}/actions/runs/${runId}`
			: undefined;
	return {
		repository,
		runId,
		runAttempt,
		runUrl,
		workflow: trimString(env.GITHUB_WORKFLOW),
		job: trimString(env.GITHUB_JOB),
		sha: trimString(env.GITHUB_SHA),
		ref: trimString(env.GITHUB_REF),
		refName: trimString(env.GITHUB_REF_NAME),
		headRef: trimString(env.GITHUB_HEAD_REF),
		baseRef: trimString(env.GITHUB_BASE_REF),
		eventName: trimString(env.GITHUB_EVENT_NAME),
		actor: trimString(env.GITHUB_ACTOR),
	};
}

function stripUndefinedValues(record) {
	return Object.fromEntries(
		Object.entries(record).filter(([, value]) => value !== undefined),
	);
}

function metadataFromContext(context, summary, failures) {
	return stripUndefinedValues({
		source: "maestro.scenario_replay_gate",
		status: "failed",
		fixture_count: String(summary.fixtures ?? summary.results?.length ?? 0),
		failure_count: String(failures.length),
		github_repository: context.repository,
		github_run_id: context.runId,
		github_run_attempt: context.runAttempt,
		github_workflow: context.workflow,
		github_job: context.job,
		github_sha: context.sha,
		github_ref_name: context.refName,
		github_event_name: context.eventName,
		github_run_url: context.runUrl,
	});
}

function idempotencyKey(context) {
	const repository = context.repository ?? "local";
	const runId = context.runId ?? "manual";
	const runAttempt = context.runAttempt ?? "1";
	const sha = context.sha ?? "unknown";
	return `maestro:scenario-replay-gate:${repository}:${runId}:${runAttempt}:${sha}`;
}

export function resolveScenarioReplayGovernanceConfig(env = process.env) {
	const baseUrl = firstEnvValue(env, TOOL_EXECUTION_BASE_URL_ENV_VARS);
	const token = firstEnvValue(env, TOOL_EXECUTION_TOKEN_ENV_VARS);
	const organizationId = firstEnvValue(env, TOOL_EXECUTION_ORGANIZATION_ENV_VARS);
	const workspaceId = firstEnvValue(env, TOOL_EXECUTION_WORKSPACE_ENV_VARS);
	if (!baseUrl || !token || !organizationId || !workspaceId) {
		return null;
	}
	return {
		baseUrl: normalizeBaseUrl(baseUrl),
		token,
		organizationId,
		workspaceId,
		timeoutMs: parsePositiveInt(
			firstEnvValue(env, [
				"TOOL_EXECUTION_SERVICE_TIMEOUT_MS",
				"MAESTRO_TOOL_EXECUTION_SERVICE_TIMEOUT_MS",
			]),
			DEFAULT_TIMEOUT_MS,
		),
	};
}

export function buildScenarioReplayGovernanceRequest({
	config,
	summary,
	failures,
	env = process.env,
}) {
	const context = githubContext(env);
	const fixtureCount = summary.fixtures ?? summary.results?.length ?? 0;
	return {
		linkage: stripUndefinedValues({
			workspaceId: config.workspaceId,
			organizationId: config.organizationId,
			agentId:
				trimString(env.MAESTRO_SCENARIO_REPLAY_GATE_AGENT_ID) ??
				"github-actions:maestro-scenario-replay",
			runId: context.runId ? `github-actions:${context.runId}` : undefined,
			stepId: context.job ?? "scenario-replay",
			actorId: context.actor,
			surface: "SURFACE_MAESTRO",
			channelId: "github-actions",
			correlationId: context.runUrl ?? context.sha,
		}),
		tool: {
			namespace: "evalops.maestro",
			name: "scenario_replay_gate",
			capability: "scenario.replay.gate",
			operation: "run",
			idempotent: true,
			mutatesResource: false,
		},
		connector: stripUndefinedValues({
			providerId: "github-actions",
			resourceId: context.runUrl ?? context.runId,
			resourceKind: "ci_workflow_run",
		}),
		arguments: {
			status: "failed",
			generatedAt: summary.generatedAt,
			fixtureCount,
			failureCount: failures.length,
			failedFixtures: failures.map((failure) =>
				stripUndefinedValues({
					group: failure.group,
					fixture: failure.fixture,
					junitPath: failure.junitPath,
					exitCode: failure.exitCode,
					scenarioId: failure.scenarioId,
				}),
			),
			github: stripUndefinedValues(context),
		},
		riskLevel: "RISK_LEVEL_LOW",
		idempotencyKey: idempotencyKey(context),
		metadata: metadataFromContext(context, summary, failures),
	};
}

export async function postScenarioReplayGovernanceRequest({
	config,
	request,
	fetchImpl = globalThis.fetch,
}) {
	if (typeof fetchImpl !== "function") {
		throw new Error("fetch is not available in this Node.js runtime");
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
	try {
		const response = await fetchImpl(`${config.baseUrl}${EXECUTE_TOOL_PATH}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.token}`,
				"Connect-Protocol-Version": "1",
				"Content-Type": "application/json",
				"X-Organization-ID": config.organizationId,
			},
			body: JSON.stringify(request),
			signal: controller.signal,
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(
				`tool execution service returned ${response.status}: ${text || response.statusText}`,
			);
		}
		return text.trim() ? JSON.parse(text) : {};
	} finally {
		clearTimeout(timeout);
	}
}

export async function reportScenarioReplayGateFailure({
	summary,
	failures,
	env = process.env,
	fetchImpl,
}) {
	if (failures.length === 0) {
		return { reported: false, reason: "no_failures" };
	}
	const config = resolveScenarioReplayGovernanceConfig(env);
	if (!config) {
		console.warn(
			"Scenario replay governance reporter is not configured; skipping Platform ToolExecution evidence.",
		);
		return { reported: false, reason: "not_configured" };
	}
	const request = buildScenarioReplayGovernanceRequest({
		config,
		summary,
		failures,
		env,
	});
	try {
		const response = await postScenarioReplayGovernanceRequest({
			config,
			request,
			fetchImpl,
		});
		const executionId = response?.execution?.id;
		console.log(
			`Recorded scenario replay gate failure in Platform ToolExecution${executionId ? ` ${executionId}` : ""}.`,
		);
		return { reported: true, response };
	} catch (error) {
		console.warn(
			`Scenario replay governance reporter failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { reported: false, reason: "report_failed" };
	}
}
