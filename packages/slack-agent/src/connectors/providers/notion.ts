/**
 * Notion Connector
 *
 * Read/write access to Notion pages and databases.
 * Auth: Integration token (internal integration secret).
 */

import { Type } from "@sinclair/typebox";
import type {
	Connector,
	ConnectorCapability,
	ConnectorCredentials,
	ConnectorResult,
} from "../types.js";

const BASE_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export class NotionConnector implements Connector {
	readonly name = "notion";
	readonly displayName = "Notion";
	readonly authType = "api_key" as const;
	readonly description =
		"Notion - search, read, and create pages and databases";

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
			const r = await fetch(`${BASE_URL}/users/me`, {
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
			"Notion-Version": NOTION_VERSION,
			"Content-Type": "application/json",
		};
	}

	getCapabilities(): ConnectorCapability[] {
		return [
			{
				action: "search",
				description: "Search Notion pages and databases by title",
				parameters: Type.Object({
					query: Type.String({ description: "Search query" }),
					filter: Type.Optional(
						Type.String({ description: "Filter by type: page or database" }),
					),
					page_size: Type.Optional(Type.Number({ default: 10 })),
				}),
				category: "read",
			},
			{
				action: "get_page",
				description: "Get a Notion page by ID",
				parameters: Type.Object({
					pageId: Type.String({ description: "Page ID" }),
				}),
				category: "read",
			},
			{
				action: "get_page_content",
				description: "Get the block content of a Notion page",
				parameters: Type.Object({
					pageId: Type.String({
						description: "Page ID (also called block ID)",
					}),
					page_size: Type.Optional(Type.Number({ default: 50 })),
				}),
				category: "read",
			},
			{
				action: "query_database",
				description: "Query a Notion database",
				parameters: Type.Object({
					databaseId: Type.String({ description: "Database ID" }),
					page_size: Type.Optional(Type.Number({ default: 10 })),
				}),
				category: "read",
			},
			{
				action: "create_page",
				description: "Create a new Notion page in a parent page or database",
				parameters: Type.Object({
					parentId: Type.String({
						description: "Parent page ID or database ID",
					}),
					parentType: Type.String({
						description: "'page' or 'database'",
					}),
					title: Type.String({ description: "Page title" }),
					content: Type.Optional(
						Type.String({
							description: "Plain text content for the page body",
						}),
					),
				}),
				category: "write",
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
				case "search":
					return await this.search(params);
				case "get_page":
					return await this.getEndpoint(`/pages/${params.pageId}`);
				case "get_page_content":
					return await this.getEndpoint(
						`/blocks/${params.pageId}/children?page_size=${params.page_size ?? 50}`,
					);
				case "query_database":
					return await this.queryDatabase(params);
				case "create_page":
					return await this.createPage(params);
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

	private async search(
		params: Record<string, unknown>,
	): Promise<ConnectorResult> {
		const body: Record<string, unknown> = {
			query: String(params.query ?? ""),
			page_size: Number(params.page_size ?? 10),
		};
		if (params.filter) {
			body.filter = { value: params.filter, property: "object" };
		}
		const r = await fetch(`${BASE_URL}/search`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		if (!r.ok)
			return { success: false, error: `HTTP ${r.status}: ${await r.text()}` };
		return { success: true, data: await r.json() };
	}

	private async queryDatabase(
		params: Record<string, unknown>,
	): Promise<ConnectorResult> {
		const r = await fetch(`${BASE_URL}/databases/${params.databaseId}/query`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({
				page_size: Number(params.page_size ?? 10),
			}),
			signal: AbortSignal.timeout(30_000),
		});
		if (!r.ok)
			return { success: false, error: `HTTP ${r.status}: ${await r.text()}` };
		return { success: true, data: await r.json() };
	}

	private async createPage(
		params: Record<string, unknown>,
	): Promise<ConnectorResult> {
		const parentType = String(params.parentType);
		if (parentType !== "page" && parentType !== "database") {
			return {
				success: false,
				error: `Invalid parentType: "${parentType}". Must be "page" or "database".`,
			};
		}
		const parent =
			parentType === "database"
				? { database_id: String(params.parentId) }
				: { page_id: String(params.parentId) };

		const properties: Record<string, unknown> = {
			title: {
				title: [{ text: { content: String(params.title) } }],
			},
		};

		const body: Record<string, unknown> = { parent, properties };

		if (params.content) {
			body.children = [
				{
					object: "block",
					type: "paragraph",
					paragraph: {
						rich_text: [{ text: { content: String(params.content) } }],
					},
				},
			];
		}

		const r = await fetch(`${BASE_URL}/pages`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		if (!r.ok)
			return { success: false, error: `HTTP ${r.status}: ${await r.text()}` };
		return { success: true, data: await r.json() };
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
}
