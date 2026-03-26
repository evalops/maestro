/**
 * Connectors module - External service integrations for the Slack agent.
 */

export type {
	Connector,
	ConnectorAuthType,
	ConnectorCapability,
	ConnectorConfig,
	ConnectorCredentials,
	ConnectorFactory,
	ConnectorResult,
	ConnectorsConfig,
} from "./types.js";

export {
	createConnectorRegistry,
	registerConnectorFactory,
	getRegisteredTypes,
	type ConnectorRegistryInstance,
	type ConnectorRegistryOptions,
} from "./registry.js";

export { withMiddleware, type MiddlewareConfig } from "./middleware.js";

export {
	ConnectorManager,
	type ConnectorManagerConfig,
} from "./connector-manager.js";

export {
	WebhookTriggerManager,
	type WebhookTrigger,
	type WebhookTriggersConfig,
	type TriggerRunCallback,
} from "./webhook-triggers.js";

export {
	OAuthFlowManager,
	type OAuthFlowConfig,
	type OAuthFlowResult,
} from "./oauth-flow.js";

export { RestApiConnector } from "./providers/rest-api.js";
export { HubSpotConnector } from "./providers/hubspot.js";
export { StripeConnector } from "./providers/stripe.js";
export { GitHubConnector } from "./providers/github.js";
export { LinearConnector } from "./providers/linear.js";
export { NotionConnector } from "./providers/notion.js";
export { ZendeskConnector } from "./providers/zendesk.js";
export { PostgresConnector } from "./providers/postgres.js";

import { GitHubConnector } from "./providers/github.js";
import { HubSpotConnector } from "./providers/hubspot.js";
import { LinearConnector } from "./providers/linear.js";
import { NotionConnector } from "./providers/notion.js";
import { PostgresConnector } from "./providers/postgres.js";
import { RestApiConnector } from "./providers/rest-api.js";
import { StripeConnector } from "./providers/stripe.js";
import { ZendeskConnector } from "./providers/zendesk.js";
import { registerConnectorFactory } from "./registry.js";

let registered = false;

/**
 * Register all built-in connector factories. Safe to call multiple times;
 * subsequent calls are no-ops.
 */
export function registerBuiltInConnectors(): void {
	if (registered) return;
	registered = true;

	registerConnectorFactory("rest_api", () => new RestApiConnector());
	registerConnectorFactory("hubspot", () => new HubSpotConnector());
	registerConnectorFactory("stripe", () => new StripeConnector());
	registerConnectorFactory("github", () => new GitHubConnector());
	registerConnectorFactory("linear", () => new LinearConnector());
	registerConnectorFactory("notion", () => new NotionConnector());
	registerConnectorFactory("zendesk", () => new ZendeskConnector());
	registerConnectorFactory("postgres", () => new PostgresConnector());
}
