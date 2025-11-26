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

// Export components for programmatic use
export { ComposerChat } from "./components/composer-chat.js";
export { ComposerMessage } from "./components/composer-message.js";
export { ComposerInput } from "./components/composer-input.js";
export { ModelSelector } from "./components/model-selector.js";

// Export services
export { ApiClient } from "./services/api-client.js";
export type {
	Message,
	Model,
	ChatRequest,
	ChatResponse,
} from "./services/api-client.js";
