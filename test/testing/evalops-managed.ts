import {
	ALL_EVALOPS_MANAGED_PROVIDER_DEFINITIONS,
	DEFAULT_EVALOPS_MANAGED_GATEWAY_BASE_URL,
	type EvalOpsManagedProviderDefinition,
} from "../../src/providers/evalops-managed.js";

export const managedGatewayAliasDefinitions: readonly EvalOpsManagedProviderDefinition[] =
	ALL_EVALOPS_MANAGED_PROVIDER_DEFINITIONS.filter(
		(definition) => definition.id !== "evalops",
	);

export const apiKeyManagedGatewayAliasDefinitions: readonly EvalOpsManagedProviderDefinition[] =
	managedGatewayAliasDefinitions.filter(
		(definition) => !definition.usesAnthropicOAuth,
	);

export function expectedManagedGatewayModelAPI(
	definition: EvalOpsManagedProviderDefinition,
): string {
	if (definition.id === "evalops-openrouter") {
		return "openai-responses";
	}
	return definition.api;
}

export function expectedManagedGatewayModelBaseURL(
	definition: EvalOpsManagedProviderDefinition,
): string {
	const api = expectedManagedGatewayModelAPI(definition);
	if (api === "anthropic-messages") {
		return `${DEFAULT_EVALOPS_MANAGED_GATEWAY_BASE_URL}/messages`;
	}
	if (api === "openai-responses") {
		return `${DEFAULT_EVALOPS_MANAGED_GATEWAY_BASE_URL}/responses`;
	}
	return `${DEFAULT_EVALOPS_MANAGED_GATEWAY_BASE_URL}/chat/completions`;
}
