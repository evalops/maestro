/**
 * Connector Registry - Manages connector lifecycle and generates agent tools.
 *
 * The registry:
 * 1. Loads connector configs from `connectors.json` in the working directory
 * 2. Loads credentials from the StorageBackend
 * 3. Instantiates and connects connectors
 * 4. Generates AgentTool instances from connector capabilities
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AuditLogger } from "../audit.js";
import type { AgentTool } from "../tools/index.js";
import { type MiddlewareConfig, withMiddleware } from "./middleware.js";
import type {
	Connector,
	ConnectorCapability,
	ConnectorConfig,
	ConnectorCredentials,
	ConnectorFactory,
	ConnectorsConfig,
} from "./types.js";

/** Prefix for connector tool names: connector_<name>_<action> */
const TOOL_PREFIX = "connector";

/**
 * Registry for connector factories. Register a factory before loading configs.
 */
const factories = new Map<string, ConnectorFactory>();

export function registerConnectorFactory(
	type: string,
	factory: ConnectorFactory,
): void {
	factories.set(type, factory);
}

export function getRegisteredTypes(): string[] {
	return Array.from(factories.keys());
}

export interface ConnectorRegistryOptions {
	workingDir: string;
	/** Function to retrieve stored credentials for a connector instance */
	getCredentials: (name: string) => Promise<ConnectorCredentials | null>;
	/** Middleware configuration for all connectors (caching, truncation, rate limiting) */
	middleware?: MiddlewareConfig;
	/** Audit logger for connector action logging */
	auditLogger?: AuditLogger;
	/** Restrict generated tools to these capability categories (default: all). */
	allowedCategories?: Array<ConnectorCapability["category"]>;
}

export interface ConnectorRegistryInstance {
	/** All active connectors */
	connectors: Map<string, Connector>;
	/** Generated agent tools for all connected connectors */
	tools: AgentTool[];
	/** Shut down all connectors */
	dispose(): Promise<void>;
	/** Get a short description of connected systems for the system prompt */
	describeForPrompt(): string;
}

/**
 * Load connectors.json, instantiate connectors, connect them, and generate tools.
 */
export async function createConnectorRegistry(
	options: ConnectorRegistryOptions,
): Promise<ConnectorRegistryInstance> {
	const configPath = join(options.workingDir, "connectors.json");
	const connectors = new Map<string, Connector>();
	const tools: AgentTool[] = [];

	if (!existsSync(configPath)) {
		return {
			connectors,
			tools,
			dispose: async () => {},
			describeForPrompt: () => "",
		};
	}

	let config: ConnectorsConfig;
	try {
		const raw = readFileSync(configPath, "utf-8");
		config = JSON.parse(raw) as ConnectorsConfig;
	} catch (error) {
		console.error(
			`Failed to parse connectors.json: ${error instanceof Error ? error.message : String(error)}`,
		);
		return {
			connectors,
			tools,
			dispose: async () => {},
			describeForPrompt: () => "",
		};
	}

	const allowedCategories = options.allowedCategories?.length
		? new Set(options.allowedCategories)
		: null;

	for (const entry of config.connectors) {
		if (!entry.enabled) continue;

		const factory = factories.get(entry.type);
		if (!factory) {
			console.error(
				`Unknown connector type: ${entry.type} (instance: ${entry.name})`,
			);
			continue;
		}

		const connector = factory();
		const credentials = await options.getCredentials(entry.name);
		if (!credentials) {
			console.error(
				`No credentials found for connector: ${entry.name} (type: ${entry.type})`,
			);
			continue;
		}

		try {
			await connector.connect(credentials);
			const healthy = await connector.healthCheck();
			if (!healthy) {
				console.error(`Connector health check failed: ${entry.name}`);
				await connector.disconnect();
				continue;
			}

			connectors.set(entry.name, connector);

			const connectorTools = generateToolsForConnector(
				entry.name,
				connector,
				entry.settings,
				options.middleware
					? { ...options.middleware, auditLogger: options.auditLogger }
					: undefined,
				allowedCategories,
			);
			tools.push(...connectorTools);

			console.log(
				`Connected: ${entry.name} (${entry.type}) - ${connectorTools.length} tools`,
			);
		} catch (error) {
			console.error(
				`Failed to connect ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return {
		connectors,
		tools,
		dispose: async () => {
			for (const [name, connector] of connectors) {
				try {
					await connector.disconnect();
				} catch (error) {
					console.error(
						`Error disconnecting ${name}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			connectors.clear();
		},
		describeForPrompt: () => {
			if (connectors.size === 0) return "";
			const lines = ["## Connected Systems"];
			const readOnly =
				allowedCategories &&
				allowedCategories.size > 0 &&
				allowedCategories.has("read") &&
				!allowedCategories.has("write") &&
				!allowedCategories.has("delete");
			for (const [name, connector] of connectors) {
				const caps = connector.getCapabilities();
				const visible = allowedCategories
					? caps.filter((c) => allowedCategories.has(c.category))
					: caps;
				const reads = visible.filter((c) => c.category === "read").length;
				const writes = visible.filter((c) => c.category !== "read").length;
				lines.push(
					`- **${name}** (${connector.displayName}): ${reads} read, ${writes} write actions`,
				);
			}
			lines.push(
				"",
				readOnly
					? "Use connector tools to query data in these systems (read-only)."
					: "Use connector tools to query and modify data in these systems.",
				`Tool naming: ${TOOL_PREFIX}_<system>_<action>`,
			);
			return lines.join("\n");
		},
	};
}

/**
 * Generate AgentTool instances from a connector's capabilities.
 */
function generateToolsForConnector(
	instanceName: string,
	connector: Connector,
	_settings?: Record<string, unknown>,
	middlewareConfig?: MiddlewareConfig,
	allowedCategories?: Set<ConnectorCapability["category"]> | null,
): AgentTool[] {
	const capabilities = connector.getCapabilities();
	const filteredCapabilities = allowedCategories
		? capabilities.filter((c) => allowedCategories.has(c.category))
		: capabilities;
	const execute = middlewareConfig
		? withMiddleware(connector, instanceName, middlewareConfig)
		: (action: string, params: Record<string, unknown>) =>
				connector.execute(action, params);

	return filteredCapabilities.map((cap) => {
		const toolName = `${TOOL_PREFIX}_${instanceName}_${cap.action}`;

		const wrappedParams = Type.Object({
			label: Type.String({
				description: "Brief description shown to user",
			}),
			params: cap.parameters,
		});

		return {
			name: toolName,
			label: toolName,
			description: `[${connector.displayName}] ${cap.description}`,
			parameters: wrappedParams,
			execute: async (_toolCallId: string, args: Record<string, unknown>) => {
				const params = (args.params ?? {}) as Record<string, unknown>;
				const result = await execute(cap.action, params);

				if (!result.success) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: ${result.error ?? "Unknown error"}`,
							},
						],
					};
				}

				const text =
					typeof result.data === "string"
						? result.data
						: JSON.stringify(result.data, null, 2);

				return {
					content: [{ type: "text" as const, text }],
					details: result.data,
				};
			},
		};
	});
}
