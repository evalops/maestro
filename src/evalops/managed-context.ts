import chalk from "chalk";
import {
	type OAuthCredentials,
	getOAuthStorageRevision,
	loadOAuthCredentials,
} from "../oauth/storage.js";

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
	keyPrefix?: string;
	managed: boolean;
	mode: "EvalOps managed" | "EvalOps authenticated" | "local";
	organizationId?: string;
	providerRef?: Record<string, unknown>;
	runId?: string;
	sessionExpiresAt?: string;
	sessionId?: string;
	traceIngestion: EvalOpsManagedTraceState;
	userEmail?: string;
	userId?: string;
	workspaceId?: string;
}

interface StoredAgentMcpMetadata {
	agentId?: string;
	apiKey?: string;
	endpoint?: string;
	keyPrefix?: string;
	runId?: string;
	sessionExpiresAt?: string;
	workspaceId?: string;
}

export type LoadEvalOpsCredentials = () => OAuthCredentials | null;

const PROCESS_CREDENTIAL_CACHE_MS = 30_000;
let processCredentialCache:
	| {
			credentials: OAuthCredentials | null;
			expiresAt: number;
			revision: number;
	  }
	| undefined;

const ORG_ENV = [
	"MAESTRO_EVALOPS_ORG_ID",
	"EVALOPS_ORGANIZATION_ID",
	"EVALOPS_ORG_ID",
	"MAESTRO_ENTERPRISE_ORG_ID",
	"MAESTRO_LLM_GATEWAY_ORG_ID",
	"MAESTRO_REMOTE_RUNNER_ORG_ID",
] as const;

const WORKSPACE_ENV = [
	"MAESTRO_EVALOPS_WORKSPACE_ID",
	"EVALOPS_WORKSPACE_ID",
	"MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
	"MAESTRO_WORKSPACE_ID",
] as const;

const USER_ENV = [
	"MAESTRO_EVALOPS_USER_ID",
	"EVALOPS_USER_ID",
	"MAESTRO_USER_ID",
] as const;

const TOKEN_ENV = ["MAESTRO_EVALOPS_ACCESS_TOKEN", "EVALOPS_TOKEN"] as const;

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function readEnv(env: Env, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = nonEmptyString(env[name]);
		if (value) return value;
	}
	return undefined;
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
		keyPrefix: recordValue(agentMcp, "keyPrefix"),
		runId: recordValue(agentMcp, "runId"),
		sessionExpiresAt: recordValue(agentMcp, "sessionExpiresAt"),
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
		readEnv(env, TOKEN_ENV) ?? nonEmptyString(credentials?.access);
	const organizationId =
		readEnv(env, ORG_ENV) ?? nonEmptyString(metadata?.organizationId);
	const workspaceId =
		readEnv(env, WORKSPACE_ENV) ?? agentMcp?.workspaceId ?? organizationId;
	const agentId = readEnv(env, ["MAESTRO_AGENT_ID"]) ?? agentMcp?.agentId;
	const runId = readEnv(env, ["MAESTRO_AGENT_RUN_ID"]) ?? agentMcp?.runId;
	const authenticated = Boolean(accessToken || credentials);
	const managedAgentSession = Boolean(
		agentMcp?.apiKey || (readEnv(env, TOKEN_ENV) && (agentId || runId)),
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
		keyPrefix: agentMcp?.keyPrefix,
		managed,
		mode,
		organizationId,
		providerRef,
		runId,
		sessionExpiresAt: agentMcp?.sessionExpiresAt,
		sessionId: readEnv(env, ["MAESTRO_SESSION_ID"]),
		traceIngestion: managed && runId ? "live" : "not configured",
		userEmail: nonEmptyString(metadata?.email),
		userId: readEnv(env, USER_ENV) ?? nonEmptyString(metadata?.userId),
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
