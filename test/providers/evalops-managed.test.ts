import { describe, expect, it } from "vitest";
import { getModel } from "../../src/models/builtin.js";
import {
	EVALOPS_MANAGED_PROVIDER_DEFINITIONS,
	getEvalOpsManagedProviderDefinition,
} from "../../src/providers/evalops-managed.js";
import {
	apiKeyManagedGatewayAliasDefinitions,
	managedGatewayAliasDefinitions,
} from "../testing/evalops-managed.js";

describe("EvalOps managed provider registry", () => {
	it("normalizes provider lookup by case and whitespace", () => {
		const definition = getEvalOpsManagedProviderDefinition(
			"  EVALOPS-TOGETHER  ",
		);

		expect(definition?.id).toBe("evalops-together");
	});

	it("keeps alias subsets aligned with the full registry", () => {
		expect(managedGatewayAliasDefinitions).toHaveLength(
			EVALOPS_MANAGED_PROVIDER_DEFINITIONS.length - 1,
		);
		expect(
			managedGatewayAliasDefinitions.every(
				(definition) => definition.id !== "evalops",
			),
		).toBe(true);
		expect(
			apiKeyManagedGatewayAliasDefinitions.every(
				(definition) => !definition.usesAnthropicOAuth,
			),
		).toBe(true);
	});

	it("uses unique ids and provider ref providers", () => {
		const ids = EVALOPS_MANAGED_PROVIDER_DEFINITIONS.map(
			(definition) => definition.id,
		);
		const providerRefs = EVALOPS_MANAGED_PROVIDER_DEFINITIONS.map(
			(definition) => definition.providerRefProvider,
		);

		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(providerRefs).size).toBe(providerRefs.length);
	});

	it("keeps every managed default model resolvable for both source and alias providers", () => {
		for (const definition of EVALOPS_MANAGED_PROVIDER_DEFINITIONS) {
			expect(
				getModel(definition.sourceProvider, definition.defaultModel),
			).toBeTruthy();
			expect(getModel(definition.id, definition.defaultModel)).toBeTruthy();
		}
	});
});
