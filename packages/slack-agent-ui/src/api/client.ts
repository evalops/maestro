const BASE = "/api";

const TOKEN_STORAGE_KEY = "slack_agent_ui_token";

function getAuthToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_STORAGE_KEY);
	} catch {
		return null;
	}
}

export function setAuthToken(token: string): void {
	try {
		if (!token) localStorage.removeItem(TOKEN_STORAGE_KEY);
		else localStorage.setItem(TOKEN_STORAGE_KEY, token);
	} catch {
		// ignore
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const headers = new Headers(init?.headers);
	headers.set("Content-Type", "application/json");
	const token = getAuthToken();
	if (token) headers.set("Authorization", `Bearer ${token}`);

	const res = await fetch(`${BASE}${path}`, {
		credentials: "include",
		headers,
		...init,
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`${res.status}: ${text || res.statusText}`);
	}
	return res.json() as Promise<T>;
}

export interface LiveDashboardDefinition {
	prompt: string;
	title?: string;
	subtitle?: string;
	theme?: "dark" | "light";
	refreshIntervalMs?: number;
	createdBy?: string;
}

export interface DashboardEntry {
	id: string;
	label: string;
	createdBy?: string;
	visibility?: "private" | "shared";
	sharedAt?: string;
	sharedBy?: string;
	createdAt: string;
	updatedAt?: string;
	expiresAt?: string;
	lastRenderedAt?: string;
	lastError?: string;
	spec?: import("../types/dashboard").DashboardSpec;
	definition?: LiveDashboardDefinition;
	// Legacy deployment fields (optional)
	url?: string;
	directory?: string;
	port?: number;
}

export interface DashboardRenderResponse {
	ok: boolean;
	spec: import("../types/dashboard").DashboardSpec;
	renderedAt: string;
	fromCache: boolean;
}

export interface ConnectorInfo {
	name: string;
	type: string;
	enabled: boolean;
	hasCredentials: boolean;
	status: "ready" | "needs_credentials" | "disabled" | "error";
	capabilities?: number;
}

export interface TriggerInfo {
	id: string;
	source: string;
	channel: string;
	prompt: string;
	enabled: boolean;
	filter?: Record<string, unknown>;
}

export interface SlackConfig {
	oauthEnabled: boolean;
	installPath: string;
	callbackPath: string;
	redirectUri: string;
	scopes: string[];
}

export interface SlackWorkspace {
	id: string;
	teamId: string;
	teamName: string;
	botUserId: string;
	installedBy: string;
	installedAt: string;
	status: "active" | "suspended" | "uninstalled";
}

export interface UiSession {
	id: string;
	createdAt: string;
	teams: Record<
		string,
		{
			userId: string;
			role: "admin" | "power_user" | "user" | "viewer";
			updatedAt: string;
		}
	>;
}

export const api = {
	auth: {
		me: () => request<{ ok: boolean; session?: UiSession }>("/auth/me"),
		requestCode: (teamId: string, userId: string) =>
			request<{ ok: boolean }>("/auth/request-code", {
				method: "POST",
				body: JSON.stringify({ teamId, userId }),
			}),
		verifyCode: (teamId: string, userId: string, code: string) =>
			request<{ ok: boolean; session?: UiSession }>("/auth/verify-code", {
				method: "POST",
				body: JSON.stringify({ teamId, userId, code }),
			}),
		logout: () =>
			request<{ ok: boolean }>("/auth/logout", {
				method: "POST",
			}),
	},

	workspaces: (teamId: string) => {
		const prefix = `/workspaces/${encodeURIComponent(teamId)}`;
		return {
			dashboards: {
				list: () => request<DashboardEntry[]>(`${prefix}/dashboards`),
				get: (id: string) =>
					request<DashboardEntry>(
						`${prefix}/dashboards/${encodeURIComponent(id)}`,
					),
				create: (body: Record<string, unknown>) =>
					request<DashboardEntry>(`${prefix}/dashboards`, {
						method: "POST",
						body: JSON.stringify(body),
					}),
				share: (id: string) =>
					request<{ ok: boolean }>(
						`${prefix}/dashboards/${encodeURIComponent(id)}/share`,
						{ method: "POST" },
					),
				unshare: (id: string) =>
					request<{ ok: boolean }>(
						`${prefix}/dashboards/${encodeURIComponent(id)}/unshare`,
						{ method: "POST" },
					),
				remove: (id: string) =>
					request<{ ok: boolean }>(
						`${prefix}/dashboards/${encodeURIComponent(id)}`,
						{
							method: "DELETE",
						},
					),
				render: (id: string, force = false) =>
					request<DashboardRenderResponse>(
						`${prefix}/dashboards/${encodeURIComponent(id)}/render${force ? "?force=1" : ""}`,
					),
			},
			connectors: {
				list: () => request<ConnectorInfo[]>(`${prefix}/connectors`),
				add: (type: string, name: string) =>
					request<{ ok: boolean; message: string }>(`${prefix}/connectors`, {
						method: "POST",
						body: JSON.stringify({ type, name }),
					}),
				remove: (name: string) =>
					request<{ ok: boolean }>(
						`${prefix}/connectors/${encodeURIComponent(name)}`,
						{ method: "DELETE" },
					),
				setCredentials: (
					name: string,
					secret: string,
					metadata?: Record<string, string>,
				) =>
					request<{ ok: boolean }>(
						`${prefix}/connectors/${encodeURIComponent(name)}/credentials`,
						{
							method: "PUT",
							body: JSON.stringify({ secret, metadata }),
						},
					),
				types: () => request<string[]>(`${prefix}/connectors/types`),
			},
			triggers: {
				list: () => request<TriggerInfo[]>(`${prefix}/triggers`),
				add: (trigger: Omit<TriggerInfo, "id">) =>
					request<TriggerInfo>(`${prefix}/triggers`, {
						method: "POST",
						body: JSON.stringify(trigger),
					}),
				remove: (id: string) =>
					request<{ ok: boolean }>(`${prefix}/triggers/${id}`, {
						method: "DELETE",
					}),
			},
		};
	},

	slack: {
		config: () => request<SlackConfig>("/slack/config"),
		workspaces: {
			list: () => request<SlackWorkspace[]>("/slack/workspaces"),
			remove: (teamId: string) =>
				request<{ ok: boolean }>(
					`/slack/workspaces/${encodeURIComponent(teamId)}`,
					{
						method: "DELETE",
					},
				),
			suspend: (teamId: string) =>
				request<{ ok: boolean }>(
					`/slack/workspaces/${encodeURIComponent(teamId)}/suspend`,
					{ method: "POST" },
				),
			reactivate: (teamId: string) =>
				request<{ ok: boolean }>(
					`/slack/workspaces/${encodeURIComponent(teamId)}/reactivate`,
					{ method: "POST" },
				),
			uninstall: (teamId: string) =>
				request<{ ok: boolean }>(
					`/slack/workspaces/${encodeURIComponent(teamId)}/uninstall`,
					{ method: "POST" },
				),
		},
	},
};
