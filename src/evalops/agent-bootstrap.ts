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

const DEFAULT_AGENT_MCP_BASE_URL = "https://app.evalops.dev";
const AGENT_MCP_MANIFEST_PATH = "/.well-known/evalops/agent-mcp.json";
const AGENT_MCP_PATH = "/mcp";
const DEFAULT_AGENT_TYPE = "maestro";
const DEFAULT_SURFACE = "cli";
const DEFAULT_REGISTER_SCOPES = ["llm_gateway:invoke"];
const DEFAULT_API_KEY_SCOPES = [
	"agent:register",
	"agent:heartbeat",
	"governance:evaluate",
	"memories:read",
	"meter:record",
];

export interface EvalOpsInitOptions {
	agentType?: string;
	apiKeyScopes?: string[];
	expiresInDays?: number;
	forceLogin?: boolean;
	json?: boolean;
	keyName?: string;
	manifestUrl?: string;
	mcpUrl?: string;
	registerScopes?: string[];
	rotateKey?: boolean;
	surface?: string;
	ttlSeconds?: number;
	workspaceId?: string;
}

export interface EvalOpsAgentMcpMetadata {
	agentId?: string;
	apiKey?: string;
	createdAt: string;
	endpoint: string;
	expiresAt?: string;
	keyId?: string;
	keyName?: string;
	keyPrefix?: string;
	manifestUrl?: string;
	registeredAt: string;
	registryVisible?: boolean;
	runId?: string;
	scopes?: string[];
	sessionExpiresAt?: string;
	surface: string;
	type: "agent-mcp";
	workspaceId?: string;
}

export interface EvalOpsInitResult {
	agentId?: string;
	apiKeyCreated: boolean;
	endpoint: string;
	keyPrefix?: string;
	manifestUrl?: string;
	organizationId?: string;
	registryVisible?: boolean;
	runId?: string;
	scopesGranted?: string[];
	sessionExpiresAt?: string;
	stored: boolean;
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

interface RegisterOutput {
	agent_id?: string;
	expires_at?: string;
	registered?: boolean;
	registry_visible?: boolean;
	run_id?: string;
	scopes_denied?: string[];
	scopes_granted?: string[];
}

interface AgentMcpEndpoint {
	endpoint: string;
	manifestUrl?: string;
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
		keyId: nonEmptyString(agentMcp?.keyId),
		keyName: nonEmptyString(agentMcp?.keyName),
		keyPrefix: nonEmptyString(agentMcp?.keyPrefix),
		manifestUrl: nonEmptyString(agentMcp?.manifestUrl),
		registryVisible:
			typeof agentMcp?.registryVisible === "boolean"
				? agentMcp.registryVisible
				: undefined,
		runId: nonEmptyString(agentMcp?.runId),
		scopes: stringArray(agentMcp?.scopes),
		sessionExpiresAt: nonEmptyString(agentMcp?.sessionExpiresAt),
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
	const protocol =
		isRecord(payload) && isRecord(payload.protocol)
			? payload.protocol
			: undefined;
	const endpoint = nonEmptyString(protocol?.endpoint);
	if (!endpoint) {
		throw new Error("EvalOps MCP manifest did not include protocol.endpoint");
	}
	return { endpoint: normalizeMcpEndpoint(endpoint), manifestUrl };
}

async function resolveAgentMcpEndpoint(
	options: EvalOpsInitOptions,
	deps: Required<Pick<EvalOpsInitDependencies, "fetch" | "loadCredentials">>,
): Promise<AgentMcpEndpoint> {
	if (options.mcpUrl) {
		return { endpoint: normalizeMcpEndpoint(options.mcpUrl) };
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
		return { endpoint: normalizeMcpEndpoint(configuredMcpUrl) };
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

async function callMcpTool<T>(
	createClient: (endpoint: string, bearerToken: string) => EvalOpsMcpClient,
	endpoint: string,
	token: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<T> {
	const client = createClient(endpoint, token);
	await client.connect();
	try {
		const result = await client.callTool(toolName, args);
		if (result.isError) {
			throw new Error(`${toolName} returned an MCP error`);
		}
		return parseToolOutput<T>(toolName, result);
	} finally {
		await client.close().catch(() => undefined);
	}
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

async function createAgentAPIKey(
	options: EvalOpsInitOptions,
	endpoint: string,
	oauthToken: string,
	createClient: (endpoint: string, bearerToken: string) => EvalOpsMcpClient,
	now: Date,
): Promise<CreateAPIKeyOutput> {
	const output = await callMcpTool<CreateAPIKeyOutput>(
		createClient,
		endpoint,
		"",
		"evalops_create_api_key",
		{
			name: buildKeyName(options, now),
			scopes: options.apiKeyScopes ?? DEFAULT_API_KEY_SCOPES,
			user_token: oauthToken,
			...(positiveInteger(options.expiresInDays)
				? { expires_in_days: options.expiresInDays }
				: {}),
		},
	);
	if (!nonEmptyString(output.api_key)) {
		throw new Error("EvalOps API key creation did not return api_key");
	}
	return output;
}

async function registerAgent(
	options: EvalOpsInitOptions,
	endpoint: string,
	apiKey: string,
	createClient: (endpoint: string, bearerToken: string) => EvalOpsMcpClient,
): Promise<RegisterOutput> {
	const output = await callMcpTool<RegisterOutput>(
		createClient,
		endpoint,
		"",
		"evalops_register",
		{
			agent_type: options.agentType ?? DEFAULT_AGENT_TYPE,
			capabilities: ["maestro:init", "maestro:cli"],
			scopes: options.registerScopes ?? DEFAULT_REGISTER_SCOPES,
			surface: options.surface ?? DEFAULT_SURFACE,
			user_token: apiKey,
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

function organizationIdFromCredentials(
	credentials: OAuthCredentials | null,
): string | undefined {
	return (
		nonEmptyString(credentials?.metadata?.organizationId) ??
		nonEmptyString(credentials?.metadata?.organization_id)
	);
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
	const now = deps.now();

	let apiKey = stored && !options.rotateKey ? stored.apiKey : undefined;
	let keyOutput: CreateAPIKeyOutput | undefined;
	let apiKeyCreated = false;

	if (!apiKey) {
		deps.onStatus({ message: "Creating EvalOps agent API key" });
		keyOutput = await createAgentAPIKey(
			options,
			endpoint.endpoint,
			oauthToken,
			deps.createMcpClient,
			now,
		);
		apiKey = keyOutput.api_key;
		apiKeyCreated = true;
	} else {
		deps.onStatus({ message: "Reusing stored EvalOps agent API key" });
	}

	deps.onStatus({ message: "Registering Maestro with EvalOps agent MCP" });
	let registerOutput: RegisterOutput;
	try {
		registerOutput = await registerAgent(
			options,
			endpoint.endpoint,
			apiKey,
			deps.createMcpClient,
		);
	} catch (error) {
		if (apiKeyCreated) {
			throw error;
		}
		deps.onStatus({
			message: "Stored EvalOps agent API key failed; rotating and retrying",
		});
		keyOutput = await createAgentAPIKey(
			{ ...options, rotateKey: true },
			endpoint.endpoint,
			oauthToken,
			deps.createMcpClient,
			now,
		);
		apiKey = keyOutput.api_key;
		apiKeyCreated = true;
		registerOutput = await registerAgent(
			options,
			endpoint.endpoint,
			apiKey,
			deps.createMcpClient,
		);
	}

	const credentials = deps.loadCredentials("evalops");
	if (!credentials) {
		throw new Error("EvalOps OAuth credentials disappeared during init");
	}
	const keyPrefix = nonEmptyString(keyOutput?.prefix) ?? stored?.keyPrefix;
	const scopes = keyOutput?.scopes ?? stored?.scopes;
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
		keyId: nonEmptyString(keyOutput?.key_id) ?? stored?.keyId,
		keyName: nonEmptyString(keyOutput?.name) ?? stored?.keyName,
		keyPrefix,
		manifestUrl: endpoint.manifestUrl,
		registryVisible: registerOutput.registry_visible,
		runId: registerOutput.run_id,
		scopes,
		sessionExpiresAt: registerOutput.expires_at,
		workspaceId:
			options.workspaceId ?? organizationIdFromCredentials(credentials),
	};
	saveBootstrapMetadata(credentials, agentMcp, deps.saveCredentials);

	return {
		agentId: registerOutput.agent_id,
		apiKeyCreated,
		endpoint: endpoint.endpoint,
		keyPrefix,
		manifestUrl: endpoint.manifestUrl,
		organizationId: organizationIdFromCredentials(credentials),
		registryVisible: registerOutput.registry_visible,
		runId: registerOutput.run_id,
		scopesGranted: registerOutput.scopes_granted,
		sessionExpiresAt: registerOutput.expires_at,
		stored: true,
	};
}
