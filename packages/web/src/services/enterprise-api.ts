/**
 * Enterprise API Client
 * Extends base API client with RBAC, audit, users, and org management
 */

export interface User {
	id: string;
	email: string;
	name: string;
	isActive: boolean;
	lastLoginAt?: string;
}

export interface Organization {
	id: string;
	name: string;
	slug: string;
	settings?: OrganizationSettings;
}

export interface OrganizationSettings {
	maxTokensPerUser?: number;
	maxSessionsPerUser?: number;
	maxApiKeysPerUser?: number;
	allowedDirectories?: string[];
	deniedDirectories?: string[];
	piiRedactionEnabled?: boolean;
	piiPatterns?: string[];
	auditRetentionDays?: number;
	alertWebhooks?: string[];
}

export interface Role {
	id: string;
	name: string;
	description?: string;
	isSystem: boolean;
}

export interface OrgMember {
	id: string;
	userId: string;
	user: User;
	roleId: string;
	role: Role;
	tokenQuota?: number;
	tokenUsed: number;
	joinedAt: string;
}

export interface UsageQuota {
	userId: string;
	orgId: string;
	tokenQuota: number | null;
	tokenUsed: number;
	tokenRemaining: number;
	spendLimit: number | null;
	spendUsed: number;
	spendRemaining: number;
	quotaResetAt: string | null;
}

export interface OrgUsageSummary {
	totalTokens: number;
	totalSessions: number;
	totalUsers: number;
	topUsers: Array<{ userId: string; tokenUsed: number }>;
	modelBreakdown: Array<{ modelId: string; tokenUsed: number }>;
}

export interface AuditLog {
	id: string;
	orgId: string;
	userId: string;
	sessionId?: string;
	action: string;
	resourceType?: string;
	resourceId?: string;
	status: "success" | "failure" | "error" | "denied";
	ipAddress?: string;
	userAgent?: string;
	requestId?: string;
	traceId?: string;
	metadata?: Record<string, unknown>;
	durationMs?: number;
	createdAt: string;
}

export interface Alert {
	id: string;
	orgId: string;
	userId?: string;
	severity: "critical" | "high" | "medium" | "low" | "info";
	type: string;
	message: string;
	metadata?: Record<string, unknown>;
	isRead: boolean;
	resolvedAt?: string;
	createdAt: string;
}

export interface ModelApproval {
	id: string;
	orgId: string;
	modelId: string;
	provider: string;
	status: "approved" | "pending" | "denied" | "auto_approved";
	spendLimit?: number;
	spendUsed: number;
	tokenLimit?: number;
	tokenUsed: number;
	restrictedToRoles?: string[];
	metadata?: {
		reason?: string;
		contextWindowLimit?: number;
		allowedTools?: string[];
		deniedTools?: string[];
	};
	approvedBy?: string;
	approvedAt?: string;
}

export interface DirectoryRule {
	id: string;
	orgId: string;
	pattern: string;
	isAllowed: boolean;
	roleIds?: string[];
	description?: string;
	priority: number;
}

export interface AuthResponse {
	user: User;
	organization: Organization;
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
}

async function safeJson(response: Response) {
	const contentType = response.headers.get("content-type") || "";
	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(
			`API error: ${response.status} ${response.statusText} - ${errorBody}`,
		);
	}
	if (!contentType.includes("application/json")) {
		const text = await response.text();
		throw new Error(
			`Expected JSON but received ${contentType || "unknown"}; ${text.slice(0, 120)}`,
		);
	}
	return response.json();
}

type TokenKey = "access" | "refresh" | "apiKey" | "csrf";

class EphemeralTokenStorage {
	private memoryStore = new Map<TokenKey, string>();
	private readonly keys: Record<TokenKey, string> = {
		access: "composer_access_token",
		refresh: "composer_refresh_token",
		apiKey: "composer_api_key",
		csrf: "composer_csrf_token",
	};

	private get browserStorage(): Storage | null {
		if (typeof window === "undefined") {
			return null;
		}
		try {
			return window.sessionStorage;
		} catch (error) {
			globalThis.console?.warn?.(
				"Session storage unavailable, falling back to in-memory token store",
				error,
			);
			return null;
		}
	}

	get(key: TokenKey): string | null {
		const storage = this.browserStorage;
		if (storage) {
			try {
				return storage.getItem(this.keys[key]);
			} catch {
				// ignore and fall back to memory
			}
		}
		return this.memoryStore.get(key) ?? null;
	}

	set(key: TokenKey, value: string): void {
		const storage = this.browserStorage;
		if (storage) {
			try {
				storage.setItem(this.keys[key], value);
				return;
			} catch {
				// ignore and fall back to memory
			}
		}
		this.memoryStore.set(key, value);
	}

	remove(key: TokenKey): void {
		const storage = this.browserStorage;
		if (storage) {
			try {
				storage.removeItem(this.keys[key]);
			} catch {
				// ignore
			}
		}
		this.memoryStore.delete(key);
	}

	clear(): void {
		this.remove("access");
		this.remove("refresh");
	}
}

const tokenStorage = new EphemeralTokenStorage();

export function getStoredComposerAccessToken(): string | null {
	return tokenStorage.get("access");
}

export function getStoredComposerApiKey(): string | null {
	return tokenStorage.get("apiKey");
}

export function getStoredComposerCsrfToken(): string | null {
	return tokenStorage.get("csrf");
}

export class EnterpriseApiClient {
	private baseUrl: string;
	private accessToken: string | null = null;

	constructor(baseUrl?: string) {
		this.baseUrl = (baseUrl || "http://localhost:8080").replace(/\/$/, "");
		this.accessToken = tokenStorage.get("access");
	}

	private get headers(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.accessToken) {
			headers.Authorization = `Bearer ${this.accessToken}`;
		}
		return headers;
	}

	// =========================================================================
	// AUTHENTICATION
	// =========================================================================

	async register(data: {
		email: string;
		name: string;
		password: string;
		orgName?: string;
	}): Promise<AuthResponse> {
		const response = await fetch(`${this.baseUrl}/api/auth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		const result = (await safeJson(response)) as AuthResponse;
		this.setTokens(result.accessToken, result.refreshToken);
		return result;
	}

	async login(email: string, password: string): Promise<AuthResponse> {
		const response = await fetch(`${this.baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password }),
		});
		const result = (await safeJson(response)) as AuthResponse;
		this.setTokens(result.accessToken, result.refreshToken);
		return result;
	}

	async getMe(): Promise<User & { organization: Organization | null }> {
		const response = await fetch(`${this.baseUrl}/api/auth/me`, {
			headers: this.headers,
		});
		return safeJson(response);
	}

	logout(): void {
		this.accessToken = null;
		tokenStorage.clear();
	}

	isAuthenticated(): boolean {
		return !!this.accessToken;
	}

	private setTokens(accessToken: string, refreshToken: string): void {
		this.accessToken = accessToken;
		tokenStorage.set("access", accessToken);
		tokenStorage.set("refresh", refreshToken);
	}

	// =========================================================================
	// USAGE & QUOTAS
	// =========================================================================

	async getUsageQuota(): Promise<UsageQuota> {
		const response = await fetch(`${this.baseUrl}/api/usage/quota`, {
			headers: this.headers,
		});
		return safeJson(response);
	}

	async getOrgUsage(): Promise<OrgUsageSummary> {
		const response = await fetch(`${this.baseUrl}/api/usage/org`, {
			headers: this.headers,
		});
		return safeJson(response);
	}

	// =========================================================================
	// AUDIT LOGS
	// =========================================================================

	async getAuditLogs(filters?: {
		userId?: string;
		sessionId?: string;
		action?: string;
		startDate?: string;
		endDate?: string;
		limit?: number;
	}): Promise<{ logs: AuditLog[] }> {
		const params = new URLSearchParams();
		if (filters) {
			for (const [k, v] of Object.entries(filters)) {
				if (v !== undefined) params.set(k, String(v));
			}
		}
		const response = await fetch(
			`${this.baseUrl}/api/audit/logs?${params.toString()}`,
			{ headers: this.headers },
		);
		return safeJson(response);
	}

	async exportAuditLogs(format: "csv" | "json" = "csv"): Promise<string> {
		const response = await fetch(
			`${this.baseUrl}/api/audit/export?format=${format}`,
			{ headers: this.headers },
		);
		if (!response.ok) {
			throw new Error(`Export failed: ${response.statusText}`);
		}
		return response.text();
	}

	// =========================================================================
	// ALERTS
	// =========================================================================

	async getAlerts(): Promise<{ alerts: Alert[] }> {
		const response = await fetch(`${this.baseUrl}/api/alerts`, {
			headers: this.headers,
		});
		return safeJson(response);
	}

	async markAlertRead(alertId: string): Promise<void> {
		await fetch(`${this.baseUrl}/api/alerts/${alertId}/read`, {
			method: "POST",
			headers: this.headers,
		});
	}

	async resolveAlert(alertId: string): Promise<void> {
		await fetch(`${this.baseUrl}/api/alerts/${alertId}/resolve`, {
			method: "POST",
			headers: this.headers,
		});
	}

	// =========================================================================
	// ORGANIZATION MANAGEMENT
	// =========================================================================

	async getOrgMembers(): Promise<{ members: OrgMember[] }> {
		const response = await fetch(`${this.baseUrl}/api/org/members`, {
			headers: this.headers,
		});
		return safeJson(response);
	}

	async inviteUser(email: string, roleId: string): Promise<void> {
		await fetch(`${this.baseUrl}/api/org/members/invite`, {
			method: "POST",
			headers: this.headers,
			body: JSON.stringify({ email, roleId }),
		});
	}

	async updateMemberRole(userId: string, roleId: string): Promise<void> {
		await fetch(`${this.baseUrl}/api/org/members/${userId}/role`, {
			method: "PUT",
			headers: this.headers,
			body: JSON.stringify({ roleId }),
		});
	}

	async updateMemberQuota(userId: string, tokenQuota: number): Promise<void> {
		await fetch(`${this.baseUrl}/api/org/members/${userId}/quota`, {
			method: "PUT",
			headers: this.headers,
			body: JSON.stringify({ tokenQuota }),
		});
	}

	async removeMember(userId: string): Promise<void> {
		await fetch(`${this.baseUrl}/api/org/members/${userId}`, {
			method: "DELETE",
			headers: this.headers,
		});
	}

	async getOrgSettings(): Promise<OrganizationSettings> {
		const response = await fetch(`${this.baseUrl}/api/org/settings`, {
			headers: this.headers,
		});
		return safeJson(response);
	}

	async updateOrgSettings(
		settings: Partial<OrganizationSettings>,
	): Promise<void> {
		await fetch(`${this.baseUrl}/api/org/settings`, {
			method: "PUT",
			headers: this.headers,
			body: JSON.stringify(settings),
		});
	}

	// =========================================================================
	// ROLES
	// =========================================================================

	async getRoles(): Promise<{ roles: Role[] }> {
		const response = await fetch(`${this.baseUrl}/api/roles`, {
			headers: this.headers,
		});
		return safeJson(response);
	}

	// =========================================================================
	// MODEL APPROVALS
	// =========================================================================

	async getModelApprovals(): Promise<{ approvals: ModelApproval[] }> {
		const response = await fetch(`${this.baseUrl}/api/models/approvals`, {
			headers: this.headers,
		});
		return safeJson(response);
	}

	async approveModel(
		modelId: string,
		options?: {
			spendLimit?: number;
			tokenLimit?: number;
			restrictedToRoles?: string[];
		},
	): Promise<void> {
		await fetch(`${this.baseUrl}/api/models/approvals/${modelId}/approve`, {
			method: "POST",
			headers: this.headers,
			body: JSON.stringify(options || {}),
		});
	}

	async denyModel(modelId: string, reason?: string): Promise<void> {
		await fetch(`${this.baseUrl}/api/models/approvals/${modelId}/deny`, {
			method: "POST",
			headers: this.headers,
			body: JSON.stringify({ reason }),
		});
	}

	// =========================================================================
	// DIRECTORY ACCESS RULES
	// =========================================================================

	async getDirectoryRules(): Promise<{ rules: DirectoryRule[] }> {
		const response = await fetch(`${this.baseUrl}/api/directory-rules`, {
			headers: this.headers,
		});
		return safeJson(response);
	}

	async createDirectoryRule(rule: {
		pattern: string;
		isAllowed: boolean;
		roleIds?: string[];
		description?: string;
		priority?: number;
	}): Promise<DirectoryRule> {
		const response = await fetch(`${this.baseUrl}/api/directory-rules`, {
			method: "POST",
			headers: this.headers,
			body: JSON.stringify(rule),
		});
		return safeJson(response);
	}

	async deleteDirectoryRule(ruleId: string): Promise<void> {
		await fetch(`${this.baseUrl}/api/directory-rules/${ruleId}`, {
			method: "DELETE",
			headers: this.headers,
		});
	}

	// =========================================================================
	// SLACK INTEGRATION
	// =========================================================================

	async getSlackInstallUrl(): Promise<{ url: string }> {
		const response = await fetch(`${this.baseUrl}/api/slack/install`, {
			headers: this.headers,
		});
		return safeJson(response);
	}

	async listSlackWorkspaces(): Promise<{ workspaces: SlackWorkspace[] }> {
		const response = await fetch(`${this.baseUrl}/api/slack/workspaces`, {
			headers: this.headers,
		});
		return safeJson(response);
	}

	async getSlackWorkspace(id: string): Promise<{
		workspace: SlackWorkspaceDetails;
		runtime: WorkspaceRuntime;
		quota: SlackQuotaStatus;
	}> {
		const response = await fetch(`${this.baseUrl}/api/slack/workspaces/${id}`, {
			headers: this.headers,
		});
		return safeJson(response);
	}

	async updateSlackWorkspaceConfig(
		id: string,
		config: Record<string, unknown>,
	): Promise<void> {
		await fetch(`${this.baseUrl}/api/slack/workspaces/${id}/config`, {
			method: "PUT",
			headers: this.headers,
			body: JSON.stringify(config),
		});
	}

	async suspendSlackWorkspace(id: string, reason: string): Promise<void> {
		await fetch(`${this.baseUrl}/api/slack/workspaces/${id}/suspend`, {
			method: "POST",
			headers: this.headers,
			body: JSON.stringify({ reason }),
		});
	}

	async reactivateSlackWorkspace(id: string): Promise<void> {
		await fetch(`${this.baseUrl}/api/slack/workspaces/${id}/reactivate`, {
			method: "POST",
			headers: this.headers,
		});
	}

	async setSlackWorkspaceQuota(
		id: string,
		quota: number | null,
	): Promise<void> {
		await fetch(`${this.baseUrl}/api/slack/workspaces/${id}/quota`, {
			method: "PUT",
			headers: this.headers,
			body: JSON.stringify({ quota }),
		});
	}

	async listSlackWorkspaceUsers(
		workspaceId: string,
	): Promise<{ users: SlackUser[] }> {
		const response = await fetch(
			`${this.baseUrl}/api/slack/workspaces/${workspaceId}/users`,
			{ headers: this.headers },
		);
		return safeJson(response);
	}

	async setSlackUserRole(
		workspaceId: string,
		slackUserId: string,
		role: string,
	): Promise<void> {
		await fetch(
			`${this.baseUrl}/api/slack/workspaces/${workspaceId}/users/${slackUserId}/role`,
			{
				method: "PUT",
				headers: this.headers,
				body: JSON.stringify({ role }),
			},
		);
	}

	async blockSlackUser(
		workspaceId: string,
		slackUserId: string,
		reason: string,
	): Promise<void> {
		await fetch(
			`${this.baseUrl}/api/slack/workspaces/${workspaceId}/users/${slackUserId}/block`,
			{
				method: "POST",
				headers: this.headers,
				body: JSON.stringify({ reason }),
			},
		);
	}

	async unblockSlackUser(
		workspaceId: string,
		slackUserId: string,
	): Promise<void> {
		await fetch(
			`${this.baseUrl}/api/slack/workspaces/${workspaceId}/users/${slackUserId}/unblock`,
			{
				method: "POST",
				headers: this.headers,
			},
		);
	}

	async getSlackWorkspaceUsage(
		workspaceId: string,
	): Promise<SlackUsageSummary> {
		const response = await fetch(
			`${this.baseUrl}/api/slack/workspaces/${workspaceId}/usage`,
			{ headers: this.headers },
		);
		return safeJson(response);
	}

	async getSlackWorkspaceAuditLogs(
		workspaceId: string,
		options?: {
			startDate?: string;
			endDate?: string;
			limit?: number;
		},
	): Promise<{ logs: SlackAuditLogEntry[] }> {
		const params = new URLSearchParams();
		if (options?.startDate) params.set("startDate", options.startDate);
		if (options?.endDate) params.set("endDate", options.endDate);
		if (options?.limit) params.set("limit", String(options.limit));
		const query = params.toString();
		const response = await fetch(
			`${this.baseUrl}/api/slack/workspaces/${workspaceId}/audit${query ? `?${query}` : ""}`,
			{ headers: this.headers },
		);
		return safeJson(response);
	}

	async verifySlackAuditIntegrity(workspaceId: string): Promise<{
		valid: boolean;
		totalRecords: number;
		invalidRecords: string[];
	}> {
		const response = await fetch(
			`${this.baseUrl}/api/slack/workspaces/${workspaceId}/audit/verify`,
			{
				method: "POST",
				headers: this.headers,
			},
		);
		return safeJson(response);
	}
}

// ============================================================================
// SLACK TYPES
// ============================================================================

export interface SlackWorkspace {
	id: string;
	slackTeamId: string;
	slackTeamName: string;
	status: "active" | "suspended" | "uninstalled";
	tokenQuotaMonthly: number | null;
	tokenUsedMonthly: number;
	installedAt: string;
	createdAt: string;
}

export interface SlackWorkspaceDetails extends SlackWorkspace {
	config?: Record<string, unknown>;
	installedBy?: string;
}

export interface WorkspaceRuntime {
	workspaceId: string;
	activeRuns: number;
	maxConcurrentRuns: number;
	requestsLastMinute: number;
	rateLimitRemaining: number;
}

export interface SlackQuotaStatus {
	quotaUsed: number;
	quotaLimit: number | null;
	isOverQuota: boolean;
	percentUsed: number;
}

export interface SlackUser {
	id: string;
	workspaceId: string;
	slackUserId: string;
	slackUserName: string;
	displayName?: string;
	role: "admin" | "power_user" | "user" | "viewer";
	isBlocked: boolean;
	lastActiveAt?: string;
	createdAt: string;
}

export interface SlackUsageSummary {
	workspaceId: string;
	periodStart: string;
	periodEnd: string;
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	totalCost: number;
	totalRuns: number;
	modelBreakdown: Array<{ model: string; tokens: number; cost: number }>;
	dailyUsage: Array<{ date: string; tokens: number }>;
}

export interface SlackAuditLogEntry {
	id: string;
	workspaceId: string;
	slackUserId: string;
	slackUserName?: string;
	action: string;
	resourceType?: string;
	resourceId?: string;
	status: "success" | "failure" | "error" | "denied";
	metadata?: Record<string, unknown>;
	ipAddress?: string;
	timestamp: string;
}

// Singleton instance
let enterpriseApiInstance: EnterpriseApiClient | null = null;

export function getEnterpriseApi(): EnterpriseApiClient {
	if (!enterpriseApiInstance) {
		enterpriseApiInstance = new EnterpriseApiClient();
	}
	return enterpriseApiInstance;
}
