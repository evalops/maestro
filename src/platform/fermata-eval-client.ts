import {
	EVALOPS_ACCESS_TOKEN_ENV_VARS,
	EVALOPS_ORGANIZATION_ID_ENV_VARS,
	EVALOPS_WORKSPACE_ID_ENV_VARS,
} from "../evalops/env-aliases.js";
import {
	type PlatformServiceConfig,
	normalizeBaseUrl,
	postPlatformConnect,
	resolvePlatformServiceConfig,
	trimString,
} from "./client.js";
import {
	PLATFORM_CONNECT_METHODS,
	platformConnectMethodPath,
	platformConnectServicePath,
} from "./core-services.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 1;

const CREATE_TEST_SUITE_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.fermata.createTestSuite,
);
const RUN_TEST_SUITE_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.fermataExecution.runTestSuite,
);

const FERMATA_BASE_URL_SUFFIXES = [
	CREATE_TEST_SUITE_PATH,
	RUN_TEST_SUITE_PATH,
	platformConnectServicePath(
		PLATFORM_CONNECT_METHODS.fermata.createTestSuite.service,
	),
	platformConnectServicePath(
		PLATFORM_CONNECT_METHODS.fermataExecution.runTestSuite.service,
	),
] as const;

const FERMATA_BASE_URL_ENV_VARS = [
	"FERMATA_SERVICE_URL",
	"MAESTRO_FERMATA_SERVICE_URL",
	"MAESTRO_FERMATA_EXECUTION_SERVICE_URL",
	"MAESTRO_PLATFORM_BASE_URL",
	"MAESTRO_EVALOPS_BASE_URL",
	"EVALOPS_BASE_URL",
] as const;

const FERMATA_TOKEN_ENV_VARS = [
	"FERMATA_SERVICE_TOKEN",
	"MAESTRO_FERMATA_SERVICE_TOKEN",
	"MAESTRO_FERMATA_EXECUTION_SERVICE_TOKEN",
	...EVALOPS_ACCESS_TOKEN_ENV_VARS,
] as const;

const FERMATA_ORGANIZATION_ENV_VARS = [
	"FERMATA_SERVICE_ORGANIZATION_ID",
	"MAESTRO_FERMATA_ORGANIZATION_ID",
	"MAESTRO_FERMATA_EXECUTION_ORGANIZATION_ID",
	...EVALOPS_ORGANIZATION_ID_ENV_VARS,
] as const;

const FERMATA_WORKSPACE_ENV_VARS = [
	"FERMATA_SERVICE_WORKSPACE_ID",
	"MAESTRO_FERMATA_WORKSPACE_ID",
	"MAESTRO_FERMATA_EXECUTION_WORKSPACE_ID",
	...EVALOPS_WORKSPACE_ID_ENV_VARS,
] as const;

const FERMATA_TIMEOUT_ENV_VARS = [
	"FERMATA_SERVICE_TIMEOUT_MS",
	"MAESTRO_FERMATA_SERVICE_TIMEOUT_MS",
	"MAESTRO_FERMATA_EXECUTION_SERVICE_TIMEOUT_MS",
] as const;

const FERMATA_MAX_ATTEMPTS_ENV_VARS = [
	"FERMATA_SERVICE_MAX_ATTEMPTS",
	"MAESTRO_FERMATA_SERVICE_MAX_ATTEMPTS",
	"MAESTRO_FERMATA_EXECUTION_SERVICE_MAX_ATTEMPTS",
] as const;

export type FermataAssertionKind =
	| "ASSERTION_KIND_CONTAINS"
	| "ASSERTION_KIND_NOT_CONTAINS"
	| "ASSERTION_KIND_REGEX"
	| "ASSERTION_KIND_SIMILARITY"
	| "ASSERTION_KIND_CUSTOM_JUDGE"
	| "ASSERTION_KIND_JSON_SCHEMA"
	| "ASSERTION_KIND_EQUALS"
	| "ASSERTION_KIND_STARTS_WITH"
	| "ASSERTION_KIND_CONTAINS_ANY"
	| "ASSERTION_KIND_CONTAINS_ALL"
	| "ASSERTION_KIND_WORD_COUNT"
	| "ASSERTION_KIND_NUMERIC_GTE"
	| "ASSERTION_KIND_NUMERIC_LTE"
	| "ASSERTION_KIND_TOOL_CALLED"
	| "ASSERTION_KIND_TOOL_NOT_CALLED"
	| "ASSERTION_KIND_TOOL_SEQUENCE"
	| "ASSERTION_KIND_TRACE_SPAN_COUNT"
	| "ASSERTION_KIND_TOOL_ARGS_MATCH"
	| "ASSERTION_KIND_TRACE_ERROR_SPANS"
	| "ASSERTION_KIND_TRACE_SPAN_DURATION"
	| "ASSERTION_KIND_TRACE_STEP_COUNT"
	| "ASSERTION_KIND_TOOL_CALL_F1"
	| "ASSERTION_KIND_LLM_RUBRIC";

export interface FermataLLMRubricAssertion {
	judgeId: string;
	verifierJudgeId?: string;
	rubric: string;
	minScore?: number;
	repeat?: number;
	quorum?: number;
	recordJudgeValidation?: boolean;
	requireCalibratedJudge?: boolean;
	minJudgeValidationAccuracy?: number;
	minJudgeValidationCount?: number;
}

export interface FermataAssertion {
	id?: string;
	kind: FermataAssertionKind;
	target?: string;
	expected?: string;
	description?: string;
	metadata?: Record<string, unknown>;
	llmRubric?: FermataLLMRubricAssertion;
}

export interface FermataTestCase {
	id?: string;
	name: string;
	input: string;
	expectedOutput?: string;
	assertions: FermataAssertion[];
	metadata?: Record<string, unknown>;
}

export interface FermataTestSuite {
	id?: string;
	organizationId?: string;
	workspaceId?: string;
	name?: string;
	description?: string;
	cases?: FermataTestCase[];
	metadata?: Record<string, unknown>;
}

export interface CreateFermataTestSuiteRequest {
	organizationId: string;
	workspaceId: string;
	name: string;
	description?: string;
	cases: FermataTestCase[];
	metadata?: Record<string, unknown>;
}

export interface CreateFermataTestSuiteResponse {
	suite: FermataTestSuite;
}

export interface FermataProviderRef {
	provider?: string;
	environment?: string;
	credentialName?: string;
	teamId?: string;
}

export interface FermataTestSuiteCandidate {
	candidateId: string;
	label?: string;
	model: string;
	providerRef?: FermataProviderRef;
	metadata?: Record<string, unknown>;
}

export interface RunFermataTestSuiteRequest {
	suiteId: string;
	organizationId: string;
	workspaceId: string;
	evaluationId?: string;
	model?: string;
	runContext?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	runIdPrefix?: string;
	traceId?: string;
	lineageId?: string;
	caseIds?: string[];
	maxConcurrency?: number;
	stopOnFirstFailure?: boolean;
	candidates?: FermataTestSuiteCandidate[];
}

export interface FermataAssertionResult {
	assertionId?: string;
	passed?: boolean;
	score?: number;
	actual?: string;
	message?: string;
	metadata?: Record<string, unknown>;
}

export interface FermataTestCaseRun {
	testCaseId?: string;
	testCaseName?: string;
	passed?: boolean;
	score?: number;
	output?: string;
	assertionResults?: FermataAssertionResult[];
	candidateId?: string;
	candidateLabel?: string;
	model?: string;
	providerRef?: FermataProviderRef;
}

export interface FermataTestSuiteCandidateSummary {
	candidateId?: string;
	candidateLabel?: string;
	model?: string;
	providerRef?: FermataProviderRef;
	totalCases?: number;
	passedCases?: number;
	failedCases?: number;
	score?: number;
	passRate?: number;
	passed?: boolean;
}

export interface FermataTestSuiteAssertionSummary {
	assertionId?: string;
	totalResults?: number;
	passedResults?: number;
	failedResults?: number;
	score?: number;
	passRate?: number;
	passed?: boolean;
	failedTestCaseIds?: string[];
	failedCandidateIds?: string[];
	failedModels?: string[];
}

export interface RunFermataTestSuiteResponse {
	evaluationId?: string;
	suite?: FermataTestSuite;
	caseResults?: FermataTestCaseRun[];
	passed?: boolean;
	score?: number;
	totalCases?: number;
	passedCases?: number;
	failedCases?: number;
	lineageId?: string;
	candidateSummaries?: FermataTestSuiteCandidateSummary[];
	assertionSummaries?: FermataTestSuiteAssertionSummary[];
}

export interface FermataEvalServiceConfig extends PlatformServiceConfig {}

function stripUndefinedValues(
	record: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record).filter(([, value]) => value !== undefined),
	);
}

async function parseJsonResponse(
	response: Response,
	serviceName: string,
): Promise<Record<string, unknown>> {
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`${serviceName} returned ${response.status}: ${text || response.statusText}`,
		);
	}
	if (!text.trim()) {
		throw new Error(`${serviceName} returned empty response`);
	}
	return JSON.parse(text) as Record<string, unknown>;
}

export async function resolveFermataEvalServiceConfig(
	overrides: Partial<FermataEvalServiceConfig> = {},
): Promise<FermataEvalServiceConfig | null> {
	const config = await resolvePlatformServiceConfig({
		baseUrlEnvVars: FERMATA_BASE_URL_ENV_VARS,
		tokenEnvVars: FERMATA_TOKEN_ENV_VARS,
		organizationEnvVars: FERMATA_ORGANIZATION_ENV_VARS,
		workspaceEnvVars: FERMATA_WORKSPACE_ENV_VARS,
		timeoutEnvVars: FERMATA_TIMEOUT_ENV_VARS,
		maxAttemptsEnvVars: FERMATA_MAX_ATTEMPTS_ENV_VARS,
		baseUrlSuffixes: FERMATA_BASE_URL_SUFFIXES,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
		requireBaseUrl: true,
		requireOrganizationId: true,
		requireToken: true,
		allowOAuthTokenFallback: false,
	});
	if (!config?.baseUrl || !config.workspaceId) {
		return null;
	}
	return {
		...config,
		baseUrl: normalizeBaseUrl(
			trimString(overrides.baseUrl ?? config.baseUrl) ?? config.baseUrl,
			FERMATA_BASE_URL_SUFFIXES,
		),
		organizationId:
			trimString(overrides.organizationId ?? config.organizationId) ??
			config.organizationId,
		workspaceId:
			trimString(overrides.workspaceId ?? config.workspaceId) ??
			config.workspaceId,
		token: trimString(overrides.token ?? config.token) ?? config.token,
		timeoutMs: overrides.timeoutMs ?? config.timeoutMs,
		maxAttempts: overrides.maxAttempts ?? config.maxAttempts,
		teamId: trimString(overrides.teamId ?? config.teamId),
	};
}

export async function requireFermataEvalServiceConfig(
	overrides: Partial<FermataEvalServiceConfig> = {},
): Promise<FermataEvalServiceConfig> {
	const config = await resolveFermataEvalServiceConfig(overrides);
	if (!config) {
		throw new Error(
			"Fermata eval integration requires FERMATA_SERVICE_URL, FERMATA_SERVICE_TOKEN, organization id, and workspace id",
		);
	}
	return config;
}

export async function createFermataTestSuiteWithPlatform(
	config: FermataEvalServiceConfig,
	request: CreateFermataTestSuiteRequest,
	signal?: AbortSignal,
): Promise<CreateFermataTestSuiteResponse> {
	const response = await postPlatformConnect(
		config,
		CREATE_TEST_SUITE_PATH,
		stripUndefinedValues({
			organizationId: request.organizationId,
			workspaceId: request.workspaceId,
			name: request.name,
			description: request.description,
			cases: request.cases,
			metadata: request.metadata,
		}),
		{
			serviceName: "fermata test suite service",
			failureMode: "required",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
			signal,
		},
	);
	const payload = await parseJsonResponse(
		response,
		"fermata test suite service",
	);
	return payload as unknown as CreateFermataTestSuiteResponse;
}

export async function runFermataTestSuiteWithPlatform(
	config: FermataEvalServiceConfig,
	request: RunFermataTestSuiteRequest,
	signal?: AbortSignal,
): Promise<RunFermataTestSuiteResponse> {
	const response = await postPlatformConnect(
		config,
		RUN_TEST_SUITE_PATH,
		stripUndefinedValues({
			suiteId: request.suiteId,
			organizationId: request.organizationId,
			workspaceId: request.workspaceId,
			evaluationId: request.evaluationId,
			model: request.model,
			runContext: request.runContext,
			metadata: request.metadata,
			runIdPrefix: request.runIdPrefix,
			traceId: request.traceId,
			lineageId: request.lineageId,
			caseIds: request.caseIds,
			maxConcurrency: request.maxConcurrency,
			stopOnFirstFailure: request.stopOnFirstFailure,
			candidates: request.candidates,
		}),
		{
			serviceName: "fermata test suite execution service",
			failureMode: "required",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
			signal,
		},
	);
	const payload = await parseJsonResponse(
		response,
		"fermata test suite execution service",
	);
	return payload as unknown as RunFermataTestSuiteResponse;
}
