import { afterEach, describe, expect, it } from "vitest";
import {
	getEnvVarsForProvider,
	lookupApiKey,
} from "../../src/providers/api-keys.js";
import { apiKeyManagedGatewayAliasDefinitions } from "../testing/evalops-managed.js";

describe("api key provider families", () => {
	const originalEvalOpsAccessToken = process.env.MAESTRO_EVALOPS_ACCESS_TOKEN;

	afterEach(() => {
		if (originalEvalOpsAccessToken === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_EVALOPS_ACCESS_TOKEN");
		} else {
			process.env.MAESTRO_EVALOPS_ACCESS_TOKEN = originalEvalOpsAccessToken;
		}
	});

	it("maps managed evalops provider aliases to evalops env vars", () => {
		for (const definition of apiKeyManagedGatewayAliasDefinitions) {
			expect(getEnvVarsForProvider(definition.id)).toEqual([
				"MAESTRO_EVALOPS_ACCESS_TOKEN",
			]);
		}
	});

	for (const definition of apiKeyManagedGatewayAliasDefinitions) {
		it(`resolves ${definition.id} credentials from MAESTRO_EVALOPS_ACCESS_TOKEN`, () => {
			process.env.MAESTRO_EVALOPS_ACCESS_TOKEN = "managed-token";
			const credential = lookupApiKey(definition.id);
			expect(credential.key).toBe("managed-token");
			expect(credential.envVar).toBe("MAESTRO_EVALOPS_ACCESS_TOKEN");
			expect(credential.source).toBe("env");
		});
	}
});
