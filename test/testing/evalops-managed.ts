import {
	EVALOPS_MANAGED_PROVIDER_DEFINITIONS,
	type EvalOpsManagedProviderDefinition,
} from "../../src/providers/evalops-managed.js";

export const managedGatewayAliasDefinitions: readonly EvalOpsManagedProviderDefinition[] =
	EVALOPS_MANAGED_PROVIDER_DEFINITIONS.filter(
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
		return "http://127.0.0.1:8081/v1/messages";
	}
	if (api === "openai-responses") {
		return "http://127.0.0.1:8081/v1/responses";
	}
	return "http://127.0.0.1:8081/v1/chat/completions";
}
