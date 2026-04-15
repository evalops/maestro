/**
 * PostgreSQL Connector
 *
 * Executes read-only SQL queries against a PostgreSQL database.
 * Auth: connection_string (a standard PostgreSQL connection URI).
 *
 * Note: Uses the sandbox executor to run psql commands rather than
 * a native driver, so it works in any sandbox environment with psql installed.
 * For Daytona/Docker sandboxes, psql can be installed via apt-get.
 */

import { Type } from "@sinclair/typebox";
import type {
	Connector,
	ConnectorCapability,
	ConnectorCredentials,
	ConnectorResult,
} from "../types.js";

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export class PostgresConnector implements Connector {
	readonly name = "postgres";
	readonly displayName = "PostgreSQL";
	readonly authType = "connection_string" as const;
	readonly description =
		"PostgreSQL database - run read-only SQL queries and explore schema";

	private connectionString = "";
	private connected = false;

	async connect(credentials: ConnectorCredentials): Promise<void> {
		this.connectionString = credentials.secret;
		const pgPrefix = "postgres" + "://";
		const pgLongPrefix = "postgresql" + "://";
		if (
			!this.connectionString.startsWith(pgPrefix) &&
			!this.connectionString.startsWith(pgLongPrefix)
		) {
			throw new Error("PostgreSQL connector requires a valid connection URI");
		}
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		this.connected = false;
		this.connectionString = "";
	}

	async healthCheck(): Promise<boolean> {
		return this.connected;
	}

	getCapabilities(): ConnectorCapability[] {
		return [
			{
				action: "query",
				description:
					"Execute a read-only SQL query against the PostgreSQL database. Returns JSON rows.",
				parameters: Type.Object({
					sql: Type.String({
						description:
							"SQL query to execute. Must be SELECT or read-only. Do NOT use DROP, DELETE, UPDATE, INSERT, ALTER, TRUNCATE.",
					}),
				}),
				category: "read",
			},
			{
				action: "list_tables",
				description: "List all tables in the database",
				parameters: Type.Object({
					schema: Type.Optional(
						Type.String({
							description: "Schema name (default: public)",
							default: "public",
						}),
					),
				}),
				category: "read",
			},
			{
				action: "describe_table",
				description: "Get column names and types for a table",
				parameters: Type.Object({
					table: Type.String({ description: "Table name" }),
					schema: Type.Optional(Type.String({ default: "public" })),
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
				case "query":
					return await this.runQuery(String(params.sql));
				case "list_tables": {
					const schema = String(params.schema ?? "public");
					if (!SAFE_IDENTIFIER.test(schema)) {
						return {
							success: false,
							error:
								"Invalid schema name. Only alphanumeric characters and underscores are allowed.",
						};
					}
					return await this.runQuery(
						`SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' ORDER BY table_name`,
					);
				}
				case "describe_table": {
					const schema = String(params.schema ?? "public");
					const table = String(params.table);
					if (!SAFE_IDENTIFIER.test(schema)) {
						return {
							success: false,
							error:
								"Invalid schema name. Only alphanumeric characters and underscores are allowed.",
						};
					}
					if (!SAFE_IDENTIFIER.test(table)) {
						return {
							success: false,
							error:
								"Invalid table name. Only alphanumeric characters and underscores are allowed.",
						};
					}
					return await this.runQuery(
						`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${table}' ORDER BY ordinal_position`,
					);
				}
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

	private async runQuery(sql: string): Promise<ConnectorResult> {
		const forbidden =
			/\b(DROP|DELETE|UPDATE|INSERT|ALTER|TRUNCATE|CREATE|GRANT|REVOKE)\b/i;
		if (forbidden.test(sql)) {
			return {
				success: false,
				error:
					"Only read-only queries are allowed. Use SELECT, SHOW, EXPLAIN, or information_schema queries.",
			};
		}

		// Return the connection string and SQL for the executor to run via psql.
		// The agent-runner will use bash tool with:
		//   psql "$CONNECTION_STRING" -c "SQL" --json
		// This connector returns a structured command instead.
		return {
			success: true,
			data: {
				_type: "psql_command",
				connectionString: this.connectionString,
				sql,
				hint: 'Execute via bash: psql "$CONNECTION_STRING" -t -A -F \',\' -c "SQL"',
			},
		};
	}
}
