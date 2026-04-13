import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetFeatureFlagCacheForTests } from "../../src/config/feature-flags.js";
import { getModel } from "../../src/models/builtin.js";
import {
	ALL_EVALOPS_MANAGED_PROVIDER_DEFINITIONS,
	getEvalOpsManagedProviderDefinition,
	getEvalOpsManagedProviderDefinitions,
} from "../../src/providers/evalops-managed.js";
import {
	apiKeyManagedGatewayAliasDefinitions,
	managedGatewayAliasDefinitions,
} from "../testing/evalops-managed.js";

describe("EvalOps managed provider registry", () => {
	afterEach(() => {
		Reflect.deleteProperty(process.env, "EVALOPS_FEATURE_FLAGS_PATH");
		resetFeatureFlagCacheForTests();
	});

	it("normalizes provider lookup by case and whitespace", () => {
		const definition = getEvalOpsManagedProviderDefinition(
			"  EVALOPS-TOGETHER  ",
		);

		expect(definition?.id).toBe("evalops-together");
	});

	it("keeps alias subsets aligned with the full registry", () => {
		expect(managedGatewayAliasDefinitions).toHaveLength(
			ALL_EVALOPS_MANAGED_PROVIDER_DEFINITIONS.length - 1,
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
		const ids = ALL_EVALOPS_MANAGED_PROVIDER_DEFINITIONS.map(
			(definition) => definition.id,
		);
		const providerRefs = ALL_EVALOPS_MANAGED_PROVIDER_DEFINITIONS.map(
			(definition) => definition.providerRefProvider,
		);

		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(providerRefs).size).toBe(providerRefs.length);
	});

	it("keeps every managed default model resolvable for both source and alias providers", () => {
		for (const definition of ALL_EVALOPS_MANAGED_PROVIDER_DEFINITIONS) {
			expect(
				getModel(definition.sourceProvider, definition.defaultModel),
			).toBeTruthy();
			expect(getModel(definition.id, definition.defaultModel)).toBeTruthy();
		}
	});

	it("returns no managed providers when the kill switch is enabled", () => {
		const path = join(
			tmpdir(),
			`maestro-managed-provider-flags-${Date.now()}-${Math.random()}.json`,
		);
		writeFileSync(
			path,
			JSON.stringify({
				flags: [
					{
						key: "platform.kill_switches.maestro.evalops_managed",
						enabled: true,
					},
				],
			}),
		);
		process.env.EVALOPS_FEATURE_FLAGS_PATH = path;
		resetFeatureFlagCacheForTests();

		expect(getEvalOpsManagedProviderDefinitions()).toEqual([]);
		expect(getEvalOpsManagedProviderDefinition("evalops")).toBeUndefined();
	});
});
