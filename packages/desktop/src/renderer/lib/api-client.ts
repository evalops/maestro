/**
 * API Client for Composer Backend
 *
 * Handles communication with the embedded Composer server.
 */

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
	import.meta.env.VITE_COMPOSER_BASE_URL ?? "http://localhost:8080";
const DEFAULT_CSRF_TOKEN =
	import.meta.env.VITE_COMPOSER_CSRF_TOKEN ?? "composer-desktop-csrf";
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
	runtimeOverride?: "enabled" | "disabled";
}

export interface TrainingStatus {
	preference: "opted-in" | "opted-out" | "provider-default";
	optOut: boolean | null;
	runtimeOverride?: "opted-in" | "opted-out";
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

export interface McpServerStatus {
	name: string;
	connected: boolean;
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
	error?: string;
}

export interface McpStatus {
	servers: McpServerStatus[];
}

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
				...(needsCsrf ? { "x-composer-csrf": this.csrfToken } : {}),
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

	async getAutomations(): Promise<AutomationTask[]> {
		const data = await this.fetchJson<AutomationsResponse>("/api/automations");
		return data.automations ?? [];
	}

	async createAutomation(
		input: AutomationCreateInput,
	): Promise<AutomationTask> {
		const data = await this.fetchJson<{ automation: AutomationTask }>(
			"/api/automations",
			{
				method: "POST",
				body: JSON.stringify(input),
			},
		);
		return data.automation;
	}

	async updateAutomation(
		id: string,
		input: AutomationUpdateInput,
	): Promise<AutomationTask> {
		const data = await this.fetchJson<{ automation: AutomationTask }>(
			`/api/automations/${id}`,
			{
				method: "PATCH",
				body: JSON.stringify(input),
			},
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
			return await this.fetchJson<AutomationPreviewResponse>(
				"/api/automations/preview",
				{
					method: "POST",
					body: JSON.stringify(input),
				},
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
		await this.fetchJson("/api/model", {
			method: "POST",
			body: JSON.stringify({ model: modelId }),
		});
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
		return this.fetchJson<Session>("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ title }),
		});
	}

	async deleteSession(sessionId: string): Promise<void> {
		await fetch(`${this.baseUrl}/api/sessions/${sessionId}`, {
			method: "DELETE",
			headers: { "x-composer-csrf": this.csrfToken },
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
				"x-composer-csrf": this.csrfToken,
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
		return await this.fetchJson<{ success: boolean; mode: ApprovalMode }>(
			`/api/approvals?sessionId=${encodeURIComponent(sessionId)}`,
			{
				method: "POST",
				body: JSON.stringify({ mode, sessionId }),
			},
		);
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
		return await this.fetchJson<{ success: boolean; cleanMode: CleanMode }>(
			`/api/ui?sessionId=${encodeURIComponent(sessionId)}`,
			{
				method: "POST",
				body: JSON.stringify({ action: "clean", cleanMode: mode }),
			},
		);
	}

	async setFooterMode(
		mode: FooterMode,
		sessionId: string,
	): Promise<{ success: boolean; footerMode: FooterMode }> {
		return await this.fetchJson<{ success: boolean; footerMode: FooterMode }>(
			`/api/ui?sessionId=${encodeURIComponent(sessionId)}`,
			{
				method: "POST",
				body: JSON.stringify({ action: "footer", footerMode: mode }),
			},
		);
	}

	async setCompactTools(
		enabled: boolean,
		sessionId: string,
	): Promise<{ success: boolean; compactTools: boolean }> {
		return await this.fetchJson<{ success: boolean; compactTools: boolean }>(
			`/api/ui?sessionId=${encodeURIComponent(sessionId)}`,
			{
				method: "POST",
				body: JSON.stringify({ action: "compact", compactTools: enabled }),
			},
		);
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
		return await this.fetchJson<{ success: boolean; mode: QueueMode }>(
			"/api/queue",
			{
				method: "POST",
				body: JSON.stringify({ action: "mode", mode, sessionId }),
			},
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
		return await this.fetchJson<{ success: boolean; enabled: boolean }>(
			`/api/zen?sessionId=${encodeURIComponent(sessionId)}`,
			{
				method: "POST",
				body: JSON.stringify({ enabled }),
			},
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
		return await this.fetchJson<{
			success: boolean;
			framework: string | null;
			scope: string;
		}>("/api/framework", {
			method: "POST",
			body: JSON.stringify({ framework, scope }),
		});
	}

	// Telemetry
	async getTelemetryStatus(): Promise<TelemetryStatus> {
		return await this.fetchJson<TelemetryStatus>("/api/telemetry");
	}

	async setTelemetry(
		action: "on" | "off" | "reset",
	): Promise<{ success: boolean; status: TelemetryStatus }> {
		return await this.fetchJson<{ success: boolean; status: TelemetryStatus }>(
			"/api/telemetry",
			{
				method: "POST",
				body: JSON.stringify({ action }),
			},
		);
	}

	// Training
	async getTrainingStatus(): Promise<TrainingStatus> {
		return await this.fetchJson<TrainingStatus>("/api/training");
	}

	async setTraining(
		action: "on" | "off" | "reset",
	): Promise<{ success: boolean; status: TrainingStatus }> {
		return await this.fetchJson<{ success: boolean; status: TrainingStatus }>(
			"/api/training",
			{
				method: "POST",
				body: JSON.stringify({ action }),
			},
		);
	}

	// Mode
	async getModeStatus(): Promise<ModeStatus> {
		return await this.fetchJson<ModeStatus>("/api/mode?action=current");
	}

	async listModes(): Promise<ModeList> {
		return await this.fetchJson<ModeList>("/api/mode?action=list");
	}

	async setMode(mode: string): Promise<ModeStatus> {
		return await this.fetchJson<ModeStatus>("/api/mode", {
			method: "POST",
			body: JSON.stringify({ mode }),
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
		return await this.fetchJson<{ success: boolean; enabled: boolean }>(
			"/api/guardian/config",
			{
				method: "POST",
				body: JSON.stringify({ enabled }),
			},
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
		return await this.fetchJson<PlanActionResponse>("/api/plan", {
			method: "POST",
			body: JSON.stringify({ action: "enter", name, sessionId }),
		});
	}

	async exitPlanMode(): Promise<PlanActionResponse> {
		return await this.fetchJson<PlanActionResponse>("/api/plan", {
			method: "POST",
			body: JSON.stringify({ action: "exit" }),
		});
	}

	async updatePlan(content: string): Promise<PlanActionResponse> {
		return await this.fetchJson<PlanActionResponse>("/api/plan", {
			method: "POST",
			body: JSON.stringify({ action: "update", content }),
		});
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
		return await this.fetchJson<BackgroundUpdateResponse>(
			"/api/background?action=notify",
			{
				method: "POST",
				body: JSON.stringify({ enabled }),
			},
		);
	}

	async setBackgroundStatusDetails(
		enabled: boolean,
	): Promise<BackgroundUpdateResponse> {
		return await this.fetchJson<BackgroundUpdateResponse>(
			"/api/background?action=details",
			{
				method: "POST",
				body: JSON.stringify({ enabled }),
			},
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
		return await this.fetchJson<{ success: boolean; message: string }>(
			"/api/lsp",
			{
				method: "POST",
				body: JSON.stringify({ action: "start" }),
			},
		);
	}

	async stopLsp(): Promise<{ success: boolean; message: string }> {
		return await this.fetchJson<{ success: boolean; message: string }>(
			"/api/lsp",
			{
				method: "POST",
				body: JSON.stringify({ action: "stop" }),
			},
		);
	}

	async restartLsp(): Promise<{ success: boolean; message: string }> {
		return await this.fetchJson<{ success: boolean; message: string }>(
			"/api/lsp",
			{
				method: "POST",
				body: JSON.stringify({ action: "restart" }),
			},
		);
	}

	// MCP
	async getMcpStatus(): Promise<McpStatus> {
		return await this.fetchJson<McpStatus>("/api/mcp");
	}

	// Composers
	async getComposers(): Promise<ComposerStatus> {
		return await this.fetchJson<ComposerStatus>("/api/composer");
	}

	async activateComposer(
		name: string,
	): Promise<{ success: boolean; active?: ComposerProfile }> {
		return await this.fetchJson<{ success: boolean; active?: ComposerProfile }>(
			"/api/composer",
			{
				method: "POST",
				body: JSON.stringify({ action: "activate", name }),
			},
		);
	}

	async deactivateComposer(): Promise<{ success: boolean; message?: string }> {
		return await this.fetchJson<{ success: boolean; message?: string }>(
			"/api/composer",
			{
				method: "POST",
				body: JSON.stringify({ action: "deactivate" }),
			},
		);
	}
}

// Default client instance
export const apiClient = new ApiClient();
