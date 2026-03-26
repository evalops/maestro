/**
 * HubSpot CRM Connector
 *
 * Provides read/write access to HubSpot contacts, deals, and companies.
 * Auth: API key (private app token).
 */

import { Type } from "@sinclair/typebox";
import type {
	Connector,
	ConnectorCapability,
	ConnectorCredentials,
	ConnectorResult,
} from "../types.js";

const BASE_URL = "https://api.hubapi.com";

export class HubSpotConnector implements Connector {
	readonly name = "hubspot";
	readonly displayName = "HubSpot CRM";
	readonly authType = "api_key" as const;
	readonly description =
		"HubSpot CRM - manage contacts, deals, companies, and pipelines";

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
			const r = await fetch(`${BASE_URL}/crm/v3/objects/contacts?limit=1`, {
				headers: { Authorization: `Bearer ${this.token}` },
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
				action: "search_contacts",
				description: "Search HubSpot contacts by name, email, or property",
				parameters: Type.Object({
					query: Type.String({ description: "Search query" }),
					limit: Type.Optional(
						Type.Number({
							description: "Max results (default 10)",
							default: 10,
						}),
					),
				}),
				category: "read",
			},
			{
				action: "get_contact",
				description: "Get a HubSpot contact by ID",
				parameters: Type.Object({
					contactId: Type.String({ description: "Contact ID" }),
				}),
				category: "read",
			},
			{
				action: "create_contact",
				description: "Create a new HubSpot contact",
				parameters: Type.Object({
					email: Type.String({ description: "Contact email" }),
					firstname: Type.Optional(Type.String()),
					lastname: Type.Optional(Type.String()),
					company: Type.Optional(Type.String()),
					phone: Type.Optional(Type.String()),
				}),
				category: "write",
			},
			{
				action: "search_deals",
				description: "Search HubSpot deals",
				parameters: Type.Object({
					query: Type.String({ description: "Search query" }),
					limit: Type.Optional(Type.Number({ default: 10 })),
				}),
				category: "read",
			},
			{
				action: "get_deal",
				description: "Get a HubSpot deal by ID",
				parameters: Type.Object({
					dealId: Type.String({ description: "Deal ID" }),
				}),
				category: "read",
			},
			{
				action: "create_deal",
				description: "Create a new HubSpot deal",
				parameters: Type.Object({
					dealname: Type.String({ description: "Deal name" }),
					amount: Type.Optional(Type.String({ description: "Deal amount" })),
					pipeline: Type.Optional(Type.String({ description: "Pipeline ID" })),
					dealstage: Type.Optional(
						Type.String({ description: "Deal stage ID" }),
					),
				}),
				category: "write",
			},
			{
				action: "list_companies",
				description: "List HubSpot companies",
				parameters: Type.Object({
					limit: Type.Optional(Type.Number({ default: 10 })),
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
				case "search_contacts":
					return await this.searchObjects("contacts", params);
				case "get_contact":
					return await this.getObject("contacts", String(params.contactId));
				case "create_contact":
					return await this.createObject("contacts", params);
				case "search_deals":
					return await this.searchObjects("deals", params);
				case "get_deal":
					return await this.getObject("deals", String(params.dealId));
				case "create_deal":
					return await this.createObject("deals", params);
				case "list_companies":
					return await this.listObjects("companies", params);
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

	private async searchObjects(
		objectType: string,
		params: Record<string, unknown>,
	): Promise<ConnectorResult> {
		const r = await fetch(`${BASE_URL}/crm/v3/objects/${objectType}/search`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: String(params.query ?? ""),
				limit: Number(params.limit ?? 10),
			}),
			signal: AbortSignal.timeout(30_000),
		});
		if (!r.ok)
			return { success: false, error: `HTTP ${r.status}: ${await r.text()}` };
		return { success: true, data: await r.json() };
	}

	private async getObject(
		objectType: string,
		id: string,
	): Promise<ConnectorResult> {
		const r = await fetch(`${BASE_URL}/crm/v3/objects/${objectType}/${id}`, {
			headers: { Authorization: `Bearer ${this.token}` },
			signal: AbortSignal.timeout(30_000),
		});
		if (!r.ok)
			return { success: false, error: `HTTP ${r.status}: ${await r.text()}` };
		return { success: true, data: await r.json() };
	}

	private async createObject(
		objectType: string,
		params: Record<string, unknown>,
	): Promise<ConnectorResult> {
		const properties = { ...params };
		const r = await fetch(`${BASE_URL}/crm/v3/objects/${objectType}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ properties }),
			signal: AbortSignal.timeout(30_000),
		});
		if (!r.ok)
			return { success: false, error: `HTTP ${r.status}: ${await r.text()}` };
		return { success: true, data: await r.json() };
	}

	private async listObjects(
		objectType: string,
		params: Record<string, unknown>,
	): Promise<ConnectorResult> {
		const limit = Number(params.limit ?? 10);
		const r = await fetch(
			`${BASE_URL}/crm/v3/objects/${objectType}?limit=${limit}`,
			{
				headers: { Authorization: `Bearer ${this.token}` },
				signal: AbortSignal.timeout(30_000),
			},
		);
		if (!r.ok)
			return { success: false, error: `HTTP ${r.status}: ${await r.text()}` };
		return { success: true, data: await r.json() };
	}
}
