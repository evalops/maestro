/**
 * Generic REST API Connector
 *
 * Connects to any REST API with a base URL and API key.
 * Provides GET, POST, PUT, and DELETE actions.
 */

import { Type } from "@sinclair/typebox";
import type {
	Connector,
	ConnectorCapability,
	ConnectorCredentials,
	ConnectorResult,
} from "../types.js";

export class RestApiConnector implements Connector {
	readonly name = "rest_api";
	readonly displayName = "REST API";
	readonly authType = "api_key" as const;
	readonly description = "Generic REST API connector for any HTTP service";

	private baseUrl = "";
	private headers: Record<string, string> = {};
	private connected = false;

	async connect(credentials: ConnectorCredentials): Promise<void> {
		this.baseUrl = (credentials.metadata?.baseUrl ?? "").replace(/\/+$/, "");
		if (!this.baseUrl) {
			throw new Error(
				"REST API connector requires baseUrl in credentials metadata",
			);
		}

		this.headers = {
			Authorization: `Bearer ${credentials.secret}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		};

		if (credentials.metadata?.headerName && credentials.metadata?.headerValue) {
			this.headers[credentials.metadata.headerName] =
				credentials.metadata.headerValue;
		}

		this.connected = true;
	}

	async disconnect(): Promise<void> {
		this.connected = false;
		this.headers = {};
		this.baseUrl = "";
	}

	async healthCheck(): Promise<boolean> {
		if (!this.connected) return false;
		try {
			const response = await fetch(this.baseUrl, {
				method: "HEAD",
				headers: this.headers,
				signal: AbortSignal.timeout(10_000),
			});
			return response.ok || response.status === 404 || response.status === 405;
		} catch {
			return false;
		}
	}

	getCapabilities(): ConnectorCapability[] {
		return [
			{
				action: "get",
				description: "Make a GET request to retrieve data from the API",
				parameters: Type.Object({
					path: Type.String({
						description: "API path (e.g., /users, /api/v1/deals)",
					}),
					query: Type.Optional(
						Type.Record(Type.String(), Type.String(), {
							description: "Query string parameters",
						}),
					),
				}),
				category: "read",
			},
			{
				action: "post",
				description: "Make a POST request to create data",
				parameters: Type.Object({
					path: Type.String({ description: "API path" }),
					body: Type.Optional(
						Type.Unknown({ description: "JSON request body" }),
					),
				}),
				category: "write",
			},
			{
				action: "put",
				description: "Make a PUT request to update data",
				parameters: Type.Object({
					path: Type.String({ description: "API path" }),
					body: Type.Optional(
						Type.Unknown({ description: "JSON request body" }),
					),
				}),
				category: "write",
			},
			{
				action: "delete",
				description: "Make a DELETE request to remove data",
				parameters: Type.Object({
					path: Type.String({ description: "API path" }),
				}),
				category: "delete",
			},
		];
	}

	async execute(
		action: string,
		params: Record<string, unknown>,
	): Promise<ConnectorResult> {
		if (!this.connected) {
			return { success: false, error: "Connector is not connected" };
		}

		const path = String(params.path ?? "");
		const url = new URL(path, this.baseUrl);

		if (params.query && typeof params.query === "object") {
			for (const [k, v] of Object.entries(
				params.query as Record<string, string>,
			)) {
				url.searchParams.set(k, v);
			}
		}

		const methodMap: Record<string, string> = {
			get: "GET",
			post: "POST",
			put: "PUT",
			delete: "DELETE",
		};

		const method = methodMap[action];
		if (!method) {
			return { success: false, error: `Unknown action: ${action}` };
		}

		try {
			const fetchOpts: RequestInit = {
				method,
				headers: this.headers,
				signal: AbortSignal.timeout(30_000),
			};

			if ((method === "POST" || method === "PUT") && params.body != null) {
				fetchOpts.body = JSON.stringify(params.body);
			}

			const response = await fetch(url.toString(), fetchOpts);
			const contentType = response.headers.get("content-type") ?? "";

			let data: unknown;
			if (contentType.includes("application/json")) {
				data = await response.json();
			} else {
				data = await response.text();
			}

			if (!response.ok) {
				return {
					success: false,
					error: `HTTP ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`,
				};
			}

			return { success: true, data };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
}
