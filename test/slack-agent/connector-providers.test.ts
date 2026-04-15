/**
 * Tests for connector providers - validates structure, capabilities, and error handling.
 * No real API calls are made.
 */

import { describe, expect, it } from "vitest";
import {
	getRegisteredTypes,
	registerBuiltInConnectors,
} from "../../packages/slack-agent/src/connectors/index.js";

registerBuiltInConnectors();
import { GitHubConnector } from "../../packages/slack-agent/src/connectors/providers/github.js";
import { HubSpotConnector } from "../../packages/slack-agent/src/connectors/providers/hubspot.js";
import { LinearConnector } from "../../packages/slack-agent/src/connectors/providers/linear.js";
import { NotionConnector } from "../../packages/slack-agent/src/connectors/providers/notion.js";
import { PostgresConnector } from "../../packages/slack-agent/src/connectors/providers/postgres.js";
import { RestApiConnector } from "../../packages/slack-agent/src/connectors/providers/rest-api.js";
import { StripeConnector } from "../../packages/slack-agent/src/connectors/providers/stripe.js";
import { ZendeskConnector } from "../../packages/slack-agent/src/connectors/providers/zendesk.js";

describe("connector providers", () => {
	const connectors = [
		{ Cls: RestApiConnector, name: "rest_api", authType: "api_key" },
		{ Cls: HubSpotConnector, name: "hubspot", authType: "api_key" },
		{ Cls: StripeConnector, name: "stripe", authType: "api_key" },
		{ Cls: GitHubConnector, name: "github", authType: "api_key" },
		{ Cls: LinearConnector, name: "linear", authType: "api_key" },
		{ Cls: NotionConnector, name: "notion", authType: "api_key" },
		{ Cls: ZendeskConnector, name: "zendesk", authType: "api_key" },
		{
			Cls: PostgresConnector,
			name: "postgres",
			authType: "connection_string",
		},
	];

	for (const { Cls, name, authType } of connectors) {
		describe(name, () => {
			it("has correct name and authType", () => {
				const c = new Cls();
				expect(c.name).toBe(name);
				expect(c.authType).toBe(authType);
				expect(c.displayName).toBeTruthy();
				expect(c.description).toBeTruthy();
			});

			it("returns capabilities with valid structure", () => {
				const c = new Cls();
				const caps = c.getCapabilities();
				expect(caps.length).toBeGreaterThan(0);

				for (const cap of caps) {
					expect(cap.action).toBeTruthy();
					expect(cap.description).toBeTruthy();
					expect(cap.parameters).toBeTruthy();
					expect(["read", "write", "delete"]).toContain(cap.category);
				}
			});

			it("has at least one read capability", () => {
				const c = new Cls();
				const caps = c.getCapabilities();
				const reads = caps.filter((c) => c.category === "read");
				expect(reads.length).toBeGreaterThan(0);
			});

			it("returns error when not connected", async () => {
				const c = new Cls();
				const caps = c.getCapabilities();
				const result = await c.execute(caps[0]!.action, {});
				expect(result.success).toBe(false);
				expect(result.error).toBeTruthy();
			});

			it("returns false for healthCheck when not connected", async () => {
				const c = new Cls();
				expect(await c.healthCheck()).toBe(false);
			});

			it("returns error for unknown action", async () => {
				const c = new Cls();
				// Force connect state for testing
				await c
					.connect({
						type: authType as "api_key" | "connection_string",
						secret:
							authType === "connection_string"
								? "postgresql://localhost/testdb"
								: "fake-key",
						metadata: {
							baseUrl: "https://example.com",
							subdomain: "test",
						},
					})
					.catch(() => {});
				const result = await c.execute("nonexistent_action_xyz", {});
				expect(result.success).toBe(false);
			});

			it("disconnect resets state", async () => {
				const c = new Cls();
				try {
					await c.connect({
						type: authType as "api_key" | "connection_string",
						secret:
							authType === "connection_string"
								? "postgresql://localhost/testdb"
								: "fake-key",
						metadata: {
							baseUrl: "https://example.com",
							subdomain: "test",
						},
					});
				} catch {
					// Some connectors may fail connect without real credentials
				}
				await c.disconnect();
				expect(await c.healthCheck()).toBe(false);
			});
		});
	}
});

describe("factory registration", () => {
	it("all 8 connector types are registered", () => {
		const types = getRegisteredTypes();
		expect(types).toContain("rest_api");
		expect(types).toContain("hubspot");
		expect(types).toContain("stripe");
		expect(types).toContain("github");
		expect(types).toContain("linear");
		expect(types).toContain("notion");
		expect(types).toContain("zendesk");
		expect(types).toContain("postgres");
		expect(types.length).toBeGreaterThanOrEqual(8);
	});
});

describe("PostgresConnector SQL safety", () => {
	it("blocks write queries", async () => {
		const c = new PostgresConnector();
		await c.connect({
			type: "connection_string",
			secret: "postgresql://localhost/testdb",
		});

		for (const keyword of [
			"DROP TABLE users",
			"DELETE FROM users",
			"UPDATE users SET name='x'",
			"INSERT INTO users VALUES(1)",
			"ALTER TABLE users ADD col INT",
			"TRUNCATE users",
		]) {
			const result = await c.execute("query", { sql: keyword });
			expect(result.success).toBe(false);
			expect(result.error).toContain("read-only");
		}
	});

	it("allows SELECT queries", async () => {
		const c = new PostgresConnector();
		await c.connect({
			type: "connection_string",
			secret: "postgresql://localhost/testdb",
		});

		const result = await c.execute("query", {
			sql: "SELECT * FROM users LIMIT 10",
		});
		expect(result.success).toBe(true);
	});

	it("rejects invalid connection strings", async () => {
		const c = new PostgresConnector();
		await expect(
			c.connect({ type: "connection_string", secret: "not-a-url" }),
		).rejects.toThrow("connection URI");
	});
});

describe("RestApiConnector", () => {
	it("requires baseUrl in metadata", async () => {
		const c = new RestApiConnector();
		await expect(c.connect({ type: "api_key", secret: "key" })).rejects.toThrow(
			"baseUrl",
		);
	});
});

describe("ZendeskConnector", () => {
	it("requires subdomain in metadata", async () => {
		const c = new ZendeskConnector();
		await expect(c.connect({ type: "api_key", secret: "key" })).rejects.toThrow(
			"subdomain",
		);
	});
});
