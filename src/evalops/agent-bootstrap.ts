import { hostname } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getOAuthToken, hasOAuthCredentials, login } from "../oauth/index.js";
import {
	type OAuthCredentials,
	loadOAuthCredentials,
	saveOAuthCredentials,
} from "../oauth/storage.js";
import { getPackageVersion } from "../package-metadata.js";
import { getEnvValue, normalizeBaseUrl } from "../platform/client.js";
import { PLATFORM_HTTP_ROUTES } from "../platform/core-services.js";

const DEFAULT_AGENT_MCP_BASE_URL = "https://app.evalops.dev";
const DEFAULT_IDENTITY_BASE_URL = "https://identity.evalops.dev";
const AGENT_MCP_MANIFEST_PATH = "/.well-known/evalops/agent-mcp.json";
const AGENT_MCP_PATH = "/mcp";
const DEFAULT_AGENT_TYPE = "maestro";
const DEFAULT_SURFACE = "cli";
const DEFAULT_API_KEY_SCOPES = [
	"agent:register",
	"agent:heartbeat",
	"governance:evaluate",
	"llm_gateway:invoke",
	"memories:read",
	"memories:write",
	"meter:record",
];

export interface EvalOpsInitOptions {
	agentType?: string;
	apiKeyScopes?: string[];
	expiresInDays?: number;
	forceLogin?: boolean;
	integrationProfile?: string;
	json?: boolean;
	keyName?: string;
	manifestUrl?: string;
	memoryMode?: string;
	mcpUrl?: string;
	registerScopes?: string[];
	rotateKey?: boolean;
	runtimeOwner?: string;
	shimType?: string;
	surface?: string;
	traceMode?: string;
	ttlSeconds?: number;
	workspaceId?: string;
}

export interface EvalOpsAgentMcpMetadata {
	agentId?: string;
	apiKey?: string;
	createdAt: string;
	endpoint: string;
	expiresAt?: string;
	integrationProfile?: string;
	keyId?: string;
	keyName?: string;
	keyPrefix?: string;
	manifestUrl?: string;
	memoryMode?: string;
	registeredAt: string;
	registryVisible?: boolean;
	runId?: string;
	runtimeOwner?: string;
	scopes?: string[];
	sessionExpiresAt?: string;
	shimType?: string;
	surface: string;
	traceMode?: string;
	type: "agent-mcp";
	workspaceId?: string;
}

export interface EvalOpsInitResult {
	agentId?: string;
	apiKeyCreated: boolean;
	approvalPolicyAttached?: boolean;
	authenticatedAs?: string;
	consoleUrl?: string;
	endpoint: string;
	evidenceEventPublished?: boolean;
	evidenceEvents?: number;
	governedActionsLoaded?: number;
	governedInferenceCheckRan?: boolean;
	integrationProfile?: string;
	keyPrefix?: string;
	manifestUrl?: string;
	memoryMode?: string;
	organizationId?: string;
	registryVisible?: boolean;
	riskFindings?: number;
	runId?: string;
	runtimeOwner?: string;
	scopesGranted?: string[];
	sessionExpiresAt?: string;
	shimType?: string;
	stored: boolean;
	traceIngestionStarted?: boolean;
	traceMode?: string;
}

export interface EvalOpsInitStatus {
	message: string;
}

export interface EvalOpsInitDependencies {
	createMcpClient?: (endpoint: string, bearerToken: string) => EvalOpsMcpClient;
	fetch?: typeof fetch;
	getOAuthToken?: typeof getOAuthToken;
	hasOAuthCredentials?: typeof hasOAuthCredentials;
	loadCredentials?: typeof loadOAuthCredentials;
	login?: typeof login;
	now?: () => Date;
	onAuthUrl?: (url: string) => void;
	onStatus?: (status: EvalOpsInitStatus) => void;
	saveCredentials?: typeof saveOAuthCredentials;
}

export interface EvalOpsMcpClient {
	callTool(
		name: string,
		args: Record<string, unknown>,
	): Promise<CallToolResult>;
	close(): Promise<void>;
	connect(): Promise<void>;
}

interface CreateAPIKeyOutput {
	api_key: string;
	expires_at?: string;
	key_id?: string;
	name?: string;
	prefix?: string;
	scopes?: string[];
}

interface CreateAPIKeyHTTPOutput extends Partial<CreateAPIKeyOutput> {
	error?: string;
	key?: Record<string, unknown>;
	scopes_granted?: unknown;
}

interface RegisterOutput {
	agent_id?: string;
	expires_at?: string;
	integration_profile?: string;
	memory_mode?: string;
	registered?: boolean;
	registry_visible?: boolean;
	run_id?: string;
	runtime_owner?: string;
	scopes_denied?: string[];
	scopes_granted?: string[];
	shim_type?: string;
	trace_mode?: string;
}

interface CheckActionOutput {
	decision?: string;
	risk_level?: string;
	reasons?: string[];
}

interface ControlPlaneSummaryOutput {
	evidence?: unknown[];
	findings?: unknown[];
	metrics?: {
		approval_required_tools?: number;
		high_risk_tools?: number;
		total_tools?: number;
	};
	policy_controls?: unknown[];
	tools?: unknown[];
}

interface AgentMcpEndpoint {
	endpoint: string;
	identityBaseUrl?: string;
	manifestUrl?: string;
	preferDerivedIdentity?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const values = value
		.map((entry) => nonEmptyString(entry))
		.filter((entry): entry is string => Boolean(entry));
	return values.length > 0 ? values : undefined;
}

function positiveInteger(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

function getStoredAgentMcpMetadata(
	credentials: OAuthCredentials | null,
): EvalOpsAgentMcpMetadata | undefined {
	const metadata = credentials?.metadata;
	const agentMcp = isRecord(metadata?.agentMcp) ? metadata.agentMcp : undefined;
	const apiKey = nonEmptyString(agentMcp?.apiKey);
	const endpoint = nonEmptyString(agentMcp?.endpoint);
	const registeredAt = nonEmptyString(agentMcp?.registeredAt);
	const createdAt = nonEmptyString(agentMcp?.createdAt);
	const surface = nonEmptyString(agentMcp?.surface);
	if (!apiKey || !endpoint || !registeredAt || !createdAt || !surface) {
		return undefined;
	}
	return {
		type: "agent-mcp",
		apiKey,
		createdAt,
		endpoint,
		registeredAt,
		surface,
		agentId: nonEmptyString(agentMcp?.agentId),
		expiresAt: nonEmptyString(agentMcp?.expiresAt),
		integrationProfile: nonEmptyString(agentMcp?.integrationProfile),
		keyId: nonEmptyString(agentMcp?.keyId),
		keyName: nonEmptyString(agentMcp?.keyName),
		keyPrefix: nonEmptyString(agentMcp?.keyPrefix),
		manifestUrl: nonEmptyString(agentMcp?.manifestUrl),
		memoryMode: nonEmptyString(agentMcp?.memoryMode),
		registryVisible:
			typeof agentMcp?.registryVisible === "boolean"
				? agentMcp.registryVisible
				: undefined,
		runId: nonEmptyString(agentMcp?.runId),
		runtimeOwner: nonEmptyString(agentMcp?.runtimeOwner),
		scopes: stringArray(agentMcp?.scopes),
		sessionExpiresAt: nonEmptyString(agentMcp?.sessionExpiresAt),
		shimType: nonEmptyString(agentMcp?.shimType),
		traceMode: nonEmptyString(agentMcp?.traceMode),
		workspaceId: nonEmptyString(agentMcp?.workspaceId),
	};
}

export function getStoredEvalOpsAgentMcpMetadata():
	| EvalOpsAgentMcpMetadata
	| undefined {
	return getStoredAgentMcpMetadata(loadOAuthCredentials("evalops"));
}

function normalizeMcpEndpoint(url: string): string {
	const normalized = normalizeBaseUrl(url);
	const parsed = new URL(normalized);
	if (
		parsed.pathname === "" ||
		parsed.pathname === "/" ||
		parsed.pathname === AGENT_MCP_MANIFEST_PATH
	) {
		parsed.pathname = AGENT_MCP_PATH;
		parsed.search = "";
		parsed.hash = "";
	}
	return normalizeBaseUrl(parsed.toString());
}

function normalizeManifestUrl(url: string): string {
	const normalized = normalizeBaseUrl(url);
	const parsed = new URL(normalized);
	if (parsed.pathname === "" || parsed.pathname === "/") {
		parsed.pathname = AGENT_MCP_MANIFEST_PATH;
	}
	return parsed.toString();
}

function resolveIdentityBaseUrl(
	credentials: OAuthCredentials | null,
	endpoint?: AgentMcpEndpoint,
): string {
	const configured = getEnvValue([
		"MAESTRO_IDENTITY_URL",
		"EVALOPS_IDENTITY_URL",
		"MAESTRO_PLATFORM_BASE_URL",
		"MAESTRO_EVALOPS_BASE_URL",
		"EVALOPS_BASE_URL",
	]);
	const stored =
		typeof credentials?.metadata?.identityBaseUrl === "string"
			? credentials.metadata.identityBaseUrl
			: undefined;
	const derived = identityBaseUrlFromMcpEndpoint(endpoint?.endpoint);
	const storedBeforeDerived = endpoint
		? !endpoint.preferDerivedIdentity && isCustomMcpEndpoint(endpoint.endpoint)
		: false;
	return normalizeBaseUrl(
		configured ??
			endpoint?.identityBaseUrl ??
			(endpoint?.preferDerivedIdentity ? derived : undefined) ??
			(storedBeforeDerived ? stored : undefined) ??
			derived ??
			stored ??
			DEFAULT_IDENTITY_BASE_URL,
		Object.values(PLATFORM_HTTP_ROUTES.identity),
	);
}

function isCustomMcpEndpoint(endpoint: string): boolean {
	const parsed = new URL(normalizeBaseUrl(endpoint));
	return (
		parsed.hostname !== "app.evalops.dev" &&
		parsed.hostname !== "staging.evalops.dev"
	);
}

function identityBaseUrlFromMcpEndpoint(
	endpoint: string | undefined,
): string | undefined {
	if (!endpoint) {
		return undefined;
	}
	const parsed = new URL(normalizeBaseUrl(endpoint));
	if (parsed.hostname === "app.evalops.dev") {
		return DEFAULT_IDENTITY_BASE_URL;
	}
	if (parsed.hostname === "staging.evalops.dev") {
		return "https://api.staging.evalops.dev";
	}
	if (parsed.hostname.startsWith("app.")) {
		parsed.hostname = `identity.${parsed.hostname.slice("app.".length)}`;
	}
	parsed.pathname = "";
	parsed.search = "";
	parsed.hash = "";
	return normalizeBaseUrl(parsed.toString());
}

async function resolveEndpointFromManifest(
	manifestUrl: string,
	fetchImpl: typeof fetch,
): Promise<AgentMcpEndpoint> {
	const response = await fetchImpl(manifestUrl, {
		headers: { accept: "application/json" },
	});
	if (!response.ok) {
		throw new Error(
			`Failed to fetch EvalOps MCP manifest (${response.status} ${response.statusText})`,
		);
	}
	const payload = (await response.json()) as unknown;
	const payloadRecord = isRecord(payload) ? payload : undefined;
	const protocol =
		payloadRecord && isRecord(payloadRecord.protocol)
			? payloadRecord.protocol
			: undefined;
	const endpoint = nonEmptyString(protocol?.endpoint);
	if (!endpoint) {
		throw new Error("EvalOps MCP manifest did not include protocol.endpoint");
	}
	const identity = payloadRecord?.identity;
	const identityBaseUrl =
		nonEmptyString(isRecord(identity) ? identity.base_url : undefined) ??
		nonEmptyString(isRecord(identity) ? identity.baseUrl : undefined) ??
		nonEmptyString(isRecord(identity) ? identity.url : undefined) ??
		nonEmptyString(payloadRecord?.identity_base_url) ??
		nonEmptyString(payloadRecord?.identityBaseUrl);
	return {
		endpoint: normalizeMcpEndpoint(endpoint),
		identityBaseUrl,
		manifestUrl,
		preferDerivedIdentity: true,
	};
}

async function resolveAgentMcpEndpoint(
	options: EvalOpsInitOptions,
	deps: Required<Pick<EvalOpsInitDependencies, "fetch" | "loadCredentials">>,
): Promise<AgentMcpEndpoint> {
	if (options.mcpUrl) {
		return {
			endpoint: normalizeMcpEndpoint(options.mcpUrl),
			preferDerivedIdentity: true,
		};
	}
	if (options.manifestUrl) {
		return resolveEndpointFromManifest(
			normalizeManifestUrl(options.manifestUrl),
			deps.fetch,
		);
	}

	const configuredMcpUrl = getEnvValue([
		"MAESTRO_PLATFORM_MCP_URL",
		"MAESTRO_AGENT_MCP_URL",
		"MAESTRO_EVALOPS_AGENT_MCP_URL",
	]);
	if (configuredMcpUrl) {
		return {
			endpoint: normalizeMcpEndpoint(configuredMcpUrl),
			preferDerivedIdentity: true,
		};
	}

	const configuredManifestUrl = getEnvValue([
		"MAESTRO_PLATFORM_MCP_MANIFEST_URL",
		"MAESTRO_AGENT_MCP_MANIFEST_URL",
		"MAESTRO_EVALOPS_AGENT_MCP_MANIFEST_URL",
	]);
	if (configuredManifestUrl) {
		return resolveEndpointFromManifest(
			normalizeManifestUrl(configuredManifestUrl),
			deps.fetch,
		);
	}

	const stored = getStoredAgentMcpMetadata(deps.loadCredentials("evalops"));
	if (stored?.endpoint) {
		return {
			endpoint: normalizeMcpEndpoint(stored.endpoint),
			manifestUrl: stored.manifestUrl,
		};
	}

	return resolveEndpointFromManifest(
		`${DEFAULT_AGENT_MCP_BASE_URL}${AGENT_MCP_MANIFEST_PATH}`,
		deps.fetch,
	);
}

function createDefaultMcpClient(
	endpoint: string,
	bearerToken: string,
): EvalOpsMcpClient {
	const client = new Client(
		{
			name: "maestro",
			version: getPackageVersion(),
		},
		{
			capabilities: {},
		},
	);
	const headers = {
		accept: "application/json, text/event-stream",
		"content-type": "application/json",
		...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
	};
	const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
		requestInit: {
			headers,
		},
	});
	return {
		callTool: (name, args) =>
			client.callTool({
				name,
				arguments: args,
			}) as Promise<CallToolResult>,
		close: () => client.close(),
		connect: () => client.connect(transport),
	};
}

async function callConnectedMcpTool<T>(
	client: EvalOpsMcpClient,
	toolName: string,
	args: Record<string, unknown>,
): Promise<T> {
	const result = await client.callTool(toolName, args);
	if (result.isError) {
		throw new Error(`${toolName} returned an MCP error`);
	}
	return parseToolOutput<T>(toolName, result);
}

function parseToolOutput<T>(toolName: string, result: CallToolResult): T {
	const structuredContent = isRecord(result.structuredContent)
		? result.structuredContent
		: undefined;
	if (structuredContent) {
		return structuredContent as T;
	}
	const text = Array.isArray(result.content)
		? result.content
				.map((entry) =>
					entry.type === "text" && typeof entry.text === "string"
						? entry.text
						: undefined,
				)
				.find((entry): entry is string => Boolean(entry))
		: undefined;
	if (text) {
		const parsed = JSON.parse(text) as unknown;
		if (isRecord(parsed)) {
			return parsed as T;
		}
	}
	throw new Error(`${toolName} did not return structured JSON output`);
}

async function ensureEvalOpsLogin(
	options: EvalOpsInitOptions,
	deps: Required<
		Pick<
			EvalOpsInitDependencies,
			| "getOAuthToken"
			| "hasOAuthCredentials"
			| "login"
			| "onAuthUrl"
			| "onStatus"
		>
	>,
): Promise<string> {
	if (options.forceLogin || !deps.hasOAuthCredentials("evalops")) {
		deps.onStatus({ message: "Opening EvalOps login" });
		await deps.login("evalops", {
			onAuthUrl: deps.onAuthUrl,
			onStatus: (message) => deps.onStatus({ message }),
		});
	}

	let token = await deps.getOAuthToken("evalops");
	if (!token) {
		deps.onStatus({ message: "Refreshing EvalOps login" });
		await deps.login("evalops", {
			onAuthUrl: deps.onAuthUrl,
			onStatus: (message) => deps.onStatus({ message }),
		});
		token = await deps.getOAuthToken("evalops");
	}
	if (!token) {
		throw new Error("EvalOps login did not produce an access token");
	}
	return token;
}

function buildKeyName(options: EvalOpsInitOptions, now: Date): string {
	if (options.keyName?.trim()) {
		return options.keyName.trim();
	}
	const host = hostname()
		.replace(/[^a-zA-Z0-9._-]+/gu, "-")
		.slice(0, 48);
	return `maestro-init-${host || "local"}-${now.toISOString().slice(0, 10)}`;
}

function integrationProfileForOptions(options: EvalOpsInitOptions): string {
	return (
		nonEmptyString(options.integrationProfile) ??
		(options.agentType && options.agentType !== DEFAULT_AGENT_TYPE
			? "mcp_otlp"
			: "managed_runtime")
	);
}

function shimTypeForOptions(options: EvalOpsInitOptions): string {
	return (
		nonEmptyString(options.shimType) ??
		(integrationProfileForOptions(options) === "managed_runtime"
			? "sdk"
			: "native_mcp")
	);
}

function traceModeForOptions(options: EvalOpsInitOptions): string {
	return (
		nonEmptyString(options.traceMode) ??
		(integrationProfileForOptions(options) === "mcp_only"
			? "mcp_events"
			: "otlp")
	);
}

function memoryModeForOptions(options: EvalOpsInitOptions): string {
	return (
		nonEmptyString(options.memoryMode) ??
		(integrationProfileForOptions(options) === "managed_runtime"
			? "durable"
			: "none")
	);
}

function runtimeOwnerForOptions(options: EvalOpsInitOptions): string {
	return (
		nonEmptyString(options.runtimeOwner) ??
		(integrationProfileForOptions(options) === "managed_runtime"
			? "evalops"
			: "external")
	);
}

async function createAgentAPIKey(
	options: EvalOpsInitOptions,
	identityBaseUrl: string,
	oauthToken: string,
	fetchImpl: typeof fetch,
	now: Date,
): Promise<CreateAPIKeyOutput> {
	const expiresInDays = positiveInteger(options.expiresInDays);
	const expiresAt = expiresInDays
		? new Date(
				now.getTime() + expiresInDays * 24 * 60 * 60 * 1000,
			).toISOString()
		: undefined;
	const response = await fetchImpl(
		`${identityBaseUrl}${PLATFORM_HTTP_ROUTES.identity.apiKeys}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${oauthToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				name: buildKeyName(options, now),
				scopes: options.apiKeyScopes ?? DEFAULT_API_KEY_SCOPES,
				...(expiresAt ? { expires_at: expiresAt } : {}),
			}),
		},
	);
	const output = (await response
		.json()
		.catch(() => ({}))) as CreateAPIKeyHTTPOutput;
	if (!response.ok) {
		throw new Error(
			typeof output.error === "string" && output.error.trim()
				? output.error
				: `EvalOps API key creation failed (${response.status})`,
		);
	}
	const key = isRecord(output.key) ? output.key : undefined;
	const normalized: CreateAPIKeyOutput = {
		api_key: nonEmptyString(output.api_key) ?? "",
		expires_at:
			nonEmptyString(output.expires_at) ?? nonEmptyString(key?.expires_at),
		key_id: nonEmptyString(output.key_id) ?? nonEmptyString(key?.id),
		name: nonEmptyString(output.name) ?? nonEmptyString(key?.name),
		prefix: nonEmptyString(output.prefix) ?? nonEmptyString(key?.prefix),
		scopes:
			stringArray(output.scopes) ??
			stringArray(key?.scopes) ??
			stringArray(output.scopes_granted),
	};
	if (!nonEmptyString(normalized.api_key)) {
		throw new Error("EvalOps API key creation did not return api_key");
	}
	return normalized;
}

async function registerAgent(
	options: EvalOpsInitOptions,
	client: EvalOpsMcpClient,
): Promise<RegisterOutput> {
	const output = await callConnectedMcpTool<RegisterOutput>(
		client,
		"evalops_register",
		{
			agent_type: options.agentType ?? DEFAULT_AGENT_TYPE,
			capabilities: ["maestro:init", "maestro:cli"],
			integration_profile: integrationProfileForOptions(options),
			memory_mode: memoryModeForOptions(options),
			runtime_owner: runtimeOwnerForOptions(options),
			...(options.registerScopes?.length
				? { scopes: options.registerScopes }
				: {}),
			shim_type: shimTypeForOptions(options),
			surface: options.surface ?? DEFAULT_SURFACE,
			trace_mode: traceModeForOptions(options),
			...(positiveInteger(options.ttlSeconds)
				? { ttl_seconds: options.ttlSeconds }
				: {}),
			...(options.workspaceId ? { workspace_id: options.workspaceId } : {}),
		},
	);
	if (output.registered !== true || !nonEmptyString(output.agent_id)) {
		throw new Error("EvalOps agent registration did not return an agent_id");
	}
	return output;
}

async function runGovernedInferenceCheck(
	client: EvalOpsMcpClient,
): Promise<CheckActionOutput> {
	return callConnectedMcpTool<CheckActionOutput>(
		client,
		"evalops_check_action",
		{
			action_type: "llm_gateway.invoke",
			action_payload: "maestro init first governed inference check",
			declared_risk_level: "low",
		},
	);
}

async function loadControlPlaneSummary(
	client: EvalOpsMcpClient,
): Promise<ControlPlaneSummaryOutput> {
	return callConnectedMcpTool<ControlPlaneSummaryOutput>(
		client,
		"evalops_control_plane_summary",
		{},
	);
}

function organizationIdFromCredentials(
	credentials: OAuthCredentials | null,
): string | undefined {
	return (
		nonEmptyString(credentials?.metadata?.organizationId) ??
		nonEmptyString(credentials?.metadata?.organization_id)
	);
}

function authenticatedAsFromCredentials(
	credentials: OAuthCredentials | null,
): string | undefined {
	const metadata = credentials?.metadata;
	const user = isRecord(metadata?.user) ? metadata.user : undefined;
	return (
		nonEmptyString(metadata?.email) ??
		nonEmptyString(metadata?.preferred_username) ??
		nonEmptyString(metadata?.preferredUsername) ??
		nonEmptyString(metadata?.user) ??
		nonEmptyString(user?.email) ??
		nonEmptyString(user?.name)
	);
}

function consoleUrlFromEndpoint(endpoint: string): string {
	const parsed = new URL(endpoint);
	parsed.pathname = "/overview";
	parsed.search = "";
	parsed.hash = "";
	const env =
		parsed.hostname === "app.evalops.dev"
			? "production"
			: parsed.hostname === "staging.evalops.dev"
				? "staging"
				: "local";
	parsed.searchParams.set("env", env);
	return parsed.toString();
}

function countHighRiskFindings(summary: ControlPlaneSummaryOutput): number {
	const findings = Array.isArray(summary.findings) ? summary.findings : [];
	const findingCount = findings.filter((finding) => {
		const record = isRecord(finding) ? finding : undefined;
		const severity = nonEmptyString(record?.severity)?.toLowerCase();
		return severity === "critical" || severity === "high";
	}).length;
	const metricCount = summary.metrics?.high_risk_tools;
	if (typeof metricCount === "number" && Number.isFinite(metricCount)) {
		return Math.max(findingCount, Math.max(0, Math.trunc(metricCount)));
	}
	return findingCount;
}

function hasPolicyControl(summary: ControlPlaneSummaryOutput): boolean {
	const approvalRequired = summary.metrics?.approval_required_tools ?? 0;
	if (approvalRequired > 0) {
		return true;
	}
	const controls = Array.isArray(summary.policy_controls)
		? summary.policy_controls
		: [];
	return controls.some((control) => {
		const record = isRecord(control) ? control : undefined;
		return /approval|policy|starter/i.test(
			[
				nonEmptyString(record?.label),
				nonEmptyString(record?.value),
				nonEmptyString(record?.detail),
			]
				.filter(Boolean)
				.join(" "),
		);
	});
}

function hasTraceEvidence(summary: ControlPlaneSummaryOutput): boolean {
	const evidence = Array.isArray(summary.evidence) ? summary.evidence : [];
	return evidence.some((entry) => {
		const record = isRecord(entry) ? entry : undefined;
		return Boolean(
			nonEmptyString(record?.trace) ??
				nonEmptyString(record?.trace_id) ??
				nonEmptyString(record?.traceId),
		);
	});
}

function governedActionCount(summary: ControlPlaneSummaryOutput): number {
	const metricTotal = summary.metrics?.total_tools;
	if (typeof metricTotal === "number" && Number.isFinite(metricTotal)) {
		return Math.max(0, Math.trunc(metricTotal));
	}
	return Array.isArray(summary.tools) ? summary.tools.length : 0;
}

function saveBootstrapMetadata(
	credentials: OAuthCredentials,
	agentMcp: EvalOpsAgentMcpMetadata,
	saveCredentials: typeof saveOAuthCredentials,
): void {
	saveCredentials("evalops", {
		...credentials,
		metadata: {
			...credentials.metadata,
			agentId: agentMcp.agentId ?? credentials.metadata?.agentId,
			runId: agentMcp.runId ?? credentials.metadata?.runId,
			surface: agentMcp.surface,
			agentMcp,
		},
	});
}

export async function bootstrapEvalOpsAgent(
	options: EvalOpsInitOptions = {},
	dependencies: EvalOpsInitDependencies = {},
): Promise<EvalOpsInitResult> {
	const deps = {
		createMcpClient: dependencies.createMcpClient ?? createDefaultMcpClient,
		fetch: dependencies.fetch ?? fetch,
		getOAuthToken: dependencies.getOAuthToken ?? getOAuthToken,
		hasOAuthCredentials:
			dependencies.hasOAuthCredentials ?? hasOAuthCredentials,
		loadCredentials: dependencies.loadCredentials ?? loadOAuthCredentials,
		login: dependencies.login ?? login,
		now: dependencies.now ?? (() => new Date()),
		onAuthUrl:
			dependencies.onAuthUrl ??
			((url: string) => {
				process.stdout.write(`${url}\n`);
			}),
		onStatus: dependencies.onStatus ?? (() => undefined),
		saveCredentials: dependencies.saveCredentials ?? saveOAuthCredentials,
	};

	const oauthToken = await ensureEvalOpsLogin(options, deps);
	const endpoint = await resolveAgentMcpEndpoint(options, deps);
	const credentialsBeforeKey = deps.loadCredentials("evalops");
	const stored = getStoredAgentMcpMetadata(credentialsBeforeKey);
	const identityBaseUrl = resolveIdentityBaseUrl(
		credentialsBeforeKey,
		endpoint,
	);
	const now = deps.now();

	let apiKey = stored && !options.rotateKey ? stored.apiKey : undefined;
	let keyOutput: CreateAPIKeyOutput | undefined;
	let apiKeyCreated = false;

	if (!apiKey) {
		deps.onStatus({ message: "Creating EvalOps agent API key" });
		keyOutput = await createAgentAPIKey(
			options,
			identityBaseUrl,
			oauthToken,
			deps.fetch,
			now,
		);
		apiKey = keyOutput.api_key;
		apiKeyCreated = true;
	} else {
		deps.onStatus({ message: "Reusing stored EvalOps agent API key" });
	}

	deps.onStatus({ message: "Registering Maestro with EvalOps agent MCP" });
	let registerOutput: RegisterOutput;
	let client: EvalOpsMcpClient;
	const openAndRegister = async (token: string) => {
		const mcpClient = deps.createMcpClient(endpoint.endpoint, token);
		await mcpClient.connect();
		try {
			const output = await registerAgent(options, mcpClient);
			return { client: mcpClient, registerOutput: output };
		} catch (error) {
			await mcpClient.close().catch(() => undefined);
			throw error;
		}
	};
	try {
		({ client, registerOutput } = await openAndRegister(apiKey));
	} catch (error) {
		if (apiKeyCreated) {
			throw error;
		}
		deps.onStatus({
			message: "Stored EvalOps agent API key failed; rotating and retrying",
		});
		keyOutput = await createAgentAPIKey(
			{ ...options, rotateKey: true },
			identityBaseUrl,
			oauthToken,
			deps.fetch,
			now,
		);
		apiKey = keyOutput.api_key;
		apiKeyCreated = true;
		({ client, registerOutput } = await openAndRegister(apiKey));
	}

	let governedInferenceCheck: CheckActionOutput = {};
	let controlPlaneSummary: ControlPlaneSummaryOutput = {};
	try {
		deps.onStatus({ message: "Running first governed inference check" });
		governedInferenceCheck = await runGovernedInferenceCheck(client);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		deps.onStatus({
			message: `EvalOps governed inference check unavailable; continuing bootstrap (${reason})`,
		});
	}
	try {
		deps.onStatus({ message: "Loading EvalOps control-plane proof" });
		controlPlaneSummary = await loadControlPlaneSummary(client);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		deps.onStatus({
			message: `EvalOps control-plane proof unavailable; continuing bootstrap (${reason})`,
		});
	} finally {
		await client.close().catch(() => undefined);
	}

	const credentials = deps.loadCredentials("evalops");
	if (!credentials) {
		throw new Error("EvalOps OAuth credentials disappeared during init");
	}
	const keyPrefix = nonEmptyString(keyOutput?.prefix) ?? stored?.keyPrefix;
	const scopes = keyOutput?.scopes ?? stored?.scopes;
	const integrationProfile =
		nonEmptyString(registerOutput.integration_profile) ??
		integrationProfileForOptions(options);
	const memoryMode =
		nonEmptyString(registerOutput.memory_mode) ?? memoryModeForOptions(options);
	const runtimeOwner =
		nonEmptyString(registerOutput.runtime_owner) ??
		runtimeOwnerForOptions(options);
	const shimType =
		nonEmptyString(registerOutput.shim_type) ?? shimTypeForOptions(options);
	const traceMode =
		nonEmptyString(registerOutput.trace_mode) ?? traceModeForOptions(options);
	const agentMcp: EvalOpsAgentMcpMetadata = {
		type: "agent-mcp",
		apiKey,
		createdAt: (apiKeyCreated
			? now
			: new Date(stored?.createdAt ?? now)
		).toISOString(),
		endpoint: endpoint.endpoint,
		registeredAt: deps.now().toISOString(),
		surface: options.surface ?? DEFAULT_SURFACE,
		agentId: registerOutput.agent_id,
		expiresAt: nonEmptyString(keyOutput?.expires_at) ?? stored?.expiresAt,
		integrationProfile,
		keyId: nonEmptyString(keyOutput?.key_id) ?? stored?.keyId,
		keyName: nonEmptyString(keyOutput?.name) ?? stored?.keyName,
		keyPrefix,
		manifestUrl: endpoint.manifestUrl,
		memoryMode,
		registryVisible: registerOutput.registry_visible,
		runId: registerOutput.run_id,
		runtimeOwner,
		scopes,
		sessionExpiresAt: registerOutput.expires_at,
		shimType,
		traceMode,
		workspaceId:
			options.workspaceId ?? organizationIdFromCredentials(credentials),
	};
	saveBootstrapMetadata(credentials, agentMcp, deps.saveCredentials);

	return {
		agentId: registerOutput.agent_id,
		apiKeyCreated,
		approvalPolicyAttached: hasPolicyControl(controlPlaneSummary),
		authenticatedAs: authenticatedAsFromCredentials(credentials),
		consoleUrl: consoleUrlFromEndpoint(endpoint.endpoint),
		endpoint: endpoint.endpoint,
		evidenceEventPublished: (controlPlaneSummary.evidence ?? []).length > 0,
		evidenceEvents: (controlPlaneSummary.evidence ?? []).length,
		governedActionsLoaded: governedActionCount(controlPlaneSummary),
		governedInferenceCheckRan: Boolean(governedInferenceCheck.decision),
		integrationProfile,
		keyPrefix,
		manifestUrl: endpoint.manifestUrl,
		memoryMode,
		organizationId: organizationIdFromCredentials(credentials),
		registryVisible: registerOutput.registry_visible,
		riskFindings: countHighRiskFindings(controlPlaneSummary),
		runId: registerOutput.run_id,
		runtimeOwner,
		scopesGranted: registerOutput.scopes_granted,
		sessionExpiresAt: registerOutput.expires_at,
		shimType,
		stored: true,
		traceIngestionStarted: hasTraceEvidence(controlPlaneSummary),
		traceMode,
	};
}
