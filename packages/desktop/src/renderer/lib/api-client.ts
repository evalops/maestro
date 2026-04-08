/**
 * API Client for Composer Backend
 *
 * Handles communication with the embedded Composer server.
 */

import type {
	MemoryEntry,
	MemoryMutationResponse,
	MemoryRecentResponse,
	MemorySearchResponse,
	MemorySearchResult,
	MemoryStats,
	MemoryStatsResponse,
	MemoryTopicResponse,
	MemoryTopicSummary,
	MemoryTopicsResponse,
} from "@evalops/contracts";
import type {
	AgentEvent,
	AutomationTask,
	Message,
	Model,
	Session,
	SessionSummary,
	ThinkingLevel,
	WorkspaceStatus,
} from "./types";

const DEFAULT_BASE_URL =
	import.meta.env.VITE_MAESTRO_BASE_URL ?? "http://localhost:8080";
const DEFAULT_CSRF_TOKEN =
	import.meta.env.VITE_MAESTRO_CSRF_TOKEN ?? "maestro-desktop-csrf";
const MAX_SSE_BUFFER = 1024 * 1024; // 1MB

export type ApprovalMode = "auto" | "prompt" | "fail";
export type QueueMode = "one" | "all";
export type CleanMode = "off" | "soft" | "aggressive";
export type FooterMode = "ensemble" | "solo";

export interface UiStatus {
	zenMode: boolean;
	cleanMode: CleanMode;
	footerMode: FooterMode;
	compactTools: boolean;
	queueMode: QueueMode;
}

export interface ApprovalsStatus {
	mode: ApprovalMode;
	availableModes: ApprovalMode[];
}

export interface QueueStatus {
	mode: QueueMode;
	pendingCount: number;
	enabled: boolean;
}

export interface FrameworkStatus {
	framework: string;
	source: string;
	locked: boolean;
	scope: "user" | "workspace";
}

export interface FrameworkSummary {
	id: string;
	summary?: string;
}

export interface FrameworkList {
	frameworks: FrameworkSummary[];
}

export interface TelemetryStatus {
	enabled: boolean;
	reason: string;
	endpoint?: string;
	filePath?: string;
	sampleRate: number;
	flagValue?: string;
	runtimeOverride?: "enabled" | "disabled";
	overrideReason?: string;
}

export interface TrainingStatus {
	preference: "opted-in" | "opted-out" | "provider-default";
	optOut: boolean | null;
	flagValue?: string;
	runtimeOverride?: "opted-in" | "opted-out";
	overrideReason?: string;
	reason: string;
}

export interface ModeConfig {
	displayName?: string;
	description?: string;
	primaryTier?: string;
	fallbackTier?: string;
	enableThinking?: boolean;
	thinkingBudget?: number;
	useExtendedContext?: boolean;
	maxRetries?: number;
	costMultiplier?: number;
	speedHint?: number;
}

export interface ModeModelSummary {
	id: string;
	provider: string;
	name?: string;
}

export interface ModeSummary {
	mode: string;
	config: ModeConfig;
}

export interface ModeStatus {
	mode: string;
	config?: ModeConfig;
	model?: ModeModelSummary;
}

export interface ModeList {
	modes: Array<string | ModeSummary>;
}

export interface GuardianRunResult {
	status: "passed" | "failed" | "skipped" | "error";
	startedAt: number;
	durationMs: number;
	filesScanned: number;
	summary: string;
	exitCode?: number;
	target?: string;
}

export interface GuardianState {
	enabled: boolean;
	lastRun?: GuardianRunResult;
}

export interface GuardianStatus {
	enabled: boolean;
	state: GuardianState;
}

export interface PlanState {
	active: boolean;
	filePath: string;
	name?: string;
	createdAt?: string;
	updatedAt?: string;
	sessionId?: string;
	gitBranch?: string;
	gitCommitSha?: string;
}

export interface PlanStatus {
	state: PlanState | null;
	content: string | null;
}

export interface PlanActionResponse {
	success: boolean;
	state?: PlanState;
}

export interface BackgroundStatus {
	settings: {
		notificationsEnabled: boolean;
		statusDetailsEnabled: boolean;
	};
	snapshot: {
		running: number;
		total: number;
		failed: number;
		detailsRedacted?: boolean;
	} | null;
}

export interface BackgroundUpdateResponse {
	success: boolean;
	message?: string;
}

export interface LspServerStatus {
	id: string;
	root: string;
	initialized: boolean;
	fileCount: number;
	diagnosticCount: number;
}

export interface LspStatus {
	enabled: boolean;
	autostart: boolean;
	servers: LspServerStatus[];
}

export interface LspDetections {
	detections: Array<{ serverId: string; root: string }>;
}

export type PackageScope = "local" | "project" | "user";

export interface PackageResourceFilters {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export interface PackageInspectionResult {
	sourceSpec: string;
	resolvedSource: string;
	sourceType: "local" | "git" | "npm";
	resolvedPath: string;
	discovered: {
		name: string;
		version?: string;
		isMaestroPackage: boolean;
		hasManifest: boolean;
		manifestPaths?: PackageResourceFilters | null;
		errors: string[];
	} | null;
	resources: {
		extensions: string[];
		skills: string[];
		prompts: string[];
		themes: string[];
	} | null;
}

export interface PackageStatusEntry {
	scope: PackageScope;
	configPath: string;
	sourceSpec: string;
	filters: PackageResourceFilters | null;
	inspection: PackageInspectionResult | null;
	issues: string[] | null;
	error: string | null;
}

export interface PackageStatusResponse {
	packages: PackageStatusEntry[];
}

export interface PackageInspectResponse {
	inspection: PackageInspectionResult;
	issues: string[];
}

export interface PackageBulkRefreshEntry {
	source: string;
	sourceType: "git" | "npm";
	scopes: PackageScope[];
	inspection: PackageInspectionResult | null;
	issues: string[];
	error: string | null;
}

export interface PackageBulkRefreshResponse {
	refreshed: PackageBulkRefreshEntry[];
	localCount: number;
	remoteCount: number;
}

export interface PackageCachePruneResponse {
	cacheDir: string;
	removed: string[];
	removedCount: number;
	referencedCount: number;
}

export interface PackageMutationRequest {
	source: string;
	scope?: PackageScope;
}

export interface PackageAddResponse {
	path: string;
	scope: PackageScope;
	spec: string;
}

export interface PackageRemoveResponse {
	path: string;
	scope: PackageScope;
	removedCount: number;
	fallback?: {
		scope: PackageScope;
		sourceSpec: string;
	} | null;
}

export interface McpServerStatus {
	name: string;
	connected: boolean;
	scope?: "enterprise" | "plugin" | "project" | "local" | "user";
	transport?: "stdio" | "http" | "sse";
	tools?:
		| Array<{
				name: string;
				description?: string;
				inputSchema?: unknown;
				annotations?: Record<string, unknown>;
		  }>
		| number;
	resources?: string[];
	prompts?: string[];
	promptDetails?: McpPromptDefinition[];
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
	remoteTrust?: "official" | "custom" | "unknown";
	officialRegistry?: {
		displayName?: string;
		directoryUrl?: string;
		documentationUrl?: string;
		permissions?: string;
		authorName?: string;
		url?: string;
	};
	projectApproval?: "pending" | "approved" | "denied";
}

export interface McpPromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

export interface McpPromptDefinition {
	name: string;
	title?: string;
	description?: string;
	arguments?: McpPromptArgument[];
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

export interface McpOfficialRegistryUrlOption {
	url: string;
	label?: string;
	description?: string;
}

export interface McpOfficialRegistryEntry {
	displayName?: string;
	directoryUrl?: string;
	documentationUrl?: string;
	permissions?: string;
	authorName?: string;
	url?: string;
	slug?: string;
	serverName?: string;
	oneLiner?: string;
	transport?: "stdio" | "http" | "sse";
	urlOptions?: McpOfficialRegistryUrlOption[];
	urlRegex?: string;
	toolCount?: number;
	promptCount?: number;
}

export interface McpRegistrySearchResponse {
	query: string;
	entries: McpOfficialRegistryEntry[];
}

export interface McpResourceReadResponse {
	contents: Array<{
		uri: string;
		text?: string;
		blob?: string;
		mimeType?: string;
	}>;
}

export interface McpPromptResponse {
	description?: string;
	messages: Array<{
		role: string;
		content: string;
	}>;
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

export interface McpProjectApprovalRequest {
	name: string;
	decision: "approved" | "denied";
}

export interface McpProjectApprovalResponse {
	name: string;
	scope: "project";
	decision: "approved" | "denied";
	projectApproval: "pending" | "approved" | "denied";
}

export type {
	MemoryEntry,
	MemoryMutationResponse,
	MemoryRecentResponse,
	MemorySearchResponse,
	MemorySearchResult,
	MemoryStats,
	MemoryStatsResponse,
	MemoryTopicResponse,
	MemoryTopicSummary,
	MemoryTopicsResponse,
};

export interface AutomationCreateInput {
	name: string;
	prompt: string;
	schedule: string | null;
	scheduleLabel?: string;
	scheduleKind?: "once" | "daily" | "weekly" | "cron";
	scheduleTime?: string;
	scheduleDays?: number[];
	runAt?: string;
	cronExpression?: string;
	timezone?: string;
	enabled?: boolean;
	sessionMode?: "reuse" | "new";
	sessionId?: string | null;
	contextPaths?: string[];
	contextFolders?: string[];
	runWindow?: {
		start?: string;
		end?: string;
		days?: number[];
	} | null;
	exclusive?: boolean;
	notifyOnSuccess?: boolean;
	notifyOnFailure?: boolean;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export type AutomationUpdateInput = Partial<AutomationCreateInput> & {
	enabled?: boolean;
	clearHistory?: boolean;
};

export interface AutomationPreviewInput {
	schedule?: string | null;
	runAt?: string | null;
	timezone?: string;
}

export interface AutomationPreviewResponse {
	nextRun: string | null;
	timezone: string;
	timezoneValid: boolean;
	error?: string;
}

export interface AutomationsResponse {
	automations: AutomationTask[];
}

export interface MagicDocDefinition {
	path: string;
	title: string;
	instructions?: string;
}

export interface MagicDocsAutomationTemplateResponse {
	magicDocs: MagicDocDefinition[];
	template: {
		name: string;
		prompt: string;
		contextPaths: string[];
	} | null;
}

export interface ComposerProfile {
	name: string;
	description?: string;
	builtIn?: boolean;
	source?: string;
	filePath?: string;
}

export interface ComposerStatus {
	composers: ComposerProfile[];
	active?: ComposerProfile | null;
}

export class ApiClient {
	private baseUrl: string;
	private csrfToken: string;

	constructor(baseUrl: string = DEFAULT_BASE_URL) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.csrfToken = DEFAULT_CSRF_TOKEN;
	}

	private async fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
		const method = (options?.method || "GET").toUpperCase();
		const needsCsrf =
			method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
		const response = await fetch(`${this.baseUrl}${path}`, {
			...options,
			headers: {
				"Content-Type": "application/json",
				...(needsCsrf
					? {
							"x-composer-csrf": this.csrfToken,
							"x-maestro-csrf": this.csrfToken,
						}
					: {}),
				...options?.headers,
			},
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`API error: ${response.status} ${response.statusText} - ${text}`,
			);
		}

		return response.json();
	}

	private buildJsonRequestInit(
		method: "POST" | "PATCH" | "PUT" | "DELETE",
		body?: unknown,
	): RequestInit {
		return {
			method,
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		};
	}

	private async fetchJsonRequest<T>(
		path: string,
		method: "POST" | "PATCH" | "PUT" | "DELETE",
		body?: unknown,
	): Promise<T> {
		return await this.fetchJson<T>(
			path,
			this.buildJsonRequestInit(method, body),
		);
	}

	async getAutomations(): Promise<AutomationTask[]> {
		const data = await this.fetchJson<AutomationsResponse>("/api/automations");
		return data.automations ?? [];
	}

	async createAutomation(
		input: AutomationCreateInput,
	): Promise<AutomationTask> {
		const data = await this.fetchJsonRequest<{ automation: AutomationTask }>(
			"/api/automations",
			"POST",
			input,
		);
		return data.automation;
	}

	async updateAutomation(
		id: string,
		input: AutomationUpdateInput,
	): Promise<AutomationTask> {
		const data = await this.fetchJsonRequest<{ automation: AutomationTask }>(
			`/api/automations/${id}`,
			"PATCH",
			input,
		);
		return data.automation;
	}

	async deleteAutomation(id: string): Promise<void> {
		await this.fetchJson<{ success: boolean }>(`/api/automations/${id}`, {
			method: "DELETE",
		});
	}

	async runAutomation(id: string): Promise<AutomationTask> {
		const data = await this.fetchJson<{ automation: AutomationTask }>(
			`/api/automations/${id}/run`,
			{
				method: "POST",
			},
		);
		return data.automation;
	}

	async previewAutomation(
		input: AutomationPreviewInput,
	): Promise<AutomationPreviewResponse> {
		try {
			return await this.fetchJsonRequest<AutomationPreviewResponse>(
				"/api/automations/preview",
				"POST",
				input,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Preview failed";
			const match = message.match(/- (\{.*\})$/);
			let parsedMessage = message;
			if (match?.[1]) {
				try {
					const parsed = JSON.parse(match[1]) as { error?: string };
					if (parsed.error) parsedMessage = parsed.error;
				} catch {
					parsedMessage = message;
				}
			}
			return {
				nextRun: null,
				timezone: input.timezone ?? "UTC",
				timezoneValid: false,
				error: parsedMessage,
			};
		}
	}

	async getMagicDocsAutomationTemplate(): Promise<MagicDocsAutomationTemplateResponse> {
		return await this.fetchJson<MagicDocsAutomationTemplateResponse>(
			"/api/automations/magic-docs",
		);
	}

	// Models
	async getModels(): Promise<Model[]> {
		try {
			const data = await this.fetchJson<{ models: Model[] }>("/api/models");
			return data.models || [];
		} catch (error) {
			console.error("Failed to fetch models:", error);
			return [];
		}
	}

	async getCurrentModel(): Promise<Model | null> {
		try {
			return await this.fetchJson<Model>("/api/model");
		} catch {
			return null;
		}
	}

	async setModel(modelId: string): Promise<void> {
		await this.fetchJsonRequest("/api/model", "POST", { model: modelId });
	}

	// Sessions
	async getSessions(): Promise<SessionSummary[]> {
		try {
			const data = await this.fetchJson<{ sessions: SessionSummary[] }>(
				"/api/sessions",
			);
			return data.sessions || [];
		} catch (error) {
			console.error("Failed to fetch sessions:", error);
			return [];
		}
	}

	async getSession(sessionId: string): Promise<Session | null> {
		try {
			return await this.fetchJson<Session>(`/api/sessions/${sessionId}`);
		} catch {
			return null;
		}
	}

	async createSession(title?: string): Promise<Session> {
		return this.fetchJsonRequest<Session>("/api/sessions", "POST", {
			title,
		});
	}

	async deleteSession(sessionId: string): Promise<void> {
		await fetch(`${this.baseUrl}/api/sessions/${sessionId}`, {
			method: "DELETE",
			headers: {
				"x-composer-csrf": this.csrfToken,
				"x-maestro-csrf": this.csrfToken,
			},
		});
	}

	// Chat (streaming)
	async *chat(request: {
		sessionId?: string;
		messages: Message[];
		model?: string;
		thinkingLevel?: ThinkingLevel;
	}): AsyncGenerator<AgentEvent, void, unknown> {
		const response = await fetch(`${this.baseUrl}/api/chat`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-composer-slim-events": "1",
				"x-maestro-slim-events": "1",
				"x-composer-csrf": this.csrfToken,
				"x-maestro-csrf": this.csrfToken,
			},
			body: JSON.stringify({ ...request, stream: true }),
		});

		if (!response.ok) {
			throw new Error(`API error: ${response.statusText}`);
		}

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("No response body");
		}

		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				if (buffer.length > MAX_SSE_BUFFER) {
					throw new Error("SSE buffer exceeded maximum size");
				}

				// Parse SSE events
				const lines = buffer.split("\n\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.trim()) continue;

					const dataLines = line
						.split("\n")
						.filter((l) => l.startsWith("data:"));
					for (const dataLine of dataLines) {
						const data = dataLine.slice(5).trim();
						if (!data || data === "[DONE]") continue;

						try {
							const event = JSON.parse(data) as AgentEvent;
							yield event;
						} catch {
							console.warn("Failed to parse SSE data:", data);
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	// Status
	async getStatus(): Promise<WorkspaceStatus | null> {
		try {
			return await this.fetchJson<WorkspaceStatus>("/api/status");
		} catch {
			return null;
		}
	}

	async markProjectOnboardingSeen(): Promise<void> {
		await this.fetchJson<{ success: boolean }>(
			"/api/status?action=mark-onboarding-seen",
			this.buildJsonRequestInit("POST"),
		);
	}

	// Approvals
	async getApprovalMode(sessionId = "default"): Promise<ApprovalsStatus> {
		return await this.fetchJson<ApprovalsStatus>(
			`/api/approvals?sessionId=${encodeURIComponent(sessionId)}`,
		);
	}

	async setApprovalMode(
		mode: ApprovalMode,
		sessionId = "default",
	): Promise<{ success: boolean; mode: ApprovalMode }> {
		return await this.fetchJsonRequest<{
			success: boolean;
			mode: ApprovalMode;
		}>(`/api/approvals?sessionId=${encodeURIComponent(sessionId)}`, "POST", {
			mode,
			sessionId,
		});
	}

	// UI
	async getUiStatus(sessionId: string): Promise<UiStatus> {
		return await this.fetchJson<UiStatus>(
			`/api/ui?action=status&sessionId=${encodeURIComponent(sessionId)}`,
		);
	}

	async setCleanMode(
		mode: CleanMode,
		sessionId: string,
	): Promise<{ success: boolean; cleanMode: CleanMode }> {
		return await this.fetchJsonRequest<{
			success: boolean;
			cleanMode: CleanMode;
		}>(`/api/ui?sessionId=${encodeURIComponent(sessionId)}`, "POST", {
			action: "clean",
			cleanMode: mode,
		});
	}

	async setFooterMode(
		mode: FooterMode,
		sessionId: string,
	): Promise<{ success: boolean; footerMode: FooterMode }> {
		return await this.fetchJsonRequest<{
			success: boolean;
			footerMode: FooterMode;
		}>(`/api/ui?sessionId=${encodeURIComponent(sessionId)}`, "POST", {
			action: "footer",
			footerMode: mode,
		});
	}

	async setCompactTools(
		enabled: boolean,
		sessionId: string,
	): Promise<{ success: boolean; compactTools: boolean }> {
		return await this.fetchJsonRequest<{
			success: boolean;
			compactTools: boolean;
		}>(`/api/ui?sessionId=${encodeURIComponent(sessionId)}`, "POST", {
			action: "compact",
			compactTools: enabled,
		});
	}

	// Queue
	async getQueueStatus(sessionId: string): Promise<QueueStatus> {
		return await this.fetchJson<QueueStatus>(
			`/api/queue?action=status&sessionId=${encodeURIComponent(sessionId)}`,
		);
	}

	async setQueueMode(
		mode: QueueMode,
		sessionId: string,
	): Promise<{ success: boolean; mode: QueueMode }> {
		return await this.fetchJsonRequest<{ success: boolean; mode: QueueMode }>(
			"/api/queue",
			"POST",
			{ action: "mode", mode, sessionId },
		);
	}

	// Zen
	async getZenMode(sessionId: string): Promise<{ enabled: boolean }> {
		return await this.fetchJson<{ enabled: boolean }>(
			`/api/zen?sessionId=${encodeURIComponent(sessionId)}`,
		);
	}

	async setZenMode(
		sessionId: string,
		enabled: boolean,
	): Promise<{ success: boolean; enabled: boolean }> {
		return await this.fetchJsonRequest<{ success: boolean; enabled: boolean }>(
			`/api/zen?sessionId=${encodeURIComponent(sessionId)}`,
			"POST",
			{ enabled },
		);
	}

	// Framework
	async getFrameworkPreference(): Promise<FrameworkStatus> {
		return await this.fetchJson<FrameworkStatus>(
			"/api/framework?action=status",
		);
	}

	async listFrameworks(): Promise<FrameworkList> {
		return await this.fetchJson<FrameworkList>("/api/framework?action=list");
	}

	async setFramework(
		framework: string | null,
		scope: "user" | "workspace" = "user",
	): Promise<{ success: boolean; framework: string | null; scope: string }> {
		return await this.fetchJsonRequest<{
			success: boolean;
			framework: string | null;
			scope: string;
		}>("/api/framework", "POST", { framework, scope });
	}

	// Telemetry
	async getTelemetryStatus(): Promise<TelemetryStatus> {
		return await this.fetchJson<TelemetryStatus>("/api/telemetry");
	}

	async setTelemetry(
		action: "on" | "off" | "reset",
	): Promise<{ success: boolean; status: TelemetryStatus }> {
		return await this.fetchJsonRequest<{
			success: boolean;
			status: TelemetryStatus;
		}>("/api/telemetry", "POST", { action });
	}

	// Training
	async getTrainingStatus(): Promise<TrainingStatus> {
		return await this.fetchJson<TrainingStatus>("/api/training");
	}

	async setTraining(
		action: "on" | "off" | "reset",
	): Promise<{ success: boolean; status: TrainingStatus }> {
		return await this.fetchJsonRequest<{
			success: boolean;
			status: TrainingStatus;
		}>("/api/training", "POST", { action });
	}

	// Mode
	async getModeStatus(): Promise<ModeStatus> {
		return await this.fetchJson<ModeStatus>("/api/mode?action=current");
	}

	async listModes(): Promise<ModeList> {
		return await this.fetchJson<ModeList>("/api/mode?action=list");
	}

	async setMode(mode: string): Promise<ModeStatus> {
		return await this.fetchJsonRequest<ModeStatus>("/api/mode", "POST", {
			mode,
		});
	}

	// Guardian
	async getGuardianStatus(): Promise<GuardianStatus> {
		return await this.fetchJson<GuardianStatus>("/api/guardian/status");
	}

	async runGuardian(): Promise<GuardianRunResult> {
		return await this.fetchJson<GuardianRunResult>("/api/guardian/run", {
			method: "POST",
		});
	}

	async setGuardianEnabled(
		enabled: boolean,
	): Promise<{ success: boolean; enabled: boolean }> {
		return await this.fetchJsonRequest<{ success: boolean; enabled: boolean }>(
			"/api/guardian/config",
			"POST",
			{ enabled },
		);
	}

	// Plan Mode
	async getPlan(): Promise<PlanStatus> {
		return await this.fetchJson<PlanStatus>("/api/plan");
	}

	async enterPlanMode(
		name?: string,
		sessionId?: string,
	): Promise<PlanActionResponse> {
		return await this.fetchJsonRequest<PlanActionResponse>(
			"/api/plan",
			"POST",
			{ action: "enter", name, sessionId },
		);
	}

	async exitPlanMode(): Promise<PlanActionResponse> {
		return await this.fetchJsonRequest<PlanActionResponse>(
			"/api/plan",
			"POST",
			{ action: "exit" },
		);
	}

	async updatePlan(content: string): Promise<PlanActionResponse> {
		return await this.fetchJsonRequest<PlanActionResponse>(
			"/api/plan",
			"POST",
			{ action: "update", content },
		);
	}

	// Background Tasks
	async getBackgroundStatus(): Promise<BackgroundStatus> {
		return await this.fetchJson<BackgroundStatus>(
			"/api/background?action=status",
		);
	}

	async setBackgroundNotifications(
		enabled: boolean,
	): Promise<BackgroundUpdateResponse> {
		return await this.fetchJsonRequest<BackgroundUpdateResponse>(
			"/api/background?action=notify",
			"POST",
			{ enabled },
		);
	}

	async setBackgroundStatusDetails(
		enabled: boolean,
	): Promise<BackgroundUpdateResponse> {
		return await this.fetchJsonRequest<BackgroundUpdateResponse>(
			"/api/background?action=details",
			"POST",
			{ enabled },
		);
	}

	// LSP
	async getLspStatus(): Promise<LspStatus> {
		return await this.fetchJson<LspStatus>("/api/lsp?action=status");
	}

	async detectLspServers(): Promise<LspDetections> {
		return await this.fetchJson<LspDetections>("/api/lsp?action=detect");
	}

	async startLsp(): Promise<{ success: boolean; message: string }> {
		return await this.fetchJsonRequest<{ success: boolean; message: string }>(
			"/api/lsp",
			"POST",
			{ action: "start" },
		);
	}

	async stopLsp(): Promise<{ success: boolean; message: string }> {
		return await this.fetchJsonRequest<{ success: boolean; message: string }>(
			"/api/lsp",
			"POST",
			{ action: "stop" },
		);
	}

	async restartLsp(): Promise<{ success: boolean; message: string }> {
		return await this.fetchJsonRequest<{ success: boolean; message: string }>(
			"/api/lsp",
			"POST",
			{ action: "restart" },
		);
	}

	// Memory
	async listMemoryTopics(sessionId?: string): Promise<MemoryTopicsResponse> {
		const suffix = sessionId
			? `&sessionId=${encodeURIComponent(sessionId)}`
			: "";
		return await this.fetchJson<MemoryTopicsResponse>(
			`/api/memory?action=list${suffix}`,
		);
	}

	async listMemoryTopic(
		topic: string,
		sessionId?: string,
	): Promise<MemoryTopicResponse> {
		const suffix = sessionId
			? `&sessionId=${encodeURIComponent(sessionId)}`
			: "";
		return await this.fetchJson<MemoryTopicResponse>(
			`/api/memory?action=list&topic=${encodeURIComponent(topic)}${suffix}`,
		);
	}

	async searchMemory(
		query: string,
		limit = 10,
		sessionId?: string,
	): Promise<MemorySearchResponse> {
		const suffix = sessionId
			? `&sessionId=${encodeURIComponent(sessionId)}`
			: "";
		return await this.fetchJson<MemorySearchResponse>(
			`/api/memory?action=search&query=${encodeURIComponent(query)}&limit=${limit}${suffix}`,
		);
	}

	async getRecentMemories(
		limit = 10,
		sessionId?: string,
	): Promise<MemoryRecentResponse> {
		const suffix = sessionId
			? `&sessionId=${encodeURIComponent(sessionId)}`
			: "";
		return await this.fetchJson<MemoryRecentResponse>(
			`/api/memory?action=recent&limit=${limit}${suffix}`,
		);
	}

	async getMemoryStats(sessionId?: string): Promise<MemoryStatsResponse> {
		const suffix = sessionId
			? `&sessionId=${encodeURIComponent(sessionId)}`
			: "";
		return await this.fetchJson<MemoryStatsResponse>(
			`/api/memory?action=stats${suffix}`,
		);
	}

	async saveMemory(
		topic: string,
		content: string,
		tags?: string[],
		sessionId?: string,
	): Promise<MemoryMutationResponse> {
		return await this.fetchJsonRequest<MemoryMutationResponse>(
			"/api/memory",
			"POST",
			{
				action: "save",
				topic,
				content,
				tags,
				sessionId,
			},
		);
	}

	async deleteMemory(
		id?: string,
		topic?: string,
	): Promise<MemoryMutationResponse> {
		return await this.fetchJsonRequest<MemoryMutationResponse>(
			"/api/memory",
			"POST",
			{
				action: "delete",
				id,
				topic,
			},
		);
	}

	async exportMemory(path?: string): Promise<MemoryMutationResponse> {
		return await this.fetchJsonRequest<MemoryMutationResponse>(
			"/api/memory",
			"POST",
			{
				action: "export",
				path,
			},
		);
	}

	async importMemory(path: string): Promise<MemoryMutationResponse> {
		return await this.fetchJsonRequest<MemoryMutationResponse>(
			"/api/memory",
			"POST",
			{
				action: "import",
				path,
			},
		);
	}

	async clearMemory(force = false): Promise<MemoryMutationResponse> {
		return await this.fetchJsonRequest<MemoryMutationResponse>(
			"/api/memory",
			"POST",
			{
				action: "clear",
				force,
			},
		);
	}

	// Packages
	async getPackageStatus(): Promise<PackageStatusResponse> {
		return await this.fetchJson<PackageStatusResponse>("/api/package");
	}

	async inspectPackage(source: string): Promise<PackageInspectResponse> {
		return await this.fetchJsonRequest<PackageInspectResponse>(
			"/api/package?action=inspect",
			"POST",
			{ source },
		);
	}

	async refreshPackage(source: string): Promise<PackageInspectResponse> {
		return await this.fetchJsonRequest<PackageInspectResponse>(
			"/api/package?action=refresh",
			"POST",
			{ source },
		);
	}

	async refreshAllPackages(): Promise<PackageBulkRefreshResponse> {
		return await this.fetchJsonRequest<PackageBulkRefreshResponse>(
			"/api/package?action=refresh-all",
			"POST",
			{},
		);
	}

	async prunePackageCache(): Promise<PackageCachePruneResponse> {
		return await this.fetchJsonRequest<PackageCachePruneResponse>(
			"/api/package?action=prune-cache",
			"POST",
			{},
		);
	}

	async validatePackage(source: string): Promise<PackageInspectResponse> {
		return await this.fetchJsonRequest<PackageInspectResponse>(
			"/api/package?action=validate",
			"POST",
			{ source },
		);
	}

	async addPackage(input: PackageMutationRequest): Promise<PackageAddResponse> {
		return await this.fetchJsonRequest<PackageAddResponse>(
			"/api/package?action=add",
			"POST",
			input,
		);
	}

	async removePackage(
		input: PackageMutationRequest,
	): Promise<PackageRemoveResponse> {
		return await this.fetchJsonRequest<PackageRemoveResponse>(
			"/api/package?action=remove",
			"POST",
			input,
		);
	}

	// MCP
	async getMcpStatus(): Promise<McpStatus> {
		return await this.fetchJson<McpStatus>("/api/mcp");
	}

	async searchMcpRegistry(query = ""): Promise<McpRegistrySearchResponse> {
		const params = new URLSearchParams({ action: "search-registry" });
		const trimmedQuery = query.trim();
		if (trimmedQuery.length > 0) {
			params.set("query", trimmedQuery);
		}
		return await this.fetchJson<McpRegistrySearchResponse>(
			`/api/mcp?${params.toString()}`,
		);
	}

	async importMcpRegistry(
		input: McpRegistryImportRequest,
	): Promise<McpRegistryImportResponse> {
		return await this.fetchJsonRequest<McpRegistryImportResponse>(
			"/api/mcp?action=import-registry",
			"POST",
			input,
		);
	}

	async addMcpServer(
		input: McpServerAddRequest,
	): Promise<McpServerMutationResponse> {
		return await this.fetchJsonRequest<McpServerMutationResponse>(
			"/api/mcp?action=add-server",
			"POST",
			input,
		);
	}

	async updateMcpServer(
		input: McpServerUpdateRequest,
	): Promise<McpServerMutationResponse> {
		return await this.fetchJsonRequest<McpServerMutationResponse>(
			"/api/mcp?action=update-server",
			"POST",
			input,
		);
	}

	async removeMcpServer(
		input: McpServerRemoveRequest,
	): Promise<McpServerRemoveResponse> {
		return await this.fetchJsonRequest<McpServerRemoveResponse>(
			"/api/mcp?action=remove-server",
			"POST",
			input,
		);
	}

	async setMcpProjectApproval(
		input: McpProjectApprovalRequest,
	): Promise<McpProjectApprovalResponse> {
		return await this.fetchJsonRequest<McpProjectApprovalResponse>(
			"/api/mcp?action=set-project-approval",
			"POST",
			input,
		);
	}

	async addMcpAuthPreset(
		input: McpAuthPresetAddRequest,
	): Promise<McpAuthPresetMutationResponse> {
		return await this.fetchJsonRequest<McpAuthPresetMutationResponse>(
			"/api/mcp?action=add-auth-preset",
			"POST",
			input,
		);
	}

	async updateMcpAuthPreset(
		input: McpAuthPresetUpdateRequest,
	): Promise<McpAuthPresetMutationResponse> {
		return await this.fetchJsonRequest<McpAuthPresetMutationResponse>(
			"/api/mcp?action=update-auth-preset",
			"POST",
			input,
		);
	}

	async removeMcpAuthPreset(
		input: McpAuthPresetRemoveRequest,
	): Promise<McpAuthPresetRemoveResponse> {
		return await this.fetchJsonRequest<McpAuthPresetRemoveResponse>(
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
		return await this.fetchJson<McpResourceReadResponse>(
			`/api/mcp?${params.toString()}`,
		);
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
		return await this.fetchJson<McpPromptResponse>(
			`/api/mcp?${params.toString()}`,
		);
	}

	// Composers
	async getComposers(): Promise<ComposerStatus> {
		return await this.fetchJson<ComposerStatus>("/api/composer");
	}

	async activateComposer(
		name: string,
	): Promise<{ success: boolean; active?: ComposerProfile }> {
		return await this.fetchJsonRequest<{
			success: boolean;
			active?: ComposerProfile;
		}>("/api/composer", "POST", { action: "activate", name });
	}

	async deactivateComposer(): Promise<{ success: boolean; message?: string }> {
		return await this.fetchJsonRequest<{ success: boolean; message?: string }>(
			"/api/composer",
			"POST",
			{ action: "deactivate" },
		);
	}
}

// Default client instance
export const apiClient = new ApiClient();
