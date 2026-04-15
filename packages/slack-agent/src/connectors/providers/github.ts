/**
 * GitHub Connector
 *
 * Read/write access to GitHub repos, issues, pull requests.
 * Auth: Personal access token or GitHub App token.
 */

import { Type } from "@sinclair/typebox";
import type {
	Connector,
	ConnectorCapability,
	ConnectorCredentials,
	ConnectorResult,
} from "../types.js";

const BASE_URL = "https://api.github.com";

export class GitHubConnector implements Connector {
	readonly name = "github";
	readonly displayName = "GitHub";
	readonly authType = "api_key" as const;
	readonly description =
		"GitHub - manage repos, issues, pull requests, and workflows";

	private token = "";
	private connected = false;

	async connect(credentials: ConnectorCredentials): Promise<void> {
		this.token = credentials.secret;
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		this.connected = false;
		this.token = "";
	}

	async healthCheck(): Promise<boolean> {
		if (!this.connected) return false;
		try {
			const r = await fetch(`${BASE_URL}/user`, {
				headers: this.headers(),
				signal: AbortSignal.timeout(10_000),
			});
			return r.ok;
		} catch {
			return false;
		}
	}

	private headers(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		};
	}

	getCapabilities(): ConnectorCapability[] {
		return [
			{
				action: "list_repos",
				description: "List repositories for the authenticated user or an org",
				parameters: Type.Object({
					org: Type.Optional(Type.String({ description: "Organization name" })),
					type: Type.Optional(
						Type.String({
							description: "Filter: all, owner, member (default: owner)",
						}),
					),
					per_page: Type.Optional(Type.Number({ default: 10 })),
				}),
				category: "read",
			},
			{
				action: "list_issues",
				description: "List issues for a repository",
				parameters: Type.Object({
					owner: Type.String({ description: "Repo owner" }),
					repo: Type.String({ description: "Repo name" }),
					state: Type.Optional(
						Type.String({ description: "open, closed, all" }),
					),
					per_page: Type.Optional(Type.Number({ default: 10 })),
				}),
				category: "read",
			},
			{
				action: "create_issue",
				description: "Create a new issue",
				parameters: Type.Object({
					owner: Type.String(),
					repo: Type.String(),
					title: Type.String({ description: "Issue title" }),
					body: Type.Optional(
						Type.String({ description: "Issue body (markdown)" }),
					),
					labels: Type.Optional(Type.Array(Type.String())),
				}),
				category: "write",
			},
			{
				action: "list_prs",
				description: "List pull requests for a repository",
				parameters: Type.Object({
					owner: Type.String(),
					repo: Type.String(),
					state: Type.Optional(
						Type.String({ description: "open, closed, all" }),
					),
					per_page: Type.Optional(Type.Number({ default: 10 })),
				}),
				category: "read",
			},
			{
				action: "get_pr",
				description: "Get details of a pull request",
				parameters: Type.Object({
					owner: Type.String(),
					repo: Type.String(),
					pull_number: Type.Number({ description: "PR number" }),
				}),
				category: "read",
			},
			{
				action: "list_workflows",
				description: "List GitHub Actions workflow runs",
				parameters: Type.Object({
					owner: Type.String(),
					repo: Type.String(),
					per_page: Type.Optional(Type.Number({ default: 5 })),
				}),
				category: "read",
			},
		];
	}

	async execute(
		action: string,
		params: Record<string, unknown>,
	): Promise<ConnectorResult> {
		if (!this.connected) return { success: false, error: "Not connected" };

		try {
			switch (action) {
				case "list_repos":
					return await this.listRepos(params);
				case "list_issues":
					return await this.listEndpoint(
						`/repos/${params.owner}/${params.repo}/issues`,
						params,
					);
				case "create_issue":
					return await this.post(
						`/repos/${params.owner}/${params.repo}/issues`,
						{ title: params.title, body: params.body, labels: params.labels },
					);
				case "list_prs":
					return await this.listEndpoint(
						`/repos/${params.owner}/${params.repo}/pulls`,
						params,
					);
				case "get_pr":
					return await this.getEndpoint(
						`/repos/${params.owner}/${params.repo}/pulls/${params.pull_number}`,
					);
				case "list_workflows":
					return await this.getEndpoint(
						`/repos/${params.owner}/${params.repo}/actions/runs?per_page=${params.per_page ?? 5}`,
					);
				default:
					return { success: false, error: `Unknown action: ${action}` };
			}
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async listRepos(
		params: Record<string, unknown>,
	): Promise<ConnectorResult> {
		const org = params.org ? String(params.org) : null;
		const path = org ? `/orgs/${org}/repos` : "/user/repos";
		const qs = new URLSearchParams();
		if (params.type) qs.set("type", String(params.type));
		qs.set("per_page", String(params.per_page ?? 10));
		return this.getEndpoint(`${path}?${qs}`);
	}

	private async listEndpoint(
		path: string,
		params: Record<string, unknown>,
	): Promise<ConnectorResult> {
		const qs = new URLSearchParams();
		if (params.state) qs.set("state", String(params.state));
		qs.set("per_page", String(params.per_page ?? 10));
		return this.getEndpoint(`${path}?${qs}`);
	}

	private async getEndpoint(path: string): Promise<ConnectorResult> {
		const r = await fetch(`${BASE_URL}${path}`, {
			headers: this.headers(),
			signal: AbortSignal.timeout(30_000),
		});
		if (!r.ok)
			return { success: false, error: `HTTP ${r.status}: ${await r.text()}` };
		return { success: true, data: await r.json() };
	}

	private async post(
		path: string,
		body: Record<string, unknown>,
	): Promise<ConnectorResult> {
		const r = await fetch(`${BASE_URL}${path}`, {
			method: "POST",
			headers: { ...this.headers(), "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		if (!r.ok)
			return { success: false, error: `HTTP ${r.status}: ${await r.text()}` };
		return { success: true, data: await r.json() };
	}
}
