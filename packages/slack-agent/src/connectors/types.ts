/**
 * Connector Types - Defines the interface for external service integrations.
 *
 * Connectors provide the agent with read/write access to external SaaS tools
 * (CRMs, data warehouses, billing systems, etc.) via a unified interface.
 */

import type { TSchema } from "@sinclair/typebox";

/**
 * Authentication method for a connector.
 */
export type ConnectorAuthType = "api_key" | "oauth" | "connection_string";

/**
 * Stored credentials for a connector instance.
 */
export interface ConnectorCredentials {
	type: ConnectorAuthType;
	/** API key, OAuth token, or connection string */
	secret: string;
	/** Additional auth fields (e.g., refresh token, base URL) */
	metadata?: Record<string, string>;
}

/**
 * A single action a connector can perform.
 */
export interface ConnectorCapability {
	/** Unique action name within the connector (e.g., "search_deals", "run_query") */
	action: string;
	/** Human-readable description for the LLM to understand what this does */
	description: string;
	/** TypeBox schema defining the action's parameters */
	parameters: TSchema;
	/** Whether this action reads, writes, or deletes data */
	category: "read" | "write" | "delete";
}

/**
 * Result from executing a connector action.
 */
export interface ConnectorResult {
	success: boolean;
	data?: unknown;
	error?: string;
}

/**
 * A connector provides access to an external service.
 */
export interface Connector {
	/** Unique identifier (e.g., "hubspot", "snowflake", "stripe") */
	readonly name: string;
	/** Human-readable display name */
	readonly displayName: string;
	/** Authentication type required */
	readonly authType: ConnectorAuthType;
	/** Short description of what this connector does */
	readonly description: string;

	/** Connect to the service with the given credentials */
	connect(credentials: ConnectorCredentials): Promise<void>;
	/** Disconnect and clean up resources */
	disconnect(): Promise<void>;
	/** Check if the connection is healthy */
	healthCheck(): Promise<boolean>;
	/** Get available capabilities */
	getCapabilities(): ConnectorCapability[];
	/** Execute an action */
	execute(
		action: string,
		params: Record<string, unknown>,
	): Promise<ConnectorResult>;
}

/**
 * Factory function type for creating connector instances.
 */
export type ConnectorFactory = () => Connector;

/**
 * Persisted connector configuration (stored in connectors.json).
 */
export interface ConnectorConfig {
	/** Connector type name (e.g., "rest_api", "hubspot") */
	type: string;
	/** Instance name (e.g., "production-hubspot", "analytics-db") */
	name: string;
	/** Whether this connector is enabled */
	enabled: boolean;
	/** Connector-specific settings (e.g., base URL for REST API) */
	settings?: Record<string, unknown>;
}

/**
 * Top-level connectors configuration file structure.
 */
export interface ConnectorsConfig {
	connectors: ConnectorConfig[];
}
