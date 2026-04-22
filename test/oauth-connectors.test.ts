import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const testDir = join(tmpdir(), `maestro-oauth-connectors-${Date.now()}`);

import {
	clearOAuthProviderSourceOfTruthPolicy,
	configureOAuthProviderSourceOfTruthPolicy,
	normalizeConnectorSourceOfTruthArea,
} from "../src/oauth/connectors.js";
import {
	loadOAuthCredentials,
	saveOAuthCredentials,
} from "../src/oauth/storage.js";

describe("OAuth connector source-of-truth metadata", () => {
	beforeEach(() => {
		process.env.MAESTRO_AGENT_DIR = join(testDir, "agent");
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("normalizes local and enum source-of-truth area names", () => {
		expect(normalizeConnectorSourceOfTruthArea("crm")).toBe("crm");
		expect(
			normalizeConnectorSourceOfTruthArea("SOURCE_OF_TRUTH_AREA_ANALYTICS"),
		).toBe("analytics");
		expect(normalizeConnectorSourceOfTruthArea("finance")).toBeNull();
	});

	it("configures source-of-truth metadata for a stored provider", async () => {
		saveOAuthCredentials("openai", {
			type: "oauth",
			access: "openai-access",
			refresh: "openai-refresh",
			expires: Date.now() + 3_600_000,
			metadata: {
				scopes: ["model.read"],
				sourceOfTruthArea: "analytics",
			},
		});

		const configured = await configureOAuthProviderSourceOfTruthPolicy(
			"openai",
			{
				area: "crm",
				fallbackConnectionId: "conn_crm_fallback",
			},
		);

		expect(configured).toMatchObject({
			provider: "openai",
			area: "crm",
			fallbackConnectionId: "conn_crm_fallback",
		});
		expect(loadOAuthCredentials("openai")?.metadata).toMatchObject({
			scopes: ["model.read"],
			connectorSourceOfTruthArea: "crm",
			connectorSourceOfTruthFallbackConnectionId: "conn_crm_fallback",
		});
		expect(loadOAuthCredentials("openai")?.metadata).not.toHaveProperty(
			"sourceOfTruthArea",
		);
	});

	it("rejects unsupported source-of-truth areas before changing credentials", async () => {
		saveOAuthCredentials("openai", {
			type: "oauth",
			access: "openai-access",
			refresh: "openai-refresh",
			expires: Date.now() + 3_600_000,
			metadata: { connectorSourceOfTruthArea: "analytics" },
		});

		await expect(
			configureOAuthProviderSourceOfTruthPolicy("openai", {
				area: "finance",
			}),
		).rejects.toThrow("Unsupported source-of-truth area");
		expect(loadOAuthCredentials("openai")?.metadata).toMatchObject({
			connectorSourceOfTruthArea: "analytics",
		});
	});

	it("clears local source-of-truth policy metadata", () => {
		saveOAuthCredentials("openai", {
			type: "oauth",
			access: "openai-access",
			refresh: "openai-refresh",
			expires: Date.now() + 3_600_000,
			metadata: {
				connectorConnectionId: "conn_openai",
				connectorSourceOfTruthArea: "crm",
				connectorSourceOfTruthFallbackConnectionId: "conn_fallback",
				connectorSourceOfTruthPrimaryConnectionId: "conn_openai",
				connectorSourceOfTruthWorkspaceId: "org_123",
			},
		});

		expect(clearOAuthProviderSourceOfTruthPolicy("openai")).toBe(true);
		expect(loadOAuthCredentials("openai")?.metadata).toEqual({
			connectorConnectionId: "conn_openai",
		});
		expect(clearOAuthProviderSourceOfTruthPolicy("openai")).toBe(false);
	});
});
