/**
 * Linear Connector
 *
 * Read/write access to Linear issues, projects, and teams via GraphQL API.
 * Auth: API key (personal or OAuth token).
 */

import { Type } from "@sinclair/typebox";
import type {
	Connector,
	ConnectorCapability,
	ConnectorCredentials,
	ConnectorResult,
} from "../types.js";

const API_URL = "https://api.linear.app/graphql";

export class LinearConnector implements Connector {
	readonly name = "linear";
	readonly displayName = "Linear";
	readonly authType = "api_key" as const;
	readonly description =
		"Linear project management - manage issues, projects, and cycles";

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
			const r = await this.gql("{ viewer { id } }");
			return r.success;
		} catch {
			return false;
		}
	}

	getCapabilities(): ConnectorCapability[] {
		return [
			{
				action: "list_issues",
				description: "List Linear issues with optional filters",
				parameters: Type.Object({
					teamKey: Type.Optional(
						Type.String({ description: "Team key (e.g., ENG)" }),
					),
					state: Type.Optional(
						Type.String({
							description: "State name filter (e.g., In Progress)",
						}),
					),
					first: Type.Optional(Type.Number({ default: 10 })),
				}),
				category: "read",
			},
			{
				action: "get_issue",
				description: "Get a Linear issue by identifier (e.g., ENG-123)",
				parameters: Type.Object({
					identifier: Type.String({
						description: "Issue identifier (e.g., ENG-123)",
					}),
				}),
				category: "read",
			},
			{
				action: "create_issue",
				description: "Create a new Linear issue",
				parameters: Type.Object({
					title: Type.String({ description: "Issue title" }),
					teamId: Type.String({ description: "Team ID" }),
					description: Type.Optional(
						Type.String({ description: "Issue description (markdown)" }),
					),
					priority: Type.Optional(
						Type.Number({
							description:
								"Priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low",
						}),
					),
				}),
				category: "write",
			},
			{
				action: "update_issue",
				description: "Update a Linear issue",
				parameters: Type.Object({
					issueId: Type.String({ description: "Issue ID" }),
					title: Type.Optional(Type.String()),
					description: Type.Optional(Type.String()),
					stateId: Type.Optional(
						Type.String({ description: "Workflow state ID" }),
					),
					priority: Type.Optional(Type.Number()),
				}),
				category: "write",
			},
			{
				action: "list_teams",
				description: "List Linear teams",
				parameters: Type.Object({}),
				category: "read",
			},
			{
				action: "list_projects",
				description: "List Linear projects",
				parameters: Type.Object({
					first: Type.Optional(Type.Number({ default: 10 })),
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
				case "list_issues":
					return await this.listIssues(params);
				case "get_issue":
					return await this.getIssue(String(params.identifier));
				case "create_issue":
					return await this.createIssue(params);
				case "update_issue":
					return await this.updateIssue(params);
				case "list_teams":
					return await this.gql("{ teams { nodes { id name key } } }");
				case "list_projects":
					return await this.gql(
						"query($first: Int!) { projects(first: $first) { nodes { id name state } } }",
						{ first: Number(params.first ?? 10) },
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

	private async listIssues(
		params: Record<string, unknown>,
	): Promise<ConnectorResult> {
		const variables: Record<string, unknown> = {
			first: Number(params.first ?? 10),
		};

		// Build filter object using variables
		const filterParts: string[] = [];
		const queryParams: string[] = ["$first: Int!"];

		if (params.teamKey) {
			queryParams.push("$teamKey: String!");
			filterParts.push("team: { key: { eq: $teamKey } }");
			variables.teamKey = String(params.teamKey);
		}
		if (params.state) {
			queryParams.push("$state: String!");
			filterParts.push("state: { name: { eq: $state } }");
			variables.state = String(params.state);
		}

		const filterStr =
			filterParts.length > 0 ? `, filter: { ${filterParts.join(", ")} }` : "";
		const query = `query(${queryParams.join(", ")}) { issues(first: $first${filterStr}) { nodes { id identifier title state { name } priority assignee { name } } } }`;
		return this.gql(query, variables);
	}

	private async getIssue(identifier: string): Promise<ConnectorResult> {
		const query =
			"query($q: String!) { issueSearch(query: $q, first: 1) { nodes { id identifier title description state { name } priority assignee { name } labels { nodes { name } } } } }";
		return this.gql(query, { q: identifier });
	}

	private async createIssue(
		params: Record<string, unknown>,
	): Promise<ConnectorResult> {
		const input: Record<string, unknown> = {
			title: params.title,
			teamId: params.teamId,
		};
		if (params.description) input.description = params.description;
		if (params.priority != null) input.priority = params.priority;

		const query =
			"mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title } } }";
		return this.gql(query, { input });
	}

	private async updateIssue(
		params: Record<string, unknown>,
	): Promise<ConnectorResult> {
		const id = String(params.issueId);
		const input: Record<string, unknown> = {};
		if (params.title) input.title = params.title;
		if (params.description) input.description = params.description;
		if (params.stateId) input.stateId = params.stateId;
		if (params.priority != null) input.priority = params.priority;

		const query =
			"mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier title state { name } } } }";
		return this.gql(query, { id, input });
	}

	private async gql(
		query: string,
		variables?: Record<string, unknown>,
	): Promise<ConnectorResult> {
		const r = await fetch(API_URL, {
			method: "POST",
			headers: {
				Authorization: this.token,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query, variables }),
			signal: AbortSignal.timeout(30_000),
		});
		if (!r.ok)
			return { success: false, error: `HTTP ${r.status}: ${await r.text()}` };
		const json = (await r.json()) as {
			data?: unknown;
			errors?: Array<{ message: string }>;
		};
		if (json.errors?.length)
			return {
				success: false,
				error: json.errors.map((e) => e.message).join("; "),
			};
		return { success: true, data: json.data };
	}
}
