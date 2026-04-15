/**
 * Zendesk Connector
 *
 * Read/write access to Zendesk tickets, users, and organizations.
 * Auth: API key (email/token format) or OAuth token.
 * Credentials metadata must include `subdomain` (e.g., "mycompany").
 */

import { Type } from "@sinclair/typebox";
import type {
	Connector,
	ConnectorCapability,
	ConnectorCredentials,
	ConnectorResult,
} from "../types.js";

export class ZendeskConnector implements Connector {
	readonly name = "zendesk";
	readonly displayName = "Zendesk";
	readonly authType = "api_key" as const;
	readonly description =
		"Zendesk support - manage tickets, users, and organizations";

	private baseUrl = "";
	private authHeader = "";
	private connected = false;

	async connect(credentials: ConnectorCredentials): Promise<void> {
		const subdomain = credentials.metadata?.subdomain;
		if (!subdomain) {
			throw new Error("Zendesk connector requires 'subdomain' in metadata");
		}
		this.baseUrl = `https://${subdomain}.zendesk.com/api/v2`;

		const email = credentials.metadata?.email;
		if (email) {
			this.authHeader = `Basic ${Buffer.from(`${email}/token:${credentials.secret}`).toString("base64")}`;
		} else {
			this.authHeader = `Bearer ${credentials.secret}`;
		}
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		this.connected = false;
		this.authHeader = "";
		this.baseUrl = "";
	}

	async healthCheck(): Promise<boolean> {
		if (!this.connected) return false;
		try {
			const r = await fetch(`${this.baseUrl}/users/me.json`, {
				headers: { Authorization: this.authHeader },
				signal: AbortSignal.timeout(10_000),
			});
			return r.ok;
		} catch {
			return false;
		}
	}

	getCapabilities(): ConnectorCapability[] {
		return [
			{
				action: "list_tickets",
				description: "List recent Zendesk tickets",
				parameters: Type.Object({
					status: Type.Optional(
						Type.String({
							description: "Filter: new, open, pending, solved, closed",
						}),
					),
					per_page: Type.Optional(Type.Number({ default: 10 })),
				}),
				category: "read",
			},
			{
				action: "get_ticket",
				description: "Get a Zendesk ticket by ID",
				parameters: Type.Object({
					ticketId: Type.String({ description: "Ticket ID" }),
				}),
				category: "read",
			},
			{
				action: "search_tickets",
				description: "Search Zendesk tickets",
				parameters: Type.Object({
					query: Type.String({ description: "Search query" }),
					per_page: Type.Optional(Type.Number({ default: 10 })),
				}),
				category: "read",
			},
			{
				action: "create_ticket",
				description: "Create a new Zendesk ticket",
				parameters: Type.Object({
					subject: Type.String({ description: "Ticket subject" }),
					body: Type.String({
						description: "Ticket description (first comment)",
					}),
					priority: Type.Optional(
						Type.String({ description: "low, normal, high, urgent" }),
					),
					requester_email: Type.Optional(
						Type.String({ description: "Requester email address" }),
					),
				}),
				category: "write",
			},
			{
				action: "update_ticket",
				description: "Update a Zendesk ticket (status, priority, add comment)",
				parameters: Type.Object({
					ticketId: Type.String({ description: "Ticket ID" }),
					status: Type.Optional(Type.String()),
					priority: Type.Optional(Type.String()),
					comment: Type.Optional(
						Type.String({ description: "Add a comment to the ticket" }),
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
				case "list_tickets":
					return await this.listTickets(params);
				case "get_ticket":
					return await this.getEndpoint(`/tickets/${params.ticketId}.json`);
				case "search_tickets":
					return await this.searchTickets(params);
				case "create_ticket":
					return await this.createTicket(params);
				case "update_ticket":
					return await this.updateTicket(params);
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

	private async listTickets(
		params: Record<string, unknown>,
	): Promise<ConnectorResult> {
		const qs = new URLSearchParams();
		qs.set("per_page", String(params.per_page ?? 10));
		qs.set("sort_by", "created_at");
		qs.set("sort_order", "desc");
		let path = `/tickets.json?${qs}`;
		if (params.status) {
			path = `/search.json?query=type:ticket status:${params.status}&per_page=${params.per_page ?? 10}`;
		}
		return this.getEndpoint(path);
	}

	private async searchTickets(
		params: Record<string, unknown>,
	): Promise<ConnectorResult> {
		const qs = new URLSearchParams();
		qs.set("query", `type:ticket ${String(params.query ?? "")}`);
		qs.set("per_page", String(params.per_page ?? 10));
		return this.getEndpoint(`/search.json?${qs}`);
	}

	private async createTicket(
		params: Record<string, unknown>,
	): Promise<ConnectorResult> {
		const ticket: Record<string, unknown> = {
			subject: params.subject,
			comment: { body: params.body },
		};
		if (params.priority) ticket.priority = params.priority;
		if (params.requester_email) {
			ticket.requester = { email: params.requester_email };
		}

		const r = await fetch(`${this.baseUrl}/tickets.json`, {
			method: "POST",
			headers: {
				Authorization: this.authHeader,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ ticket }),
			signal: AbortSignal.timeout(30_000),
		});
		if (!r.ok)
			return { success: false, error: `HTTP ${r.status}: ${await r.text()}` };
		return { success: true, data: await r.json() };
	}

	private async updateTicket(
		params: Record<string, unknown>,
	): Promise<ConnectorResult> {
		const ticket: Record<string, unknown> = {};
		if (params.status) ticket.status = params.status;
		if (params.priority) ticket.priority = params.priority;
		if (params.comment) ticket.comment = { body: params.comment };

		const r = await fetch(`${this.baseUrl}/tickets/${params.ticketId}.json`, {
			method: "PUT",
			headers: {
				Authorization: this.authHeader,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ ticket }),
			signal: AbortSignal.timeout(30_000),
		});
		if (!r.ok)
			return { success: false, error: `HTTP ${r.status}: ${await r.text()}` };
		return { success: true, data: await r.json() };
	}

	private async getEndpoint(path: string): Promise<ConnectorResult> {
		const r = await fetch(`${this.baseUrl}${path}`, {
			headers: { Authorization: this.authHeader },
			signal: AbortSignal.timeout(30_000),
		});
		if (!r.ok)
			return { success: false, error: `HTTP ${r.status}: ${await r.text()}` };
		return { success: true, data: await r.json() };
	}
}
