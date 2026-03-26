/**
 * Stripe Connector
 *
 * Read access to Stripe customers, charges, invoices, subscriptions.
 * Auth: API key (secret key).
 */

import { Type } from "@sinclair/typebox";
import type {
	Connector,
	ConnectorCapability,
	ConnectorCredentials,
	ConnectorResult,
} from "../types.js";

const BASE_URL = "https://api.stripe.com/v1";

export class StripeConnector implements Connector {
	readonly name = "stripe";
	readonly displayName = "Stripe";
	readonly authType = "api_key" as const;
	readonly description =
		"Stripe payments - view customers, charges, invoices, and subscriptions";

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
			const r = await fetch(`${BASE_URL}/customers?limit=1`, {
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
				action: "list_customers",
				description: "List Stripe customers",
				parameters: Type.Object({
					limit: Type.Optional(Type.Number({ default: 10 })),
					email: Type.Optional(Type.String({ description: "Filter by email" })),
				}),
				category: "read",
			},
			{
				action: "get_customer",
				description: "Get a Stripe customer by ID",
				parameters: Type.Object({
					customerId: Type.String({ description: "Customer ID (cus_...)" }),
				}),
				category: "read",
			},
			{
				action: "list_charges",
				description: "List recent charges",
				parameters: Type.Object({
					limit: Type.Optional(Type.Number({ default: 10 })),
					customer: Type.Optional(
						Type.String({ description: "Filter by customer ID" }),
					),
				}),
				category: "read",
			},
			{
				action: "list_invoices",
				description: "List invoices",
				parameters: Type.Object({
					limit: Type.Optional(Type.Number({ default: 10 })),
					customer: Type.Optional(
						Type.String({ description: "Filter by customer ID" }),
					),
					status: Type.Optional(
						Type.String({
							description:
								"Filter by status: draft, open, paid, void, uncollectible",
						}),
					),
				}),
				category: "read",
			},
			{
				action: "list_subscriptions",
				description: "List subscriptions",
				parameters: Type.Object({
					limit: Type.Optional(Type.Number({ default: 10 })),
					customer: Type.Optional(
						Type.String({ description: "Filter by customer ID" }),
					),
					status: Type.Optional(
						Type.String({ description: "Filter by status" }),
					),
				}),
				category: "read",
			},
			{
				action: "get_balance",
				description: "Get the current Stripe account balance",
				parameters: Type.Object({}),
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
				case "list_customers":
					return await this.list("customers", params);
				case "get_customer":
					return await this.get("customers", String(params.customerId));
				case "list_charges":
					return await this.list("charges", params);
				case "list_invoices":
					return await this.list("invoices", params);
				case "list_subscriptions":
					return await this.list("subscriptions", params);
				case "get_balance":
					return await this.get("balance", "");
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

	private async list(
		resource: string,
		params: Record<string, unknown>,
	): Promise<ConnectorResult> {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(params)) {
			if (v != null && v !== "") qs.set(k, String(v));
		}
		if (!qs.has("limit")) qs.set("limit", "10");

		const r = await fetch(`${BASE_URL}/${resource}?${qs}`, {
			headers: { Authorization: `Bearer ${this.token}` },
			signal: AbortSignal.timeout(30_000),
		});
		if (!r.ok)
			return { success: false, error: `HTTP ${r.status}: ${await r.text()}` };
		return { success: true, data: await r.json() };
	}

	private async get(resource: string, id: string): Promise<ConnectorResult> {
		const path = id
			? `${BASE_URL}/${resource}/${id}`
			: `${BASE_URL}/${resource}`;
		const r = await fetch(path, {
			headers: { Authorization: `Bearer ${this.token}` },
			signal: AbortSignal.timeout(30_000),
		});
		if (!r.ok)
			return { success: false, error: `HTTP ${r.status}: ${await r.text()}` };
		return { success: true, data: await r.json() };
	}
}
