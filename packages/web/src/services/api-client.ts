/**
 * @fileoverview API Client for Composer Backend
 *
 * This module provides a type-safe HTTP client for communicating with
 * the Composer backend API. It handles:
 *
 * - Session management (create, list, delete)
 * - Streaming chat with Server-Sent Events (SSE)
 * - Model selection and configuration
 * - Workspace status and file operations
 * - Background tasks and diagnostics
 *
 * ## Features
 *
 * - **Automatic Fallback**: Tries multiple base URLs if primary fails
 * - **SSE Streaming**: Real-time streaming for chat responses
 * - **Type Safety**: Full TypeScript types for all API responses
 * - **Error Handling**: Graceful degradation with detailed errors
 *
 * ## Quick Start
 *
 * ```typescript
 * import { ApiClient } from "@evalops/composer-web";
 *
 * const client = new ApiClient("http://localhost:8080");
 *
 * // Get workspace status
 * const status = await client.getStatus();
 *
 * // Stream a chat response
 * for await (const event of client.chatWithEvents({ messages: [...] })) {
 *   if (event.type === 'message_update') {
 *     console.log(event.assistantMessageEvent);
 *   }
 * }
 * ```
 *
 * ## API Endpoints
 *
 * | Category | Endpoint | Description |
 * |----------|----------|-------------|
 * | Chat | POST /api/chat | Send message, get streaming response |
 * | Sessions | GET/POST /api/sessions | Manage conversation sessions |
 * | Models | GET/POST /api/model | Get/set current model |
 * | Status | GET /api/status | Get workspace status |
 * | Usage | GET /api/usage | Get token usage and costs |
 *
 * @module services/api-client
 */

import {
	isComposerAgentEvent,
	isComposerApprovalsStatusResponse,
	isComposerApprovalsUpdateResponse,
	isComposerBackgroundHistoryResponse,
	isComposerBackgroundStatusResponse,
	isComposerBackgroundUpdateResponse,
	isComposerChatRequest,
	isComposerCommandListResponse,
	isComposerCommandPrefs,
	isComposerCommandPrefsWriteResponse,
	isComposerConfigResponse,
	isComposerConfigWriteResponse,
	isComposerErrorResponse,
	isComposerFilesResponse,
	isComposerFrameworkListResponse,
	isComposerFrameworkStatusResponse,
	isComposerFrameworkUpdateResponse,
	isComposerGuardianConfigResponse,
	isComposerGuardianRunResponse,
	isComposerGuardianStatusResponse,
	isComposerModel,
	isComposerModelListResponse,
	isComposerPlanActionResponse,
	isComposerPlanStatusResponse,
	isComposerSession,
	isComposerSessionListResponse,
	isComposerSessionSummary,
	isComposerStatusResponse,
	isComposerUndoOperationResponse,
	isComposerUndoStatusResponse,
	isComposerUsageResponse,
} from "@evalops/contracts";
import type {
	ComposerAgentEvent,
	ComposerApprovalsStatusResponse,
	ComposerApprovalsUpdateResponse,
	ComposerAssistantMessageEvent,
	ComposerBackgroundHistoryResponse,
	ComposerBackgroundStatusResponse,
	ComposerBackgroundUpdateResponse,
	ComposerChatRequest,
	ComposerCommand,
	ComposerCommandPrefs,
	ComposerConfigResponse,
	ComposerConfigWriteRequest,
	ComposerConfigWriteResponse,
	ComposerErrorResponse,
	ComposerFrameworkListResponse,
	ComposerFrameworkStatusResponse,
	ComposerFrameworkUpdateResponse,
	ComposerGuardianConfigResponse,
	ComposerGuardianRunResponse,
	ComposerGuardianStatusResponse,
	ComposerMessage,
	ComposerModel,
	ComposerPlanActionResponse,
	ComposerPlanStatusResponse,
	ComposerSession,
	ComposerSessionSummary,
	ComposerToolCall,
	ComposerUndoOperationResponse,
	ComposerUndoStatusResponse,
} from "@evalops/contracts";
import {
	getStoredComposerAccessToken,
	getStoredComposerApiKey,
	getStoredComposerCsrfToken,
} from "./enterprise-api.js";

export type Message = ComposerMessage;
export type { ComposerToolCall };

export type AssistantMessageEvent = ComposerAssistantMessageEvent;

/** AgentEvent is a discriminated union of all possible server-sent events */
export type AgentEvent = ComposerAgentEvent;

export type Model = ComposerModel;

export type Session = ComposerSession;

export type SessionSummary = ComposerSessionSummary;

export type ChatRequest = ComposerChatRequest;

export type CommandDefinition = ComposerCommand;

export type CommandPrefs = ComposerCommandPrefs;

export type ConfigResponse = ComposerConfigResponse;

export type ConfigWriteRequest = ComposerConfigWriteRequest;

export type ConfigWriteResponse = ComposerConfigWriteResponse;

export type GuardianStatusResponse = ComposerGuardianStatusResponse;

export type GuardianRunResponse = ComposerGuardianRunResponse;

export type GuardianConfigResponse = ComposerGuardianConfigResponse;

export type PlanStatusResponse = ComposerPlanStatusResponse;

export type PlanActionResponse = ComposerPlanActionResponse;

export type BackgroundStatusResponse = ComposerBackgroundStatusResponse;

export type BackgroundHistoryResponse = ComposerBackgroundHistoryResponse;

export type BackgroundUpdateResponse = ComposerBackgroundUpdateResponse;

export type ApprovalsStatusResponse = ComposerApprovalsStatusResponse;

export type ApprovalsUpdateResponse = ComposerApprovalsUpdateResponse;

export type FrameworkStatusResponse = ComposerFrameworkStatusResponse;

export type FrameworkListResponse = ComposerFrameworkListResponse;

export type FrameworkUpdateResponse = ComposerFrameworkUpdateResponse;

export type UndoStatusResponse = ComposerUndoStatusResponse;

export type UndoOperationResponse = ComposerUndoOperationResponse;

const MAX_SSE_BUFFER = 1024 * 1024; // 1MB safeguard
const VALIDATE_AGENT_EVENTS = Boolean(import.meta.env?.DEV);
const VALIDATE_CHAT_REQUESTS = Boolean(import.meta.env?.DEV);
const VALIDATE_API_RESPONSES = Boolean(import.meta.env?.DEV);
const ARTIFACT_ACCESS_HEADER = "X-Composer-Artifact-Access";
const MAESTRO_ARTIFACT_ACCESS_HEADER = "X-Maestro-Artifact-Access";

export interface ApiClientAuthConfig {
	accessToken?: string | null;
	apiKey?: string | null;
	csrfToken?: string | null;
}

export interface ApiClientOptions {
	auth?: ApiClientAuthConfig;
}

export interface PolicyValidationError {
	path?: string;
	message: string;
	keyword?: string;
}

export interface PolicyValidationResponse {
	valid: boolean;
	errors?: PolicyValidationError[];
}

export interface AttachmentTextExtractionResponse {
	fileName: string;
	format: string;
	size: number;
	truncated: boolean;
	extractedText: string;
	cached?: boolean;
}

export interface McpToolDefinition {
	name: string;
	description?: string;
	inputSchema?: unknown;
	annotations?: Record<string, unknown>;
}

export type McpRemoteTrust = "official" | "custom" | "unknown";

export interface McpOfficialRegistryInfo {
	displayName?: string;
	directoryUrl?: string;
	documentationUrl?: string;
	permissions?: string;
	authorName?: string;
	url?: string;
}

export interface McpOfficialRegistryUrlOption {
	url: string;
	label?: string;
	description?: string;
}

export interface McpOfficialRegistryEntry extends McpOfficialRegistryInfo {
	slug?: string;
	serverName?: string;
	oneLiner?: string;
	transport?: "stdio" | "http" | "sse";
	urlOptions?: McpOfficialRegistryUrlOption[];
	urlRegex?: string;
	toolCount?: number;
	promptCount?: number;
}

export interface McpServerStatus {
	name: string;
	connected: boolean;
	scope?: "enterprise" | "plugin" | "project" | "local" | "user";
	transport?: "stdio" | "http" | "sse";
	tools?: McpToolDefinition[] | number;
	resources?: string[];
	prompts?: string[];
	error?: string;
	command?: string;
	args?: string[];
	cwd?: string;
	envKeys?: string[];
	remoteUrl?: string;
	remoteHost?: string;
	headerKeys?: string[];
	headersHelper?: string;
	authPreset?: string;
	timeout?: number;
	remoteTrust?: McpRemoteTrust;
	officialRegistry?: McpOfficialRegistryInfo;
}

export interface McpAuthPresetStatus {
	name: string;
	scope?: "enterprise" | "plugin" | "project" | "local" | "user";
	headerKeys: string[];
	headersHelper?: string;
}

export interface McpStatus {
	servers: McpServerStatus[];
	authPresets: McpAuthPresetStatus[];
}

export interface McpRegistrySearchResponse {
	query: string;
	entries: McpOfficialRegistryEntry[];
}

export interface McpRegistryImportRequest {
	query: string;
	name?: string;
	scope?: "local" | "project" | "user";
	url?: string;
	headers?: Record<string, string>;
	headersHelper?: string;
	authPreset?: string;
	transport?: "http" | "sse";
}

export interface McpRegistryImportResponse {
	name: string;
	scope: "local" | "project" | "user";
	path: string;
	entry: McpOfficialRegistryEntry;
	server: {
		transport: "http" | "sse";
		url: string;
		headers?: Record<string, string>;
		headersHelper?: string;
		authPreset?: string;
	};
}

export interface McpServerConfigInput {
	name: string;
	transport?: "stdio" | "http" | "sse";
	command?: string;
	args?: string[] | null;
	env?: Record<string, string> | null;
	cwd?: string | null;
	url?: string;
	headers?: Record<string, string> | null;
	headersHelper?: string | null;
	authPreset?: string | null;
	timeout?: number | null;
	enabled?: boolean;
	disabled?: boolean;
}

export interface McpAuthPresetConfigInput {
	name: string;
	headers?: Record<string, string> | null;
	headersHelper?: string | null;
}

export interface McpServerAddRequest {
	scope?: "local" | "project" | "user";
	server: McpServerConfigInput;
}

export interface McpServerUpdateRequest {
	name: string;
	scope?: "local" | "project" | "user";
	server: McpServerConfigInput;
}

export interface McpServerMutationResponse {
	name: string;
	scope: "local" | "project" | "user";
	path: string;
	server: McpServerConfigInput & {
		transport: "stdio" | "http" | "sse";
	};
}

export interface McpServerRemoveRequest {
	name: string;
	scope?: "local" | "project" | "user";
}

export interface McpServerRemoveResponse {
	name: string;
	scope: "local" | "project" | "user";
	path: string;
	fallback: {
		name: string;
		scope?: "enterprise" | "plugin" | "project" | "local" | "user";
	} | null;
}

export interface McpAuthPresetAddRequest {
	scope?: "local" | "project" | "user";
	preset: McpAuthPresetConfigInput;
}

export interface McpAuthPresetUpdateRequest {
	name: string;
	scope?: "local" | "project" | "user";
	preset: McpAuthPresetConfigInput;
}

export interface McpAuthPresetMutationResponse {
	name: string;
	scope: "local" | "project" | "user";
	path: string;
	preset: McpAuthPresetConfigInput;
}

export interface McpAuthPresetRemoveRequest {
	name: string;
	scope?: "local" | "project" | "user";
}

export interface McpAuthPresetRemoveResponse {
	name: string;
	scope: "local" | "project" | "user";
	path: string;
	fallback: {
		name: string;
		scope?: "enterprise" | "plugin" | "project" | "local" | "user";
	} | null;
}

export interface McpResourceContent {
	uri: string;
	text?: string;
	blob?: string;
	mimeType?: string;
}

export interface McpResourceReadResponse {
	contents: McpResourceContent[];
}

export interface McpPromptMessage {
	role: string;
	content: string;
}

export interface McpPromptResponse {
	description?: string;
	messages: McpPromptMessage[];
}

export type SessionArtifactAccessAction = "view" | "file" | "events" | "zip";

interface SessionArtifactAccessResponse {
	token: string;
	expiresAt: string;
	actions: SessionArtifactAccessAction[];
	sessionId: string;
	filename?: string;
}

declare global {
	interface Window {
		__MAESTRO_API__?: string;
		__MAESTRO_API_KEY__?: string;
		__MAESTRO_CSRF_TOKEN__?: string;
	}
}

export class ApiClientError extends Error {
	readonly status: number;
	readonly payload?: ComposerErrorResponse;

	constructor(
		message: string,
		status: number,
		payload?: ComposerErrorResponse,
	) {
		super(message);
		this.name = "ApiClientError";
		this.status = status;
		this.payload = payload;
	}
}

function isNonRetriableClientError(error: unknown): error is ApiClientError {
	if (!(error instanceof ApiClientError)) return false;
	if (error.status < 400 || error.status >= 500) return false;
	return error.status !== 408 && error.status !== 429;
}

function shouldLogFallbackError(error: unknown): boolean {
	return !(
		error instanceof ApiClientError &&
		error.status >= 400 &&
		error.status < 500
	);
}

function arrayBufferToBase64(arrayBuffer: ArrayBuffer): string {
	const bytes = new Uint8Array(arrayBuffer);
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.slice(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

type ParsedSseEvent = {
	event?: string;
	data: string;
};

function parseSseEvents(buffer: string): {
	events: ParsedSseEvent[];
	remainder: string;
} {
	const normalized = buffer.replace(/\r\n/g, "\n");
	const events: ParsedSseEvent[] = [];
	let remainder = normalized;

	while (true) {
		const separatorIndex = remainder.indexOf("\n\n");
		if (separatorIndex === -1) break;

		const rawEvent = remainder.slice(0, separatorIndex);
		remainder = remainder.slice(separatorIndex + 2);

		if (!rawEvent.trim()) continue;

		let eventType: string | undefined;
		const dataLines: string[] = [];
		for (const line of rawEvent.split("\n")) {
			if (line.startsWith("event:")) {
				eventType = line.slice(6).trim();
				continue;
			}
			if (line.startsWith("data:")) {
				dataLines.push(line.slice(5).trimStart());
			}
		}
		if (dataLines.length > 0) {
			events.push({ event: eventType, data: dataLines.join("\n") });
		}
	}

	return { events, remainder };
}

function extractTextFromMessage(message: Message | undefined): string {
	if (!message) return "";
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				!!block &&
				typeof block === "object" &&
				(block as { type?: string }).type === "text" &&
				typeof (block as { text?: string }).text === "string",
		)
		.map((block) => block.text)
		.join("");
}

export interface ChatResponse {
	message: Message;
	usage?: {
		inputTokens: number;
		outputTokens: number;
	};
}

export interface BackgroundTaskSnapshotEntry {
	id?: string;
	status?: string;
	command?: string;
	summary?: string;
	lastLogLine?: string;
	issues?: string[];
	logTruncated?: boolean;
	durationSeconds?: number;
	restarts?: string;
}

export interface BackgroundTaskLimitBreach {
	kind: "memory" | "cpu";
	limit: number;
	actual: number;
}

export interface BackgroundTaskHistoryEntry {
	event: "started" | "restarted" | "exited" | "failed" | "stopped";
	taskId: string;
	status: string;
	command: string;
	timestamp: string;
	restartAttempts: number;
	failureReason?: string;
	limitBreach?: BackgroundTaskLimitBreach;
}

export interface BackgroundTaskSnapshot {
	total: number;
	running: number;
	restarting: number;
	failed: number;
	truncated?: boolean;
	notificationsEnabled?: boolean;
	detailsRedacted?: boolean;
	entries?: BackgroundTaskSnapshotEntry[];
	history?: BackgroundTaskHistoryEntry[];
	historyTruncated?: boolean;
}

export interface WorkspaceStatus {
	cwd: string;
	git: {
		branch: string;
		status: {
			modified: number;
			added: number;
			deleted: number;
			untracked: number;
			total: number;
		};
	} | null;
	context: {
		agentMd: boolean;
		claudeMd: boolean;
	};
	server: {
		uptime: number;
		version: string;
		staticCacheMaxAgeSeconds?: number;
	};
	database: {
		configured: boolean;
		connected: boolean;
	};
	backgroundTasks: BackgroundTaskSnapshot | null;
	hooks: {
		asyncInFlight: number;
		concurrency: {
			max: number;
			active: number;
			queued: number;
		};
	};
	lastUpdated: number;
	lastLatencyMs: number;
}

export interface UsageSummary {
	totalCost: number;
	totalRequests: number;
	totalTokens: number;
	totalTokensDetailed: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	totalTokensBreakdown: UsageSummary["totalTokensDetailed"];
	totalCachedTokens: number;
	byProvider: Record<
		string,
		{
			cost: number;
			calls: number;
			requests: number;
			tokens: number;
			tokensDetailed: UsageSummary["totalTokensDetailed"];
			cachedTokens: number;
		}
	>;
	byModel: Record<
		string,
		{
			cost: number;
			calls: number;
			requests: number;
			tokens: number;
			tokensDetailed: UsageSummary["totalTokensDetailed"];
			cachedTokens: number;
		}
	>;
}

async function safeJson(response: Response) {
	if (!response.ok) {
		await throwApiClientError(response);
	}

	const contentType = response.headers.get("content-type") || "";
	const isJson = contentType.includes("application/json");

	if (!isJson) {
		const text = await response.text();
		throw new Error(
			`Expected JSON but received ${contentType || "unknown"}; check API endpoint. Snippet: ${text.slice(0, 120)}`,
		);
	}
	return response.json();
}

async function throwApiClientError(response: Response): Promise<never> {
	const contentType = response.headers.get("content-type") || "";
	const isJson = contentType.includes("application/json");
	const raw = await response.text();
	let payload: unknown = undefined;
	if (isJson && raw) {
		try {
			payload = JSON.parse(raw);
		} catch {
			payload = undefined;
		}
	}

	if (payload && isComposerErrorResponse(payload)) {
		throw new ApiClientError(payload.error, response.status, payload);
	}
	if (payload && typeof (payload as { error?: string }).error === "string") {
		throw new ApiClientError(
			(payload as { error: string }).error,
			response.status,
		);
	}

	const snippet = raw ? ` Snippet: ${raw.slice(0, 120)}` : "";
	throw new ApiClientError(
		`API error: ${response.status} ${response.statusText}.${snippet}`,
		response.status,
	);
}

export interface UIStatusResponse {
	zenMode: boolean;
	cleanMode: "off" | "soft" | "aggressive";
	footerMode: "ensemble" | "solo";
	compactTools: boolean;
	queueMode: "one" | "all";
}

export interface QueueListResponse {
	mode: "one" | "all";
	pending: Array<{ id: number; text?: string; createdAt?: number }>;
	count: number;
}

export interface QueueStatusResponse {
	mode: "one" | "all";
	pendingCount: number;
	enabled: boolean;
}

export interface BranchListResponse {
	userMessages: Array<{ number: number; index: number; snippet: string }>;
}

/**
 * HTTP API client for the Composer backend.
 *
 * Provides methods for all Composer API endpoints including chat streaming,
 * session management, model selection, and workspace operations.
 *
 * The client automatically handles:
 * - URL fallback across multiple hosts
 * - SSE parsing for streaming responses
 * - Content-type validation
 * - Error propagation
 *
 * @example
 * ```typescript
 * const client = new ApiClient();
 *
 * // Get available models
 * const models = await client.getModels();
 *
 * // Stream chat messages
 * for await (const event of client.chatWithEvents({
 *   sessionId: "abc123",
 *   messages: [{ role: "user", content: "Hello!" }]
 * })) {
 *   console.log(event);
 * }
 * ```
 */
export class ApiClient {
	private transportPreference: "auto" | "sse" | "ws" = "auto";
	private authConfig: ApiClientAuthConfig | null = null;

	setTransportPreference(mode: "auto" | "sse" | "ws") {
		this.transportPreference = mode;
	}

	getTransportPreference(): "auto" | "sse" | "ws" {
		return this.transportPreference;
	}
	/** Resolved base URL for API requests */
	public readonly baseUrl: string;

	/** Fallback URLs to try if primary fails */
	private readonly fallbackBases: string[];

	/**
	 * Creates a new API client.
	 *
	 * The base URL is resolved in order of priority:
	 * 1. Explicit baseUrl parameter
	 * 2. window.__MAESTRO_API__ global
	 * 3. ?api= URL parameter
	 * 4. Same origin as current page
	 * 5. VITE_API_ENDPOINT env variable
	 * 6. http://localhost:8080 (fallback)
	 *
	 * @param baseUrl - Optional explicit base URL
	 */
	constructor(baseUrl?: string, options?: ApiClientOptions) {
		let resolved = baseUrl;
		// Window override via global (allows runtime swap without rebuild)
		if (!resolved && typeof window !== "undefined") {
			const winWithApi = window as Window & { __MAESTRO_API__?: string };
			if (typeof winWithApi.__MAESTRO_API__ === "string") {
				resolved = winWithApi.__MAESTRO_API__;
			}
			// ?api= URL param override
			if (!resolved && window.location?.search) {
				const params = new URLSearchParams(window.location.search);
				const api = params.get("api");
				if (api) resolved = api;
			}
			// Same-origin first to avoid CORS when proxied
			if (!resolved && window.location?.origin) {
				resolved = window.location.origin;
			}
		}
		// Vite env override
		if (!resolved && typeof import.meta !== "undefined") {
			resolved = import.meta.env?.VITE_API_ENDPOINT || undefined;
		}
		// Final fallback
		if (!resolved) {
			resolved = "http://localhost:8080";
		}
		this.baseUrl = resolved.replace(/\/$/, "");
		this.fallbackBases = this.buildFallbacks(this.baseUrl);
		this.setAuthConfig(options?.auth ?? null);
	}

	private buildFallbacks(primary: string): string[] {
		const bases: string[] = [];
		// always try origin first if available
		if (typeof window !== "undefined" && window.location) {
			const origin = window.location.origin;
			if (!bases.includes(origin)) bases.push(origin);
		}
		// then the configured primary
		if (!bases.includes(primary)) bases.push(primary);
		// finally localhost:8080 as a dev fallback
		if (!bases.includes("http://localhost:8080"))
			bases.push("http://localhost:8080");
		return bases;
	}

	setAuthConfig(auth: ApiClientAuthConfig | null | undefined) {
		this.authConfig = auth ? { ...auth } : null;
	}

	private resolveAuthConfig(): ApiClientAuthConfig {
		return {
			accessToken:
				this.authConfig?.accessToken ?? getStoredComposerAccessToken(),
			apiKey: this.authConfig?.apiKey ?? this.resolveApiKey(),
			csrfToken: this.authConfig?.csrfToken ?? this.resolveCsrfToken(),
		};
	}

	private hasHeaderBasedAuth(auth = this.resolveAuthConfig()): boolean {
		return Boolean(auth.accessToken?.trim() || auth.apiKey?.trim());
	}

	private canUseWebSocketTransport(): boolean {
		return !this.hasHeaderBasedAuth();
	}

	private resolveApiKey(): string | null {
		const stored = getStoredComposerApiKey();
		if (stored) return stored;
		if (typeof window === "undefined") return null;
		return this.readWindowOverride("__MAESTRO_API_KEY__", ["apiKey"]);
	}

	private resolveCsrfToken(): string | null {
		const stored = getStoredComposerCsrfToken();
		if (stored) return stored;
		if (typeof window === "undefined") return null;
		return this.readWindowOverride("__MAESTRO_CSRF_TOKEN__", [
			"csrf",
			"csrfToken",
		]);
	}

	private readWindowOverride(
		windowKey: "__MAESTRO_API_KEY__" | "__MAESTRO_CSRF_TOKEN__",
		queryKeys: string[],
	): string | null {
		const direct = window[windowKey]?.trim();
		if (direct) return direct;

		try {
			const params = new URLSearchParams(window.location?.search || "");
			for (const queryKey of queryKeys) {
				const value = params.get(queryKey)?.trim();
				if (value) return value;
			}
		} catch {
			// ignore search param errors
		}

		return null;
	}

	private buildRequestHeaders(headers?: HeadersInit, method = "GET"): Headers {
		const requestHeaders = new Headers(headers);
		const auth = this.resolveAuthConfig();

		if (auth.accessToken && !requestHeaders.has("Authorization")) {
			requestHeaders.set("Authorization", `Bearer ${auth.accessToken}`);
		}
		if (auth.apiKey && !requestHeaders.has("X-Composer-Api-Key")) {
			requestHeaders.set("X-Composer-Api-Key", auth.apiKey);
			requestHeaders.set("X-Maestro-Api-Key", auth.apiKey);
		}
		if (
			auth.csrfToken &&
			!requestHeaders.has("X-Composer-Csrf") &&
			!requestHeaders.has("X-Maestro-Csrf") &&
			!requestHeaders.has("X-Csrf-Token") &&
			!requestHeaders.has("X-Xsrf-Token") &&
			!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())
		) {
			requestHeaders.set("X-Composer-Csrf", auth.csrfToken);
			requestHeaders.set("X-Maestro-Csrf", auth.csrfToken);
		}

		return requestHeaders;
	}

	private buildRequestInit(init?: RequestInit): RequestInit {
		const method = init?.method ?? "GET";
		return {
			...init,
			headers: this.buildRequestHeaders(init?.headers, method),
		};
	}

	private buildArtifactAccessHeaders(
		artifactAccessToken?: string,
		headers?: HeadersInit,
	): Headers {
		const requestHeaders = this.buildRequestHeaders(headers, "GET");
		if (artifactAccessToken) {
			requestHeaders.set(ARTIFACT_ACCESS_HEADER, artifactAccessToken);
			requestHeaders.set(MAESTRO_ARTIFACT_ACCESS_HEADER, artifactAccessToken);
		}
		return requestHeaders;
	}

	private async createObjectUrlFromResponse(
		response: Response,
	): Promise<string> {
		const blob = await response.blob();
		if (typeof URL.createObjectURL !== "function") {
			throw new Error("Object URLs are not supported in this environment");
		}
		return URL.createObjectURL(blob);
	}

	private async fetchArtifactObjectUrl(
		path: string,
		artifactAccessToken?: string,
	): Promise<string> {
		const response = await this.tryFallbackFetch(path, {
			method: "GET",
			headers: this.buildArtifactAccessHeaders(artifactAccessToken),
		});
		return await this.createObjectUrlFromResponse(response);
	}

	private async fetchJsonWithFallback(path: string, init?: RequestInit) {
		const requestInit = this.buildRequestInit(init);
		let lastError: unknown;
		for (const base of this.fallbackBases) {
			try {
				const res = await fetch(`${base}${path}`, requestInit);
				return await safeJson(res);
			} catch (e) {
				lastError = e;
				if (isNonRetriableClientError(e)) {
					throw e;
				}
				if (shouldLogFallbackError(e)) {
					console.warn("API fallback failed", {
						base,
						path,
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}
		}
		throw lastError instanceof Error
			? lastError
			: new Error("Failed to fetch API after fallbacks");
	}

	private async tryFallbackFetch(
		path: string,
		init: RequestInit,
		skipPrimary = false,
		retryClientErrors = false,
	) {
		const requestInit = this.buildRequestInit(init);
		let lastError: unknown;
		const bases = skipPrimary
			? this.fallbackBases.filter((b) => b !== this.baseUrl)
			: this.fallbackBases;
		for (const base of bases) {
			try {
				const res = await fetch(`${base}${path}`, requestInit);
				if (!res.ok) {
					await throwApiClientError(res);
				}
				return res;
			} catch (e) {
				lastError = e;
				if (!retryClientErrors && isNonRetriableClientError(e)) {
					throw e;
				}
				if (shouldLogFallbackError(e)) {
					console.warn("API fallback failed", {
						base,
						path,
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}
		}
		throw lastError instanceof Error
			? lastError
			: new Error("Failed to fetch API after fallbacks");
	}

	private async openChatStream(
		request: ChatRequest,
		headers: HeadersInit,
	): Promise<Response> {
		if (VALIDATE_CHAT_REQUESTS && !isComposerChatRequest(request)) {
			throw new Error("Invalid chat request payload");
		}

		const path = "/api/chat";
		const requestInit = this.buildJsonRequestInit(
			"POST",
			{ ...request, stream: true },
			headers,
		);
		let lastError: unknown;

		for (const base of this.fallbackBases) {
			try {
				const response = await fetch(`${base}${path}`, requestInit);
				if (!response.ok) {
					await throwApiClientError(response);
				}
				if (!response.body) {
					throw new Error("No response body");
				}
				return response;
			} catch (error) {
				lastError = error;
				if (isNonRetriableClientError(error)) {
					throw error;
				}
				if (shouldLogFallbackError(error)) {
					console.warn("API fallback failed", {
						base,
						path,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}

		throw lastError instanceof Error
			? lastError
			: new Error("Failed to fetch API after fallbacks");
	}

	private buildJsonRequestInit(
		method: "POST" | "PATCH" | "PUT" | "DELETE",
		body?: unknown,
		headers?: HeadersInit,
	): RequestInit {
		const requestHeaders = this.buildRequestHeaders(headers, method);
		if (body !== undefined && !requestHeaders.has("Content-Type")) {
			requestHeaders.set("Content-Type", "application/json");
		}
		return {
			method,
			headers: requestHeaders,
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		};
	}

	private async fetchJsonRequestWithFallback<T>(
		path: string,
		method: "POST" | "PATCH" | "PUT" | "DELETE",
		body?: unknown,
		headers?: HeadersInit,
	): Promise<T> {
		return (await this.fetchJsonWithFallback(
			path,
			this.buildJsonRequestInit(method, body, headers),
		)) as T;
	}

	private async tryJsonRequest<T>(
		path: string,
		method: "POST" | "PATCH" | "PUT" | "DELETE",
		body?: unknown,
		options?: { headers?: HeadersInit; skipPrimary?: boolean },
	): Promise<T> {
		const response = await this.tryFallbackFetch(
			path,
			this.buildJsonRequestInit(method, body, options?.headers),
			options?.skipPrimary ?? false,
		);
		return (await safeJson(response)) as T;
	}

	/**
	 * Send a chat message and receive streaming response (text only - for backward compatibility)
	 */
	async *chat(request: ChatRequest): AsyncGenerator<string, void, unknown> {
		const response = await this.openChatStream(request, {
			"x-composer-slim-events": "1",
			"x-maestro-slim-events": "1",
		});

		const reader = response.body!.getReader();

		const decoder = new TextDecoder();
		let buffer = "";
		let sawTextDelta = false;
		let sawMessageUpdateDelta = false;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				if (buffer.length > MAX_SSE_BUFFER) {
					throw new Error("SSE buffer exceeded maximum size (1MB)");
				}

				const parsed = parseSseEvents(buffer);
				buffer = parsed.remainder;

				for (const sseEvent of parsed.events) {
					const data = sseEvent.data.trim();
					if (!data || data === "[DONE]") continue;

					try {
						const event = JSON.parse(data);

						// Handle different event types from Agent
						if (event.type === "done") {
							return;
						}
						if (
							event.type === "message_update" &&
							event.assistantMessageEvent
						) {
							const msgEvent = event.assistantMessageEvent;
							if (msgEvent.type === "text_delta" && msgEvent.delta) {
								sawTextDelta = true;
								sawMessageUpdateDelta = true;
								yield msgEvent.delta;
							} else if (
								!sawTextDelta &&
								msgEvent.type === "text_end" &&
								msgEvent.content
							) {
								sawTextDelta = true;
								sawMessageUpdateDelta = true;
								yield msgEvent.content;
							} else if (
								!sawTextDelta &&
								msgEvent.type === "done" &&
								msgEvent.message
							) {
								const finalText = extractTextFromMessage(msgEvent.message);
								if (finalText) {
									sawTextDelta = true;
									sawMessageUpdateDelta = true;
									yield finalText;
								}
							}
						} else if (
							event.type === "message_end" &&
							!sawTextDelta &&
							event.message?.role === "assistant"
						) {
							const finalText = extractTextFromMessage(event.message);
							if (finalText) {
								sawTextDelta = true;
								sawMessageUpdateDelta = true;
								yield finalText;
							}
						} else if (
							event.type === "content_block_delta" &&
							!sawMessageUpdateDelta
						) {
							const deltaText =
								event?.delta?.text ?? event?.text ?? event?.delta;
							if (typeof deltaText === "string" && deltaText.length > 0) {
								sawTextDelta = true;
								yield deltaText;
							}
						} else if (event.type === "text_delta" && !sawMessageUpdateDelta) {
							const deltaText = event?.delta ?? event?.text;
							if (typeof deltaText === "string" && deltaText.length > 0) {
								sawTextDelta = true;
								yield deltaText;
							}
						} else if (
							event.type === "text" &&
							event.text &&
							!sawMessageUpdateDelta
						) {
							sawTextDelta = true;
							yield event.text;
						}
					} catch (e) {
						console.warn("Failed to parse SSE data:", data);
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	private buildWebSocketUrl(
		path: string,
		params?: Record<string, string>,
	): string {
		const url = new URL(path, this.baseUrl);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		if (params) {
			for (const [key, value] of Object.entries(params)) {
				url.searchParams.set(key, value);
			}
		}
		return url.toString();
	}

	private async *chatWithSse(
		request: ChatRequest,
	): AsyncGenerator<AgentEvent, void, unknown> {
		const response = await this.openChatStream(request, {
			"x-composer-client-tools": "1",
			"x-maestro-client-tools": "1",
			"x-composer-slim-events": "1",
			"x-maestro-slim-events": "1",
		});

		const reader = response.body!.getReader();

		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				if (buffer.length > MAX_SSE_BUFFER) {
					throw new Error("SSE buffer exceeded maximum size (1MB)");
				}

				const parsed = parseSseEvents(buffer);
				buffer = parsed.remainder;

				for (const sseEvent of parsed.events) {
					const data = sseEvent.data.trim();
					if (!data || data === "[DONE]") continue;

					try {
						const parsedEvent = JSON.parse(data);
						if (VALIDATE_AGENT_EVENTS && !isComposerAgentEvent(parsedEvent)) {
							console.warn("Invalid agent event payload:", parsedEvent);
							continue;
						}
						yield parsedEvent as AgentEvent;
					} catch (e) {
						console.warn("Failed to parse SSE data:", data);
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	private async *chatWithWebSocket(
		request: ChatRequest,
	): AsyncGenerator<AgentEvent, void, unknown> {
		if (VALIDATE_CHAT_REQUESTS && !isComposerChatRequest(request)) {
			throw new Error("Invalid chat request payload");
		}
		if (!this.canUseWebSocketTransport()) {
			throw new Error(
				"WebSocket transport is unavailable when auth headers are required",
			);
		}

		const url = this.buildWebSocketUrl("/api/chat/ws", {
			clientTools: "1",
			slim: "1",
			client: "web",
		});

		const ws = new WebSocket(url);
		const queue: AgentEvent[] = [];
		let done = false;
		let sawDoneEvent = false;
		let error: Error | null = null;
		let notify: (() => void) | null = null;

		const waitForNext = () =>
			new Promise<void>((resolve) => {
				notify = resolve;
			});

		ws.addEventListener("message", (event) => {
			try {
				const raw =
					typeof event.data === "string"
						? event.data
						: event.data instanceof ArrayBuffer
							? new TextDecoder().decode(event.data)
							: "";
				if (!raw) return;
				const parsed = JSON.parse(raw);
				if (parsed && typeof parsed === "object" && parsed.type === "done") {
					sawDoneEvent = true;
					done = true;
					if (VALIDATE_AGENT_EVENTS && !isComposerAgentEvent(parsed)) {
						console.warn("Invalid agent event payload:", parsed);
						if (notify) notify();
						return;
					}
					queue.push(parsed as AgentEvent);
					if (notify) notify();
					return;
				}
				if (
					parsed &&
					typeof parsed === "object" &&
					parsed.type === "heartbeat"
				) {
					return;
				}
				if (VALIDATE_AGENT_EVENTS && !isComposerAgentEvent(parsed)) {
					console.warn("Invalid agent event payload:", parsed);
					return;
				}
				queue.push(parsed as AgentEvent);
				if (notify) notify();
			} catch (e) {
				console.warn("Failed to parse WebSocket data:", event.data);
			}
		});

		ws.addEventListener("error", () => {
			error = new Error("WebSocket error");
			done = true;
			if (notify) notify();
		});

		ws.addEventListener("close", () => {
			if (!sawDoneEvent && !error) {
				error = new Error("WebSocket closed before completion");
			}
			done = true;
			if (notify) notify();
		});

		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener(
				"error",
				() => reject(new Error("WebSocket connection failed")),
				{ once: true },
			);
		});

		ws.send(JSON.stringify({ ...request, stream: true }));

		try {
			while (!done || queue.length > 0) {
				if (queue.length === 0) {
					await waitForNext();
					continue;
				}
				const next = queue.shift();
				if (next) {
					yield next;
				}
			}
		} finally {
			if (ws.readyState === WebSocket.OPEN) {
				ws.close();
			}
		}

		if (error) throw error;
	}

	/**
	 * Send a chat message and stream ALL agent events (text deltas, tool calls, thinking, etc.)
	 */
	async *chatWithEvents(
		request: ChatRequest,
	): AsyncGenerator<AgentEvent, void, unknown> {
		if (this.transportPreference === "ws") {
			if (this.canUseWebSocketTransport()) {
				yield* this.chatWithWebSocket(request);
			} else {
				yield* this.chatWithSse(request);
			}
			return;
		}
		if (this.transportPreference === "sse") {
			yield* this.chatWithSse(request);
			return;
		}
		let sawEvent = false;
		try {
			for await (const event of this.chatWithSse(request)) {
				sawEvent = true;
				yield event;
			}
		} catch (err) {
			if (
				!sawEvent &&
				this.canUseWebSocketTransport() &&
				!(err instanceof ApiClientError)
			) {
				yield* this.chatWithWebSocket(request);
				return;
			}
			throw err;
		}
	}

	/**
	 * Submit the result of a client-side tool execution back to the server.
	 *
	 * The server will resolve the pending tool call and continue the agent loop.
	 */
	async sendClientToolResult(input: {
		toolCallId: string;
		content: Array<
			| { type: "text"; text: string }
			| { type: "image"; data: string; mimeType: string }
		>;
		isError: boolean;
	}): Promise<void> {
		await this.tryFallbackFetch(
			"/api/chat/client-tool-result",
			this.buildJsonRequestInit("POST", input),
		);
	}

	async submitApprovalDecision(input: {
		requestId: string;
		decision: "approved" | "denied";
		reason?: string;
	}): Promise<{ success: boolean }> {
		return await this.fetchJsonRequestWithFallback<{ success: boolean }>(
			"/api/chat/approval",
			"POST",
			input,
		);
	}

	async submitToolRetryDecision(input: {
		requestId: string;
		action: "retry" | "skip" | "abort";
		reason?: string;
	}): Promise<{ success: boolean }> {
		return await this.fetchJsonRequestWithFallback<{ success: boolean }>(
			"/api/chat/tool-retry",
			"POST",
			input,
		);
	}

	/**
	 * Get list of available models
	 */
	async getModels(): Promise<Model[]> {
		try {
			const data = await this.fetchJsonWithFallback("/api/models");
			if (VALIDATE_API_RESPONSES && !isComposerModelListResponse(data)) {
				throw new Error("Invalid models response payload");
			}
			return data.models || [];
		} catch (e) {
			console.error("Failed to fetch models:", e);
			return [];
		}
	}

	/**
	 * Get current model info
	 */
	async getCurrentModel(): Promise<Model | null> {
		try {
			const data = await this.fetchJsonWithFallback("/api/model");
			if (VALIDATE_API_RESPONSES && !isComposerModel(data)) {
				throw new Error("Invalid model response payload");
			}
			return (data as Model) ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * Set current model
	 */
	async setModel(modelId: string): Promise<void> {
		await this.tryFallbackFetch(
			"/api/model",
			this.buildJsonRequestInit("POST", { model: modelId }),
			false,
			true,
		);
	}

	/**
	 * Get workspace files for mention
	 */
	async getFiles(options: { throwOnError?: boolean } = {}): Promise<string[]> {
		try {
			const data = await this.fetchJsonWithFallback("/api/files");
			if (VALIDATE_API_RESPONSES && !isComposerFilesResponse(data)) {
				throw new Error("Invalid files response payload");
			}
			return data.files || [];
		} catch (e) {
			console.error("Failed to fetch files:", e);
			if (options.throwOnError) {
				throw e;
			}
			return [];
		}
	}

	/**
	 * Get custom commands from the server.
	 */
	async getCommands(): Promise<CommandDefinition[]> {
		try {
			const data = await this.fetchJsonWithFallback("/api/commands");
			if (VALIDATE_API_RESPONSES && !isComposerCommandListResponse(data)) {
				throw new Error("Invalid commands response payload");
			}
			return data.commands || [];
		} catch (e) {
			console.error("Failed to fetch commands:", e);
			return [];
		}
	}

	/**
	 * Get available npm scripts for /run.
	 */
	async getRunScripts(): Promise<string[]> {
		try {
			const data = await this.fetchJsonWithFallback("/api/run?action=scripts");
			if (!data || typeof data !== "object") return [];
			const scripts = (data as { scripts?: unknown }).scripts;
			return Array.isArray(scripts)
				? scripts.filter((s): s is string => typeof s === "string")
				: [];
		} catch (e) {
			console.error("Failed to fetch run scripts:", e);
			return [];
		}
	}

	/**
	 * Run an npm script via /api/run.
	 */
	async runScript(
		script: string,
		args?: string,
	): Promise<{
		success: boolean;
		exitCode: number;
		stdout?: string;
		stderr?: string;
		command?: string;
	}> {
		const data = await this.fetchJsonRequestWithFallback<{
			success: boolean;
			exitCode: number;
			stdout?: string;
			stderr?: string;
			command?: string;
		}>("/api/run", "POST", { script, args });
		if (!data || typeof data !== "object") {
			throw new Error("Invalid run response payload");
		}
		return data;
	}

	/**
	 * Get list of sessions
	 */
	async getSessions(): Promise<SessionSummary[]> {
		try {
			const data = await this.fetchJsonWithFallback("/api/sessions");
			if (VALIDATE_API_RESPONSES && !isComposerSessionListResponse(data)) {
				throw new Error("Invalid sessions response payload");
			}
			return data.sessions || [];
		} catch (e) {
			console.error("Failed to fetch sessions:", e);
			return [];
		}
	}

	/**
	 * Get workspace status (cwd, git, context files, server info)
	 */
	async getStatus(): Promise<WorkspaceStatus | null> {
		try {
			const data = await this.fetchJsonWithFallback("/api/status");
			if (VALIDATE_API_RESPONSES && !isComposerStatusResponse(data)) {
				throw new Error("Invalid status response payload");
			}
			return data as WorkspaceStatus;
		} catch (e) {
			console.error("Failed to fetch status:", e);
			return null;
		}
	}

	/**
	 * Get usage summary (costs and token counts)
	 */
	async getUsage(): Promise<UsageSummary | null> {
		try {
			const data = await this.fetchJsonWithFallback("/api/usage");
			if (VALIDATE_API_RESPONSES && !isComposerUsageResponse(data)) {
				throw new Error("Invalid usage response payload");
			}
			return data.summary || null;
		} catch (e) {
			console.error("Failed to fetch usage:", e);
			return null;
		}
	}

	/**
	 * Get a specific session
	 */
	async getSession(sessionId: string): Promise<Session> {
		const data = await this.fetchJsonWithFallback(`/api/sessions/${sessionId}`);
		if (VALIDATE_API_RESPONSES && !isComposerSession(data)) {
			throw new Error("Invalid session payload");
		}
		return data as Session;
	}

	/**
	 * Create a share link for a session.
	 */
	async shareSession(
		sessionId: string,
		options?: {
			expiresInHours?: number;
			maxAccesses?: number | null;
			allowSensitiveContent?: boolean;
		},
	): Promise<{
		shareToken: string;
		shareUrl: string;
		webShareUrl?: string;
		expiresAt: string;
		maxAccesses: number | null;
	}> {
		return await this.tryJsonRequest<{
			shareToken: string;
			shareUrl: string;
			webShareUrl?: string;
			expiresAt: string;
			maxAccesses: number | null;
		}>(
			`/api/sessions/${encodeURIComponent(sessionId)}/share`,
			"POST",
			options ?? {},
			{ headers: { Accept: "application/json" } },
		);
	}

	async exportSession(
		sessionId: string,
		options?: {
			format?: "json" | "markdown" | "text";
			allowSensitiveContent?: boolean;
		},
	): Promise<Response> {
		return await this.tryFallbackFetch(
			`/api/sessions/${encodeURIComponent(sessionId)}/export`,
			this.buildJsonRequestInit("POST", {
				format: options?.format || "json",
				allowSensitiveContent: options?.allowSensitiveContent ?? false,
			}),
		);
	}

	/**
	 * Get a shared session by share token (read-only).
	 */
	async getSharedSession(shareToken: string): Promise<Session> {
		const data = await this.fetchJsonWithFallback(
			`/api/sessions/shared/${encodeURIComponent(shareToken)}`,
		);
		return data as Session;
	}

	private buildSessionArtifactViewerUrl(
		sessionId: string,
		filename: string,
	): string {
		const url = new URL(
			`/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(filename)}/view`,
			this.baseUrl,
		);
		return url.toString();
	}

	private buildSessionArtifactFileUrl(
		sessionId: string,
		filename: string,
		options?: {
			download?: boolean;
			raw?: boolean;
			standalone?: boolean;
		},
	): string {
		const url = new URL(
			`/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(filename)}`,
			this.baseUrl,
		);
		if (options?.download) url.searchParams.set("download", "1");
		if (options?.raw) url.searchParams.set("raw", "1");
		if (options?.standalone) url.searchParams.set("standalone", "1");
		return url.toString();
	}

	private buildSessionArtifactsZipUrl(sessionId: string): string {
		const url = new URL(
			`/api/sessions/${encodeURIComponent(sessionId)}/artifacts.zip`,
			this.baseUrl,
		);
		return url.toString();
	}

	private async createSessionArtifactAccess(
		sessionId: string,
		input: {
			filename?: string;
			actions: SessionArtifactAccessAction[];
		},
	): Promise<SessionArtifactAccessResponse> {
		const params = new URLSearchParams();
		params.set("actions", input.actions.join(","));
		if (input.filename) {
			params.set("filename", input.filename);
		}

		return (await this.fetchJsonWithFallback(
			`/api/sessions/${encodeURIComponent(sessionId)}/artifact-access?${params.toString()}`,
		)) as SessionArtifactAccessResponse;
	}

	async resolveSessionArtifactViewUrl(
		sessionId: string,
		filename: string,
	): Promise<string> {
		if (!this.hasHeaderBasedAuth()) {
			return this.buildSessionArtifactViewerUrl(sessionId, filename);
		}

		const access = await this.createSessionArtifactAccess(sessionId, {
			filename,
			actions: ["view", "file", "events", "zip"],
		});
		return await this.fetchArtifactObjectUrl(
			`/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(filename)}/view`,
			access.token,
		);
	}

	async resolveSessionArtifactDownloadUrl(
		sessionId: string,
		filename: string,
		options?: { standalone?: boolean; raw?: boolean },
	): Promise<string> {
		const raw = options?.standalone ? false : (options?.raw ?? true);
		if (!this.hasHeaderBasedAuth()) {
			return this.buildSessionArtifactFileUrl(sessionId, filename, {
				download: true,
				raw,
				standalone: options?.standalone,
			});
		}

		const access = await this.createSessionArtifactAccess(sessionId, {
			filename,
			actions: ["file"],
		});
		const params = new URLSearchParams();
		params.set("download", "1");
		if (raw) params.set("raw", "1");
		if (options?.standalone) params.set("standalone", "1");
		return await this.fetchArtifactObjectUrl(
			`/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(filename)}?${params.toString()}`,
			access.token,
		);
	}

	async resolveSessionArtifactsZipUrl(sessionId: string): Promise<string> {
		if (!this.hasHeaderBasedAuth()) {
			return this.buildSessionArtifactsZipUrl(sessionId);
		}

		const access = await this.createSessionArtifactAccess(sessionId, {
			actions: ["zip"],
		});
		return await this.fetchArtifactObjectUrl(
			`/api/sessions/${encodeURIComponent(sessionId)}/artifacts.zip`,
			access.token,
		);
	}

	/**
	 * Fetch raw bytes for a session attachment (for lazy-loaded session history).
	 */
	async getSessionAttachmentBytes(
		sessionId: string,
		attachmentId: string,
	): Promise<ArrayBuffer> {
		const path = `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`;
		const response = await this.tryFallbackFetch(path, { method: "GET" });
		return await response.arrayBuffer();
	}

	async getSharedSessionAttachmentBytes(
		shareToken: string,
		attachmentId: string,
	): Promise<ArrayBuffer> {
		const path = `/api/sessions/shared/${encodeURIComponent(shareToken)}/attachments/${encodeURIComponent(attachmentId)}`;
		const response = await this.tryFallbackFetch(path, { method: "GET" });
		return await response.arrayBuffer();
	}

	/**
	 * Fetch base64 content for a session attachment (for chat request hydration).
	 */
	async getSessionAttachmentContentBase64(
		sessionId: string,
		attachmentId: string,
	): Promise<string> {
		const bytes = await this.getSessionAttachmentBytes(sessionId, attachmentId);
		return arrayBufferToBase64(bytes);
	}

	async getSharedSessionAttachmentContentBase64(
		shareToken: string,
		attachmentId: string,
	): Promise<string> {
		const bytes = await this.getSharedSessionAttachmentBytes(
			shareToken,
			attachmentId,
		);
		return arrayBufferToBase64(bytes);
	}

	/**
	 * Server-side document extraction (PDF/DOCX/XLSX/PPTX/text).
	 */
	async extractAttachmentText(input: {
		fileName: string;
		mimeType?: string;
		contentBase64: string;
		maxChars?: number;
	}): Promise<AttachmentTextExtractionResponse> {
		return await this.tryJsonRequest<AttachmentTextExtractionResponse>(
			"/api/attachments/extract",
			"POST",
			input,
			{
				headers: { Accept: "application/json" },
			},
		);
	}

	async extractSessionAttachmentText(
		sessionId: string,
		attachmentId: string,
	): Promise<AttachmentTextExtractionResponse> {
		return await this.tryJsonRequest<AttachmentTextExtractionResponse>(
			`/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}/extract`,
			"POST",
			undefined,
			{
				headers: { Accept: "application/json" },
			},
		);
	}

	/**
	 * Create a new session
	 */
	async createSession(title?: string): Promise<Session> {
		const data = await this.fetchJsonRequestWithFallback<Session>(
			"/api/sessions",
			"POST",
			{ title },
		);
		if (VALIDATE_API_RESPONSES && !isComposerSession(data)) {
			throw new Error("Invalid session payload");
		}
		return data;
	}

	async updateSession(
		sessionId: string,
		updates: Partial<Pick<SessionSummary, "favorite" | "tags" | "title">>,
	): Promise<SessionSummary> {
		const data = await this.tryJsonRequest<SessionSummary>(
			`/api/sessions/${encodeURIComponent(sessionId)}`,
			"PATCH",
			updates,
			{ headers: { Accept: "application/json" } },
		);
		if (VALIDATE_API_RESPONSES && !isComposerSessionSummary(data)) {
			throw new Error("Invalid session summary payload");
		}
		return data;
	}

	/**
	 * Delete a session
	 */
	async deleteSession(sessionId: string): Promise<void> {
		await this.tryFallbackFetch(`/api/sessions/${sessionId}`, {
			method: "DELETE",
		});
	}

	async getCommandPrefs(): Promise<CommandPrefs> {
		try {
			const data = await this.fetchJsonWithFallback("/api/command-prefs");
			if (VALIDATE_API_RESPONSES && !isComposerCommandPrefs(data)) {
				throw new Error("Invalid command prefs payload");
			}
			return data as CommandPrefs;
		} catch {
			return { favorites: [], recents: [] };
		}
	}

	async saveCommandPrefs(prefs: CommandPrefs): Promise<void> {
		const data = await this.tryJsonRequest(
			"/api/command-prefs",
			"POST",
			prefs,
			{ headers: { Accept: "application/json" } },
		);
		if (VALIDATE_API_RESPONSES && !isComposerCommandPrefsWriteResponse(data)) {
			throw new Error("Invalid command prefs write response");
		}
	}

	async getConfig(): Promise<ConfigResponse> {
		const data = await this.fetchJsonWithFallback("/api/config");
		if (VALIDATE_API_RESPONSES && !isComposerConfigResponse(data)) {
			throw new Error("Invalid config response payload");
		}
		return data as ConfigResponse;
	}

	async saveConfig(payload: ConfigWriteRequest): Promise<ConfigWriteResponse> {
		const data = await this.tryJsonRequest<ConfigWriteResponse>(
			"/api/config",
			"POST",
			payload,
			{ headers: { Accept: "application/json" } },
		);
		if (VALIDATE_API_RESPONSES && !isComposerConfigWriteResponse(data)) {
			throw new Error("Invalid config write response payload");
		}
		return data;
	}

	async validatePolicy(
		policy: Record<string, unknown>,
	): Promise<PolicyValidationResponse> {
		return await this.tryJsonRequest<PolicyValidationResponse>(
			"/api/policy/validate",
			"POST",
			policy,
			{ headers: { Accept: "application/json" } },
		);
	}

	// Guardian
	async getGuardianStatus(): Promise<GuardianStatusResponse> {
		const data = await this.fetchJsonWithFallback("/api/guardian/status");
		if (VALIDATE_API_RESPONSES && !isComposerGuardianStatusResponse(data)) {
			throw new Error("Invalid guardian status response payload");
		}
		return data as GuardianStatusResponse;
	}

	async runGuardian(): Promise<GuardianRunResponse> {
		const data = await this.fetchJsonWithFallback("/api/guardian/run", {
			method: "POST",
		});
		if (VALIDATE_API_RESPONSES && !isComposerGuardianRunResponse(data)) {
			throw new Error("Invalid guardian run response payload");
		}
		return data as GuardianRunResponse;
	}

	async setGuardianEnabled(enabled: boolean): Promise<GuardianConfigResponse> {
		const data =
			await this.fetchJsonRequestWithFallback<GuardianConfigResponse>(
				"/api/guardian/config",
				"POST",
				{ enabled },
			);
		if (VALIDATE_API_RESPONSES && !isComposerGuardianConfigResponse(data)) {
			throw new Error("Invalid guardian config response payload");
		}
		return data;
	}

	// Plan Mode
	async getPlan(): Promise<PlanStatusResponse> {
		const data = await this.fetchJsonWithFallback("/api/plan");
		if (VALIDATE_API_RESPONSES && !isComposerPlanStatusResponse(data)) {
			throw new Error("Invalid plan status response payload");
		}
		return data as PlanStatusResponse;
	}

	async enterPlanMode(
		name?: string,
		sessionId?: string,
	): Promise<PlanActionResponse> {
		const data = await this.fetchJsonRequestWithFallback<PlanActionResponse>(
			"/api/plan",
			"POST",
			{ action: "enter", name, sessionId },
		);
		if (VALIDATE_API_RESPONSES && !isComposerPlanActionResponse(data)) {
			throw new Error("Invalid plan action response payload");
		}
		return data;
	}

	async exitPlanMode(): Promise<PlanActionResponse> {
		const data = await this.fetchJsonRequestWithFallback<PlanActionResponse>(
			"/api/plan",
			"POST",
			{ action: "exit" },
		);
		if (VALIDATE_API_RESPONSES && !isComposerPlanActionResponse(data)) {
			throw new Error("Invalid plan action response payload");
		}
		return data;
	}

	async updatePlan(content: string): Promise<PlanActionResponse> {
		const data = await this.fetchJsonRequestWithFallback<PlanActionResponse>(
			"/api/plan",
			"POST",
			{ action: "update", content },
		);
		if (VALIDATE_API_RESPONSES && !isComposerPlanActionResponse(data)) {
			throw new Error("Invalid plan action response payload");
		}
		return data;
	}

	// MCP
	async getMcpStatus(): Promise<McpStatus> {
		return (await this.fetchJsonWithFallback("/api/mcp")) as McpStatus;
	}

	async searchMcpRegistry(query = ""): Promise<McpRegistrySearchResponse> {
		const params = new URLSearchParams({ action: "search-registry" });
		const trimmedQuery = query.trim();
		if (trimmedQuery.length > 0) {
			params.set("query", trimmedQuery);
		}
		return (await this.fetchJsonWithFallback(
			`/api/mcp?${params.toString()}`,
		)) as McpRegistrySearchResponse;
	}

	async importMcpRegistry(
		input: McpRegistryImportRequest,
	): Promise<McpRegistryImportResponse> {
		return await this.fetchJsonRequestWithFallback<McpRegistryImportResponse>(
			"/api/mcp?action=import-registry",
			"POST",
			input,
		);
	}

	async addMcpServer(
		input: McpServerAddRequest,
	): Promise<McpServerMutationResponse> {
		return await this.fetchJsonRequestWithFallback<McpServerMutationResponse>(
			"/api/mcp?action=add-server",
			"POST",
			input,
		);
	}

	async updateMcpServer(
		input: McpServerUpdateRequest,
	): Promise<McpServerMutationResponse> {
		return await this.fetchJsonRequestWithFallback<McpServerMutationResponse>(
			"/api/mcp?action=update-server",
			"POST",
			input,
		);
	}

	async removeMcpServer(
		input: McpServerRemoveRequest,
	): Promise<McpServerRemoveResponse> {
		return await this.fetchJsonRequestWithFallback<McpServerRemoveResponse>(
			"/api/mcp?action=remove-server",
			"POST",
			input,
		);
	}

	async addMcpAuthPreset(
		input: McpAuthPresetAddRequest,
	): Promise<McpAuthPresetMutationResponse> {
		return await this.fetchJsonRequestWithFallback<McpAuthPresetMutationResponse>(
			"/api/mcp?action=add-auth-preset",
			"POST",
			input,
		);
	}

	async updateMcpAuthPreset(
		input: McpAuthPresetUpdateRequest,
	): Promise<McpAuthPresetMutationResponse> {
		return await this.fetchJsonRequestWithFallback<McpAuthPresetMutationResponse>(
			"/api/mcp?action=update-auth-preset",
			"POST",
			input,
		);
	}

	async removeMcpAuthPreset(
		input: McpAuthPresetRemoveRequest,
	): Promise<McpAuthPresetRemoveResponse> {
		return await this.fetchJsonRequestWithFallback<McpAuthPresetRemoveResponse>(
			"/api/mcp?action=remove-auth-preset",
			"POST",
			input,
		);
	}

	async readMcpResource(
		server: string,
		uri: string,
	): Promise<McpResourceReadResponse> {
		const params = new URLSearchParams({
			action: "read-resource",
			server,
			uri,
		});
		return (await this.fetchJsonWithFallback(
			`/api/mcp?${params.toString()}`,
		)) as McpResourceReadResponse;
	}

	async getMcpPrompt(
		server: string,
		name: string,
		args?: Record<string, string>,
	): Promise<McpPromptResponse> {
		const params = new URLSearchParams({
			action: "get-prompt",
			server,
			name,
		});
		for (const [key, value] of Object.entries(args ?? {})) {
			params.set(`arg:${key}`, value);
		}
		return (await this.fetchJsonWithFallback(
			`/api/mcp?${params.toString()}`,
		)) as McpPromptResponse;
	}

	// Background Tasks
	async getBackgroundStatus(): Promise<BackgroundStatusResponse> {
		const data = await this.fetchJsonWithFallback(
			"/api/background?action=status",
		);
		if (VALIDATE_API_RESPONSES && !isComposerBackgroundStatusResponse(data)) {
			throw new Error("Invalid background status response payload");
		}
		return data as BackgroundStatusResponse;
	}

	async getBackgroundHistory(limit = 10): Promise<BackgroundHistoryResponse> {
		const data = await this.fetchJsonWithFallback(
			`/api/background?action=history&limit=${limit}`,
		);
		if (VALIDATE_API_RESPONSES && !isComposerBackgroundHistoryResponse(data)) {
			throw new Error("Invalid background history response payload");
		}
		return data as BackgroundHistoryResponse;
	}

	async setBackgroundNotifications(
		enabled: boolean,
	): Promise<BackgroundUpdateResponse> {
		const data =
			await this.fetchJsonRequestWithFallback<BackgroundUpdateResponse>(
				"/api/background?action=notify",
				"POST",
				{ enabled },
			);
		if (VALIDATE_API_RESPONSES && !isComposerBackgroundUpdateResponse(data)) {
			throw new Error("Invalid background update response payload");
		}
		return data;
	}

	async setBackgroundStatusDetails(
		enabled: boolean,
	): Promise<BackgroundUpdateResponse> {
		const data =
			await this.fetchJsonRequestWithFallback<BackgroundUpdateResponse>(
				"/api/background?action=details",
				"POST",
				{ enabled },
			);
		if (VALIDATE_API_RESPONSES && !isComposerBackgroundUpdateResponse(data)) {
			throw new Error("Invalid background update response payload");
		}
		return data;
	}

	// Undo/Checkpoint
	async getUndoStatus(): Promise<UndoStatusResponse> {
		const data = await this.fetchJsonWithFallback("/api/undo?action=status");
		if (VALIDATE_API_RESPONSES && !isComposerUndoStatusResponse(data)) {
			throw new Error("Invalid undo status response payload");
		}
		return data as UndoStatusResponse;
	}

	async undoChanges(count = 1): Promise<UndoOperationResponse> {
		const data = await this.fetchJsonRequestWithFallback<UndoOperationResponse>(
			"/api/undo",
			"POST",
			{ action: "undo", count },
		);
		if (VALIDATE_API_RESPONSES && !isComposerUndoOperationResponse(data)) {
			throw new Error("Invalid undo operation response payload");
		}
		return data;
	}

	async getChanges(
		filter?: "all" | "files" | "tools",
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/changes${filter ? `?filter=${filter}` : ""}`,
		);
	}

	// Approvals
	async getApprovalMode(
		sessionId = "default",
	): Promise<ApprovalsStatusResponse> {
		const data = await this.fetchJsonWithFallback(
			`/api/approvals?sessionId=${encodeURIComponent(sessionId)}`,
		);
		if (VALIDATE_API_RESPONSES && !isComposerApprovalsStatusResponse(data)) {
			throw new Error("Invalid approvals status response payload");
		}
		return data as ApprovalsStatusResponse;
	}

	async setApprovalMode(
		mode: "auto" | "prompt" | "fail",
		sessionId = "default",
	): Promise<ApprovalsUpdateResponse> {
		const data =
			await this.fetchJsonRequestWithFallback<ApprovalsUpdateResponse>(
				`/api/approvals?sessionId=${encodeURIComponent(sessionId)}`,
				"POST",
				{ mode, sessionId },
			);
		if (VALIDATE_API_RESPONSES && !isComposerApprovalsUpdateResponse(data)) {
			throw new Error("Invalid approvals update response payload");
		}
		return data;
	}

	// Framework
	async getFrameworkPreference(): Promise<FrameworkStatusResponse> {
		const data = await this.fetchJsonWithFallback(
			"/api/framework?action=status",
		);
		if (VALIDATE_API_RESPONSES && !isComposerFrameworkStatusResponse(data)) {
			throw new Error("Invalid framework status response payload");
		}
		return data as FrameworkStatusResponse;
	}

	async listFrameworks(): Promise<FrameworkListResponse> {
		const data = await this.fetchJsonWithFallback("/api/framework?action=list");
		if (VALIDATE_API_RESPONSES && !isComposerFrameworkListResponse(data)) {
			throw new Error("Invalid framework list response payload");
		}
		return data as FrameworkListResponse;
	}

	async setFramework(
		framework: string | null,
		scope: "user" | "workspace" = "user",
	): Promise<FrameworkUpdateResponse> {
		const data =
			await this.fetchJsonRequestWithFallback<FrameworkUpdateResponse>(
				"/api/framework",
				"POST",
				{ framework, scope },
			);
		if (VALIDATE_API_RESPONSES && !isComposerFrameworkUpdateResponse(data)) {
			throw new Error("Invalid framework update response payload");
		}
		return data;
	}

	// Tools
	async getTools(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/tools?action=list");
	}

	// Review
	async getReview(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/review");
	}

	// Context
	async getContext(sessionId?: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/context${sessionId ? `?sessionId=${sessionId}` : ""}`,
		);
	}

	// Stats
	async getStats(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/stats");
	}

	// Telemetry
	async getTelemetryStatus(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/telemetry");
	}

	async setTelemetry(
		action: "on" | "off" | "reset",
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback("/api/telemetry", "POST", {
			action,
		});
	}

	// Training
	async getTrainingStatus(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/training");
	}

	async setTraining(
		action: "on" | "off" | "reset",
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback("/api/training", "POST", {
			action,
		});
	}

	// Diagnostics
	async getDiagnostics(
		subcommand = "status",
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/diagnostics?subcommand=${subcommand}`,
		);
	}

	// LSP
	async getLspStatus(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/lsp?action=status");
	}

	async detectLspServers(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/lsp?action=detect");
	}

	async startLspServers(): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback("/api/lsp", "POST", {
			action: "start",
		});
	}

	async stopLspServers(): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback("/api/lsp", "POST", {
			action: "stop",
		});
	}

	async restartLspServers(): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback("/api/lsp", "POST", {
			action: "restart",
		});
	}

	// Workflow
	async listWorkflows(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/workflow?action=list");
	}

	async getWorkflow(name: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/workflow?action=show&name=${name}`,
		);
	}

	async validateWorkflow(name: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/workflow?action=validate&name=${name}`,
		);
	}

	async runWorkflow(name: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback("/api/workflow", "POST", {
			action: "run",
			name,
		});
	}

	// Ollama
	async listOllamaModels(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/ollama?action=list");
	}

	async getOllamaPs(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/ollama?action=ps");
	}

	async pullOllamaModel(model: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback("/api/ollama", "POST", {
			action: "pull",
			model,
		});
	}

	async showOllamaModel(model: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback("/api/ollama", "POST", {
			action: "show",
			model,
		});
	}

	// Preview
	async getPreview(file: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/preview?file=${encodeURIComponent(file)}`,
		);
	}

	// Composer
	async listComposers(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/composer");
	}

	async getComposer(name: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(`/api/composer?name=${name}`);
	}

	async activateComposer(name: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback("/api/composer", "POST", {
			action: "activate",
			name,
		});
	}

	async deactivateComposer(): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback("/api/composer", "POST", {
			action: "deactivate",
		});
	}

	// Cost
	async getCostSummary(period?: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/cost?action=summary${period ? `&period=${period}` : ""}`,
		);
	}

	async getCostBreakdown(period?: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/cost?action=breakdown${period ? `&period=${period}` : ""}`,
		);
	}

	async clearCostData(): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback("/api/cost", "POST", {
			action: "clear",
		});
	}

	// Quota
	async getQuotaStatus(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/quota?action=status");
	}

	async getQuotaDetailed(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/quota?action=detailed");
	}

	async getQuotaModels(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/quota?action=models");
	}

	async setQuotaLimit(limit: number): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback("/api/quota", "POST", {
			action: "limit",
			limit,
		});
	}

	// Memory
	async listMemoryTopics(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/memory?action=list");
	}

	async listMemoryTopic(topic: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/memory?action=list&topic=${topic}`,
		);
	}

	async searchMemory(
		query: string,
		limit = 10,
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/memory?action=search&query=${encodeURIComponent(query)}&limit=${limit}`,
		);
	}

	async getRecentMemories(limit = 10): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/memory?action=recent&limit=${limit}`,
		);
	}

	async getMemoryStats(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/memory?action=stats");
	}

	async saveMemory(
		topic: string,
		content: string,
		tags?: string[],
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback("/api/memory", "POST", {
			action: "save",
			topic,
			content,
			tags,
		});
	}

	async deleteMemory(
		id?: string,
		topic?: string,
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback("/api/memory", "POST", {
			action: "delete",
			id,
			topic,
		});
	}

	async exportMemory(path?: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback("/api/memory", "POST", {
			action: "export",
			path,
		});
	}

	async importMemory(path: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback("/api/memory", "POST", {
			action: "import",
			path,
		});
	}

	async clearMemory(force = false): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback("/api/memory", "POST", {
			action: "clear",
			force,
		});
	}

	// Mode
	async getCurrentMode(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/mode?action=current");
	}

	async listModes(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/mode?action=list");
	}

	async suggestMode(task?: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/mode?action=suggest${task ? `&task=${encodeURIComponent(task)}` : ""}`,
		);
	}

	async setMode(mode: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback("/api/mode", "POST", {
			mode,
		});
	}

	// Zen
	async getZenMode(sessionId: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(`/api/zen?sessionId=${sessionId}`);
	}

	async setZenMode(
		sessionId: string,
		enabled: boolean,
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonRequestWithFallback(
			`/api/zen?sessionId=${sessionId}`,
			"POST",
			{ enabled },
		);
	}

	// UI Settings
	async getUIStatus(sessionId: string): Promise<UIStatusResponse> {
		return await this.fetchJsonWithFallback(
			`/api/ui?action=status&sessionId=${encodeURIComponent(sessionId)}`,
		);
	}

	async setCleanMode(
		mode: "off" | "soft" | "aggressive",
		sessionId: string,
	): Promise<{ success: boolean; cleanMode: UIStatusResponse["cleanMode"] }> {
		return await this.fetchJsonRequestWithFallback(
			`/api/ui?sessionId=${encodeURIComponent(sessionId)}`,
			"POST",
			{ action: "clean", cleanMode: mode },
		);
	}

	async setFooterMode(
		mode: "ensemble" | "solo",
		sessionId: string,
	): Promise<{ success: boolean; footerMode: UIStatusResponse["footerMode"] }> {
		return await this.fetchJsonRequestWithFallback(
			`/api/ui?sessionId=${encodeURIComponent(sessionId)}`,
			"POST",
			{ action: "footer", footerMode: mode },
		);
	}

	async setCompactTools(
		enabled: boolean,
		sessionId: string,
	): Promise<{
		success: boolean;
		compactTools: boolean;
	}> {
		return await this.fetchJsonRequestWithFallback(
			`/api/ui?sessionId=${encodeURIComponent(sessionId)}`,
			"POST",
			{ action: "compact", compactTools: enabled },
		);
	}

	// Queue
	async getQueueStatus(sessionId: string): Promise<QueueStatusResponse> {
		return await this.fetchJsonWithFallback(
			`/api/queue?action=status&sessionId=${encodeURIComponent(sessionId)}`,
		);
	}

	async listQueue(sessionId: string): Promise<QueueListResponse> {
		return await this.fetchJsonWithFallback(
			`/api/queue?action=list&sessionId=${encodeURIComponent(sessionId)}`,
		);
	}

	async setQueueMode(
		mode: "one" | "all",
		sessionId: string,
	): Promise<{ success: boolean; mode: QueueStatusResponse["mode"] }> {
		return await this.fetchJsonRequestWithFallback("/api/queue", "POST", {
			action: "mode",
			mode,
			sessionId,
		});
	}

	async cancelQueuedPrompt(
		id: number,
		sessionId: string,
	): Promise<{ success: boolean; removed?: unknown }> {
		return await this.fetchJsonRequestWithFallback("/api/queue", "POST", {
			action: "cancel",
			id,
			sessionId,
		});
	}

	// Branch
	async listBranchOptions(sessionId: string): Promise<BranchListResponse> {
		if (!sessionId) {
			throw new Error("sessionId is required to list branches");
		}
		return await this.fetchJsonWithFallback(
			`/api/branch?action=list&sessionId=${encodeURIComponent(sessionId)}`,
		);
	}

	async createBranch(
		sessionId: string,
		options: { messageIndex?: number; userMessageNumber?: number },
	): Promise<{
		success: boolean;
		newSessionId: string;
		newSessionFile: string;
	}> {
		return await this.fetchJsonRequestWithFallback("/api/branch", "POST", {
			sessionId,
			...options,
		});
	}
}
