/**
 * Connector Manager - Slack-facing connector management.
 *
 * Handles `/connect`, `/disconnect`, `/connectors` commands from Slack,
 * walking users through setup interactively.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as logger from "../logger.js";
import { ensureDirSync } from "../utils/fs.js";
import type { CredentialManager } from "./credentials.js";
import { getRegisteredTypes } from "./registry.js";
import type {
	ConnectorAuthType,
	ConnectorCredentials,
	ConnectorsConfig,
} from "./types.js";

export interface ConnectorManagerConfig {
	workingDir: string;
	credentialManager: CredentialManager;
}

export class ConnectorManager {
	private workingDir: string;
	private credentialManager: CredentialManager;

	constructor(config: ConnectorManagerConfig) {
		this.workingDir = config.workingDir;
		this.credentialManager = config.credentialManager;
	}

	private getConfigPath(): string {
		return join(this.workingDir, "connectors.json");
	}

	private loadConfig(): ConnectorsConfig {
		const path = this.getConfigPath();
		if (!existsSync(path)) {
			return { connectors: [] };
		}
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as ConnectorsConfig;
		} catch {
			return { connectors: [] };
		}
	}

	private saveConfig(config: ConnectorsConfig): void {
		ensureDirSync(this.workingDir);
		writeFileSync(this.getConfigPath(), JSON.stringify(config, null, 2));
	}

	/**
	 * Return the connector type for an instance name (from connectors.json).
	 * Used by UI/API callers to infer the correct credential authType.
	 */
	getConnectorType(name: string): string | null {
		const config = this.loadConfig();
		return config.connectors.find((c) => c.name === name)?.type ?? null;
	}

	getAuthTypeForInstance(name: string): ConnectorAuthType {
		const type = this.getConnectorType(name);
		if (type === "postgres") return "connection_string";
		return "api_key";
	}

	/**
	 * Handle `/connect <type> <name>` command.
	 * Returns a response message for Slack.
	 */
	async handleConnect(args: string, userId: string): Promise<string> {
		const parts = args.trim().split(/\s+/);
		if (parts.length < 1 || !parts[0]) {
			const types = getRegisteredTypes();
			return [
				"*Available connector types:*",
				...types.map((t) => `  \`${t}\``),
				"",
				"Usage: `/connect <type> <name>`",
				"Example: `/connect hubspot production-hubspot`",
				"",
				"After connecting, set credentials with:",
				"`/connect-credentials <name> <secret>`",
				"For connectors requiring metadata (baseUrl, subdomain, etc.):",
				"`/connect-credentials <name> <secret> key1=val1 key2=val2`",
			].join("\n");
		}

		const type = parts[0];
		const name = parts[1] || type;
		const types = getRegisteredTypes();

		if (!types.includes(type)) {
			return `Unknown connector type: \`${type}\`. Available: ${types.map((t) => `\`${t}\``).join(", ")}`;
		}

		const config = this.loadConfig();
		const existing = config.connectors.find((c) => c.name === name);
		if (existing) {
			return `Connector \`${name}\` already exists (type: ${existing.type}). Use \`/disconnect ${name}\` first.`;
		}

		config.connectors.push({
			type,
			name,
			enabled: true,
		});
		this.saveConfig(config);

		logger.logInfo(`Connector added by ${userId}: ${name} (${type})`);

		return [
			`Connector \`${name}\` (${type}) added.`,
			"",
			"*Next step:* Set credentials:",
			`\`/connect-credentials ${name} <your-api-key-or-secret>\``,
			"",
			this.getCredentialHint(type, name),
			"",
			"_The connector will activate on the next message after credentials are set._",
		].join("\n");
	}

	/**
	 * Handle `/connect-credentials <name> <secret> [key=value...]` command.
	 */
	async handleSetCredentials(args: string, userId: string): Promise<string> {
		const parts = args.trim().split(/\s+/);
		if (parts.length < 2) {
			return "Usage: `/connect-credentials <name> <secret> [key1=val1 key2=val2]`";
		}

		const name = parts[0]!;
		const secret = parts[1]!;
		const metadata: Record<string, string> = {};

		for (let i = 2; i < parts.length; i++) {
			const [key, ...valParts] = parts[i]!.split("=");
			if (key && valParts.length > 0) {
				metadata[key] = valParts.join("=");
			}
		}

		const config = this.loadConfig();
		const entry = config.connectors.find((c) => c.name === name);
		if (!entry) {
			return `Connector \`${name}\` not found. Use \`/connect <type> ${name}\` first.`;
		}

		const authType = this.getAuthType(entry.type);

		const credentials: ConnectorCredentials = {
			type: authType,
			secret,
			metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
		};

		await this.credentialManager.set(name, credentials);

		logger.logInfo(`Credentials set by ${userId} for connector: ${name}`);

		return `Credentials saved for \`${name}\`. The connector will activate on the next message.`;
	}

	/**
	 * Handle `/disconnect <name>` command.
	 */
	async handleDisconnect(args: string, userId: string): Promise<string> {
		const name = args.trim();
		if (!name) {
			return "Usage: `/disconnect <name>`";
		}

		const config = this.loadConfig();
		const idx = config.connectors.findIndex((c) => c.name === name);
		if (idx === -1) {
			return `Connector \`${name}\` not found.`;
		}

		config.connectors.splice(idx, 1);
		this.saveConfig(config);
		await this.credentialManager.delete(name);

		logger.logInfo(`Connector removed by ${userId}: ${name}`);

		return `Connector \`${name}\` disconnected and credentials removed.`;
	}

	/**
	 * Handle `/connectors` command - list all connectors and their status.
	 */
	async handleList(): Promise<string> {
		const config = this.loadConfig();
		if (config.connectors.length === 0) {
			return [
				"_No connectors configured._",
				"",
				"Use `/connect <type> <name>` to add one.",
				`Available types: ${getRegisteredTypes()
					.map((t) => `\`${t}\``)
					.join(", ")}`,
			].join("\n");
		}

		const lines = ["*Configured Connectors:*"];
		for (const c of config.connectors) {
			const hasCreds = await this.credentialManager.exists(c.name);
			const status = !c.enabled
				? ":white_circle: disabled"
				: hasCreds
					? ":large_green_circle: ready"
					: ":yellow_circle: needs credentials";
			lines.push(`  ${status} \`${c.name}\` (${c.type})`);
		}
		lines.push(
			"",
			"Commands: `/connect`, `/disconnect <name>`, `/connect-credentials <name> <secret>`",
		);
		return lines.join("\n");
	}

	/**
	 * List connectors with structured status info (for API/UI).
	 */
	async listConnectors(): Promise<
		Array<{
			name: string;
			type: string;
			enabled: boolean;
			hasCredentials: boolean;
			status: "ready" | "needs_credentials" | "disabled";
		}>
	> {
		const config = this.loadConfig();
		const results = [];
		for (const c of config.connectors) {
			const hasCreds = await this.credentialManager.exists(c.name);
			results.push({
				name: c.name,
				type: c.type,
				enabled: c.enabled,
				hasCredentials: hasCreds,
				status: (!c.enabled
					? "disabled"
					: hasCreds
						? "ready"
						: "needs_credentials") as
					| "ready"
					| "needs_credentials"
					| "disabled",
			});
		}
		return results;
	}

	/**
	 * Add a connector — structured result for programmatic callers (API server).
	 */
	async addConnector(
		type: string,
		name: string,
		userId: string,
	): Promise<{ ok: boolean; error?: string }> {
		const types = getRegisteredTypes();
		if (!types.includes(type)) {
			return { ok: false, error: `Unknown connector type: ${type}` };
		}
		const config = this.loadConfig();
		if (config.connectors.find((c) => c.name === name)) {
			return { ok: false, error: `Connector "${name}" already exists` };
		}
		config.connectors.push({ type, name, enabled: true });
		this.saveConfig(config);
		logger.logInfo(`Connector added by ${userId}: ${name} (${type})`);
		return { ok: true };
	}

	/**
	 * Remove a connector — structured result for programmatic callers (API server).
	 */
	async removeConnector(
		name: string,
		userId: string,
	): Promise<{ ok: boolean; error?: string }> {
		const config = this.loadConfig();
		const idx = config.connectors.findIndex((c) => c.name === name);
		if (idx === -1) {
			return { ok: false, error: `Connector "${name}" not found` };
		}
		config.connectors.splice(idx, 1);
		this.saveConfig(config);
		await this.credentialManager.delete(name);
		logger.logInfo(`Connector removed by ${userId}: ${name}`);
		return { ok: true };
	}

	/**
	 * Set credentials — structured result for programmatic callers (API server).
	 */
	async setCredentials(
		name: string,
		credentials: ConnectorCredentials,
		userId: string,
	): Promise<{ ok: boolean; error?: string }> {
		const config = this.loadConfig();
		const entry = config.connectors.find((c) => c.name === name);
		if (!entry) {
			return { ok: false, error: `Connector "${name}" not found` };
		}
		await this.credentialManager.set(name, credentials);
		logger.logInfo(`Credentials set by ${userId} for connector: ${name}`);
		return { ok: true };
	}

	private getAuthType(type: string): "api_key" | "oauth" | "connection_string" {
		if (type === "postgres") return "connection_string";
		return "api_key";
	}

	private getCredentialHint(type: string, name: string): string {
		switch (type) {
			case "hubspot":
				return `For HubSpot, use a Private App token from Settings > Integrations > Private Apps.\n\`/connect-credentials ${name} pat-xxx\``;
			case "stripe":
				return `For Stripe, use a Secret Key from Developers > API Keys.\n\`/connect-credentials ${name} sk_live_xxx\``;
			case "github":
				return `For GitHub, use a Personal Access Token (classic or fine-grained).\n\`/connect-credentials ${name} ghp_xxx\``;
			case "linear":
				return `For Linear, create an API key in Settings > API.\n\`/connect-credentials ${name} lin_api_xxx\``;
			case "notion":
				return `For Notion, create an Internal Integration at notion.so/my-integrations.\n\`/connect-credentials ${name} secret_xxx\``;
			case "zendesk":
				return `For Zendesk, provide your API token and subdomain.\n\`/connect-credentials ${name} your-api-token subdomain=your-company email=admin@example.com\``;
			case "postgres":
				return `For PostgreSQL, provide the connection string.\n\`/connect-credentials ${name} <your-connection-string>\``;
			case "rest_api":
				return `For REST API, provide the API key and base URL.\n\`/connect-credentials ${name} your-api-key baseUrl=https://api.example.com\``;
			default:
				return `Provide the API key or secret for this connector.\n\`/connect-credentials ${name} <secret>\``;
		}
	}
}
