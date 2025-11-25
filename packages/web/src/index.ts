/**
 * Composer Web UI - Entry Point
 *
 * Browser-based interface for Composer AI coding assistant.
 */

// Register all web components
import "./components/composer-chat.js";
import "./components/composer-message.js";
import "./components/composer-input.js";
import "./components/model-selector.js";
import "./components/composer-settings.js";
import "./components/composer-tool-execution.js";
import "./components/composer-thinking.js";
import "./components/composer-approval.js";
import "./components/admin-settings.js";

// Export components for programmatic use
export { ComposerChat } from "./components/composer-chat.js";
export { ComposerMessage } from "./components/composer-message.js";
export { ComposerInput } from "./components/composer-input.js";
export { ModelSelector } from "./components/model-selector.js";
export { ComposerSettings } from "./components/composer-settings.js";
export { ComposerToolExecution } from "./components/composer-tool-execution.js";
export { ComposerThinking } from "./components/composer-thinking.js";
export { ComposerApproval } from "./components/composer-approval.js";
export { AdminSettings } from "./components/admin-settings.js";

// Export services
export { ApiClient } from "./services/api-client.js";
export type {
	Message,
	Model,
	ChatRequest,
	ChatResponse,
} from "./services/api-client.js";

// Export enterprise services
export {
	EnterpriseApiClient,
	getEnterpriseApi,
} from "./services/enterprise-api.js";
export type {
	User,
	Organization,
	OrganizationSettings,
	Role,
	OrgMember,
	UsageQuota,
	OrgUsageSummary,
	AuditLog,
	Alert,
	ModelApproval,
	DirectoryRule,
} from "./services/enterprise-api.js";
