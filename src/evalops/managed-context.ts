import chalk from "chalk";
import {
	type OAuthCredentials,
	getOAuthStorageRevision,
	loadOAuthCredentials,
} from "../oauth/storage.js";
import {
	EVALOPS_ACCESS_TOKEN_ENV_VARS,
	EVALOPS_INTEGRATION_PROFILE_ENV_VARS,
	EVALOPS_MEMORY_MODE_ENV_VARS,
	EVALOPS_ORGANIZATION_ID_ENV_VARS,
	EVALOPS_RUNTIME_OWNER_ENV_VARS,
	EVALOPS_SHIM_TYPE_ENV_VARS,
	EVALOPS_TRACE_MODE_ENV_VARS,
	EVALOPS_USER_ID_ENV_VARS,
	EVALOPS_WORKSPACE_ID_ENV_VARS,
	readEvalOpsEnv,
	trimEvalOpsEnvValue,
} from "./env-aliases.js";

type Env = Record<string, string | undefined>;

export type EvalOpsManagedTraceState = "live" | "not configured";
export type EvalOpsManagedEvidencePublisher = "EvalOps" | "none";
export type EvalOpsManagedInferenceState = "managed" | "local";

export interface EvalOpsManagedContext {
	accessToken?: string;
	agentId?: string;
	authenticated: boolean;
	controlPlaneEnvironment?: string;
	controlPlaneUrl?: string;
	evidencePublisher: EvalOpsManagedEvidencePublisher;
	expiresAt?: number;
	inference: EvalOpsManagedInferenceState;
	integrationProfile?: string;
	keyPrefix?: string;
	managed: boolean;
	memoryMode?: string;
	mode: "EvalOps managed" | "EvalOps authenticated" | "local";
	organizationId?: string;
	providerRef?: Record<string, unknown>;
	runId?: string;
	runtimeOwner?: string;
	sessionExpiresAt?: string;
	sessionId?: string;
	shimType?: string;
	traceIngestion: EvalOpsManagedTraceState;
	traceMode?: string;
	userEmail?: string;
	userId?: string;
	workspaceId?: string;
}

interface StoredAgentMcpMetadata {
	agentId?: string;
	apiKey?: string;
	endpoint?: string;
	integrationProfile?: string;
	keyPrefix?: string;
	memoryMode?: string;
	runId?: string;
	runtimeOwner?: string;
	sessionExpiresAt?: string;
	shimType?: string;
	traceMode?: string;
	workspaceId?: string;
}

export type LoadEvalOpsCredentials = () => OAuthCredentials | null;

const PROCESS_CREDENTIAL_CACHE_MS = 30_000;
const MANAGED_EVALOPS_ORGANIZATION_ID_ENV_VARS = [
	...EVALOPS_ORGANIZATION_ID_ENV_VARS,
	"MAESTRO_LLM_GATEWAY_ORG_ID",
	"MAESTRO_REMOTE_RUNNER_ORG_ID",
] as const;
const MANAGED_EVALOPS_WORKSPACE_ID_ENV_VARS = EVALOPS_WORKSPACE_ID_ENV_VARS;
let processCredentialCache:
	| {
			credentials: OAuthCredentials | null;
			expiresAt: number;
			revision: number;
	  }
	| undefined;

function nonEmptyString(value: unknown): string | undefined {
	return trimEvalOpsEnvValue(value);
}

function recordValue(
	record: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	return nonEmptyString(record?.[key]);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function storedAgentMcp(
	credentials: OAuthCredentials | null,
): StoredAgentMcpMetadata | undefined {
	const agentMcp = asRecord(credentials?.metadata?.agentMcp);
	if (!agentMcp) return undefined;
	return {
		agentId: recordValue(agentMcp, "agentId"),
		apiKey: recordValue(agentMcp, "apiKey"),
		endpoint: recordValue(agentMcp, "endpoint"),
		integrationProfile: recordValue(agentMcp, "integrationProfile"),
		keyPrefix: recordValue(agentMcp, "keyPrefix"),
		memoryMode: recordValue(agentMcp, "memoryMode"),
		runId: recordValue(agentMcp, "runId"),
		runtimeOwner: recordValue(agentMcp, "runtimeOwner"),
		sessionExpiresAt: recordValue(agentMcp, "sessionExpiresAt"),
		shimType: recordValue(agentMcp, "shimType"),
		traceMode: recordValue(agentMcp, "traceMode"),
		workspaceId: recordValue(agentMcp, "workspaceId"),
	};
}

function controlPlaneEnvironment(
	endpoint: string | undefined,
): string | undefined {
	if (!endpoint) return undefined;
	try {
		const parsed = new URL(endpoint);
		if (parsed.hostname === "app.evalops.dev") return "production";
		if (parsed.hostname === "staging.evalops.dev") return "staging";
		return parsed.hostname;
	} catch {
		return endpoint;
	}
}

function safeLoadCredentials(loadCredentials: LoadEvalOpsCredentials) {
	try {
		return loadCredentials();
	} catch {
		return null;
	}
}

function loadProcessEvalOpsCredentialsCached(): OAuthCredentials | null {
	const now = Date.now();
	const revision = getOAuthStorageRevision();
	if (
		processCredentialCache &&
		processCredentialCache.revision === revision &&
		processCredentialCache.expiresAt > now
	) {
		return processCredentialCache.credentials;
	}
	const credentials = loadOAuthCredentials("evalops");
	processCredentialCache = {
		credentials,
		expiresAt: now + PROCESS_CREDENTIAL_CACHE_MS,
		revision,
	};
	return credentials;
}

export function resolveManagedEvalOpsContext(
	env: Env = process.env,
	loadCredentials?: LoadEvalOpsCredentials,
): EvalOpsManagedContext {
	const credentials = safeLoadCredentials(
		loadCredentials ??
			(env === process.env ? loadProcessEvalOpsCredentialsCached : () => null),
	);
	const metadata = credentials?.metadata;
	const providerRef = asRecord(metadata?.providerRef);
	const agentMcp = storedAgentMcp(credentials);
	const accessToken =
		readEvalOpsEnv(env, EVALOPS_ACCESS_TOKEN_ENV_VARS) ??
		nonEmptyString(credentials?.access);
	const organizationId =
		readEvalOpsEnv(env, MANAGED_EVALOPS_ORGANIZATION_ID_ENV_VARS) ??
		nonEmptyString(metadata?.organizationId);
	const workspaceId =
		readEvalOpsEnv(env, MANAGED_EVALOPS_WORKSPACE_ID_ENV_VARS) ??
		agentMcp?.workspaceId ??
		organizationId;
	const agentId =
		readEvalOpsEnv(env, ["MAESTRO_AGENT_ID"]) ?? agentMcp?.agentId;
	const runId =
		readEvalOpsEnv(env, ["MAESTRO_AGENT_RUN_ID"]) ?? agentMcp?.runId;
	const authenticated = Boolean(accessToken || credentials);
	const managedAgentSession = Boolean(
		agentMcp?.apiKey ||
			(readEvalOpsEnv(env, EVALOPS_ACCESS_TOKEN_ENV_VARS) &&
				(agentId || runId)),
	);
	const managed = Boolean(organizationId && managedAgentSession);
	const mode = managed
		? "EvalOps managed"
		: authenticated
			? "EvalOps authenticated"
			: "local";

	return {
		accessToken,
		agentId,
		authenticated,
		controlPlaneEnvironment: controlPlaneEnvironment(agentMcp?.endpoint),
		controlPlaneUrl: agentMcp?.endpoint,
		evidencePublisher: managed ? "EvalOps" : "none",
		expiresAt: credentials?.expires,
		inference: managed ? "managed" : "local",
		integrationProfile:
			readEvalOpsEnv(env, EVALOPS_INTEGRATION_PROFILE_ENV_VARS) ??
			agentMcp?.integrationProfile,
		keyPrefix: agentMcp?.keyPrefix,
		managed,
		memoryMode:
			readEvalOpsEnv(env, EVALOPS_MEMORY_MODE_ENV_VARS) ?? agentMcp?.memoryMode,
		mode,
		organizationId,
		providerRef,
		runId,
		runtimeOwner:
			readEvalOpsEnv(env, EVALOPS_RUNTIME_OWNER_ENV_VARS) ??
			agentMcp?.runtimeOwner,
		sessionExpiresAt: agentMcp?.sessionExpiresAt,
		sessionId: readEvalOpsEnv(env, ["MAESTRO_SESSION_ID"]),
		shimType:
			readEvalOpsEnv(env, EVALOPS_SHIM_TYPE_ENV_VARS) ?? agentMcp?.shimType,
		traceIngestion: managed && runId ? "live" : "not configured",
		traceMode:
			readEvalOpsEnv(env, EVALOPS_TRACE_MODE_ENV_VARS) ?? agentMcp?.traceMode,
		userEmail: nonEmptyString(metadata?.email),
		userId:
			readEvalOpsEnv(env, EVALOPS_USER_ID_ENV_VARS) ??
			nonEmptyString(metadata?.userId),
		workspaceId,
	};
}

export function formatManagedEvalOpsStatus(
	context: EvalOpsManagedContext,
	options: { color?: boolean } = {},
): string {
	const color = options.color ?? true;
	const good = (value: string) => (color ? chalk.green(value) : value);
	const dim = (value: string) => (color ? chalk.dim(value) : value);
	const lines = [
		`${good("Mode")}: ${context.mode}`,
		`${good("Control plane")}: ${context.controlPlaneEnvironment ?? "not configured"}`,
	];
	if (context.controlPlaneUrl) {
		lines.push(`${dim("Control plane URL")}: ${context.controlPlaneUrl}`);
	}
	if (context.userEmail)
		lines.push(`${dim("Authenticated as")}: ${context.userEmail}`);
	if (context.organizationId)
		lines.push(`${dim("Organization")}: ${context.organizationId}`);
	if (context.workspaceId)
		lines.push(`${dim("Workspace")}: ${context.workspaceId}`);
	lines.push(
		`${good("Agent runtime")}: ${context.agentId ? "registered" : "not registered"}`,
	);
	if (context.agentId) lines.push(`${dim("Agent")}: ${context.agentId}`);
	if (context.runId) lines.push(`${dim("Run")}: ${context.runId}`);
	if (context.integrationProfile) {
		lines.push(`${dim("Integration profile")}: ${context.integrationProfile}`);
	}
	if (context.runtimeOwner)
		lines.push(`${dim("Runtime owner")}: ${context.runtimeOwner}`);
	if (context.shimType) lines.push(`${dim("Shim")}: ${context.shimType}`);
	if (context.traceMode)
		lines.push(`${dim("Trace mode")}: ${context.traceMode}`);
	if (context.memoryMode)
		lines.push(`${dim("Memory mode")}: ${context.memoryMode}`);
	lines.push(`${good("Trace ingestion")}: ${context.traceIngestion}`);
	lines.push(`${good("Evidence publisher")}: ${context.evidencePublisher}`);
	lines.push(`${good("Inference")}: ${context.inference}`);
	if (context.providerRef) {
		const provider = nonEmptyString(context.providerRef.provider) ?? "openai";
		const environment =
			nonEmptyString(context.providerRef.environment) ?? "prod";
		lines.push(`${dim("Provider ref")}: ${provider}/${environment}`);
	}
	if (context.keyPrefix) lines.push(`${dim("API key")}: ${context.keyPrefix}`);
	if (context.sessionExpiresAt) {
		lines.push(`${dim("Agent session expires")}: ${context.sessionExpiresAt}`);
	}
	if (context.expiresAt) {
		const remainingMs = Math.max(0, context.expiresAt - Date.now());
		const minutes = Math.round(remainingMs / 60_000);
		lines.push(
			`${dim("Access token")}: expires in ~${minutes} minute${minutes === 1 ? "" : "s"}`,
		);
	}
	return lines.join("\n");
}
