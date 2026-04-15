/**
 * Tests for the connector framework: types, registry, REST API connector, and deploy tool.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createConnectorRegistry,
	getRegisteredTypes,
	registerBuiltInConnectors,
	registerConnectorFactory,
} from "../../packages/slack-agent/src/connectors/index.js";

registerBuiltInConnectors();
import type {
	Connector,
	ConnectorCapability,
	ConnectorCredentials,
	ConnectorResult,
} from "../../packages/slack-agent/src/connectors/types.js";

describe("connector types", () => {
	it("ConnectorCredentials shape is valid", () => {
		const creds: ConnectorCredentials = {
			type: "api_key",
			secret: "test-key",
			metadata: { baseUrl: "https://api.example.com" },
		};
		expect(creds.type).toBe("api_key");
		expect(creds.secret).toBe("test-key");
		expect(creds.metadata?.baseUrl).toBe("https://api.example.com");
	});

	it("ConnectorCapability shape is valid", () => {
		const cap: ConnectorCapability = {
			action: "get_users",
			description: "Fetch users",
			parameters: Type.Object({ limit: Type.Number() }),
			category: "read",
		};
		expect(cap.action).toBe("get_users");
		expect(cap.category).toBe("read");
	});
});

describe("connector registry", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`connector-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("returns empty registry when connectors.json is missing", async () => {
		const registry = await createConnectorRegistry({
			workingDir: testDir,
			getCredentials: async () => null,
		});

		expect(registry.connectors.size).toBe(0);
		expect(registry.tools.length).toBe(0);
		expect(registry.describeForPrompt()).toBe("");
	});

	it("returns empty registry when connectors.json is invalid JSON", async () => {
		writeFileSync(join(testDir, "connectors.json"), "not json");

		const registry = await createConnectorRegistry({
			workingDir: testDir,
			getCredentials: async () => null,
		});

		expect(registry.connectors.size).toBe(0);
	});

	it("skips disabled connectors", async () => {
		writeFileSync(
			join(testDir, "connectors.json"),
			JSON.stringify({
				connectors: [
					{ type: "test_connector", name: "disabled-one", enabled: false },
				],
			}),
		);

		const registry = await createConnectorRegistry({
			workingDir: testDir,
			getCredentials: async () => ({
				type: "api_key" as const,
				secret: "test",
			}),
		});

		expect(registry.connectors.size).toBe(0);
	});

	it("skips connectors with unknown type", async () => {
		writeFileSync(
			join(testDir, "connectors.json"),
			JSON.stringify({
				connectors: [
					{
						type: "nonexistent_connector",
						name: "broken",
						enabled: true,
					},
				],
			}),
		);

		const registry = await createConnectorRegistry({
			workingDir: testDir,
			getCredentials: async () => ({
				type: "api_key" as const,
				secret: "test",
			}),
		});

		expect(registry.connectors.size).toBe(0);
	});

	it("skips connectors without credentials", async () => {
		registerConnectorFactory("test_nocred", () => createMockConnector());

		writeFileSync(
			join(testDir, "connectors.json"),
			JSON.stringify({
				connectors: [{ type: "test_nocred", name: "no-creds", enabled: true }],
			}),
		);

		const registry = await createConnectorRegistry({
			workingDir: testDir,
			getCredentials: async () => null,
		});

		expect(registry.connectors.size).toBe(0);
	});

	it("connects and generates tools for a valid connector", async () => {
		registerConnectorFactory("test_valid", () => createMockConnector());

		writeFileSync(
			join(testDir, "connectors.json"),
			JSON.stringify({
				connectors: [{ type: "test_valid", name: "my-service", enabled: true }],
			}),
		);

		const registry = await createConnectorRegistry({
			workingDir: testDir,
			getCredentials: async () => ({
				type: "api_key" as const,
				secret: "test-key",
				metadata: { baseUrl: "https://example.com" },
			}),
		});

		expect(registry.connectors.size).toBe(1);
		expect(registry.connectors.has("my-service")).toBe(true);
		// Mock connector has 1 capability -> 1 tool
		expect(registry.tools.length).toBe(1);
		expect(registry.tools[0]!.name).toBe("connector_my-service_test_action");
	});

	it("generates correct tool descriptions", async () => {
		registerConnectorFactory("test_desc", () => createMockConnector());

		writeFileSync(
			join(testDir, "connectors.json"),
			JSON.stringify({
				connectors: [{ type: "test_desc", name: "desc-test", enabled: true }],
			}),
		);

		const registry = await createConnectorRegistry({
			workingDir: testDir,
			getCredentials: async () => ({
				type: "api_key" as const,
				secret: "k",
			}),
		});

		const tool = registry.tools[0]!;
		expect(tool.description).toContain("Mock Connector");
		expect(tool.description).toContain("A test action");
	});

	it("tool execute calls connector.execute", async () => {
		const mock = createMockConnector();
		registerConnectorFactory("test_exec", () => mock);

		writeFileSync(
			join(testDir, "connectors.json"),
			JSON.stringify({
				connectors: [{ type: "test_exec", name: "exec-test", enabled: true }],
			}),
		);

		const registry = await createConnectorRegistry({
			workingDir: testDir,
			getCredentials: async () => ({
				type: "api_key" as const,
				secret: "k",
			}),
		});

		const tool = registry.tools[0]!;
		const result = await tool.execute("call-1", {
			label: "test",
			params: { key: "value" },
		});

		expect(result.content[0]!.type).toBe("text");
		expect((result.content[0] as { text: string }).text).toContain("mock data");
	});

	it("tool execute returns error text on failure", async () => {
		const mock = createMockConnector({ failExecute: true });
		registerConnectorFactory("test_fail", () => mock);

		writeFileSync(
			join(testDir, "connectors.json"),
			JSON.stringify({
				connectors: [{ type: "test_fail", name: "fail-test", enabled: true }],
			}),
		);

		const registry = await createConnectorRegistry({
			workingDir: testDir,
			getCredentials: async () => ({
				type: "api_key" as const,
				secret: "k",
			}),
		});

		const tool = registry.tools[0]!;
		const result = await tool.execute("call-2", {
			label: "test",
			params: {},
		});

		expect((result.content[0] as { text: string }).text).toContain("Error:");
	});

	it("describeForPrompt returns system descriptions", async () => {
		registerConnectorFactory("test_prompt", () => createMockConnector());

		writeFileSync(
			join(testDir, "connectors.json"),
			JSON.stringify({
				connectors: [
					{ type: "test_prompt", name: "prompt-test", enabled: true },
				],
			}),
		);

		const registry = await createConnectorRegistry({
			workingDir: testDir,
			getCredentials: async () => ({
				type: "api_key" as const,
				secret: "k",
			}),
		});

		const description = registry.describeForPrompt();
		expect(description).toContain("Connected Systems");
		expect(description).toContain("prompt-test");
		expect(description).toContain("Mock Connector");
	});

	it("dispose disconnects all connectors", async () => {
		const mock = createMockConnector();
		registerConnectorFactory("test_dispose", () => mock);

		writeFileSync(
			join(testDir, "connectors.json"),
			JSON.stringify({
				connectors: [
					{ type: "test_dispose", name: "dispose-test", enabled: true },
				],
			}),
		);

		const registry = await createConnectorRegistry({
			workingDir: testDir,
			getCredentials: async () => ({
				type: "api_key" as const,
				secret: "k",
			}),
		});

		expect(registry.connectors.size).toBe(1);
		await registry.dispose();
		expect(registry.connectors.size).toBe(0);
	});

	it("skips connectors that fail health check", async () => {
		registerConnectorFactory("test_unhealthy", () =>
			createMockConnector({ failHealthCheck: true }),
		);

		writeFileSync(
			join(testDir, "connectors.json"),
			JSON.stringify({
				connectors: [
					{
						type: "test_unhealthy",
						name: "unhealthy-test",
						enabled: true,
					},
				],
			}),
		);

		const registry = await createConnectorRegistry({
			workingDir: testDir,
			getCredentials: async () => ({
				type: "api_key" as const,
				secret: "k",
			}),
		});

		expect(registry.connectors.size).toBe(0);
	});
});

describe("getRegisteredTypes", () => {
	it("includes rest_api by default", () => {
		// Importing the connectors/index.ts module registers rest_api
		const types = getRegisteredTypes();
		expect(types).toContain("rest_api");
	});
});

// --- helpers ---

function createMockConnector(opts?: {
	failHealthCheck?: boolean;
	failExecute?: boolean;
}): Connector {
	let connected = false;

	return {
		name: "mock",
		displayName: "Mock Connector",
		authType: "api_key",
		description: "A mock connector for testing",

		async connect(_credentials: ConnectorCredentials) {
			connected = true;
		},

		async disconnect() {
			connected = false;
		},

		async healthCheck() {
			if (opts?.failHealthCheck) return false;
			return connected;
		},

		getCapabilities(): ConnectorCapability[] {
			return [
				{
					action: "test_action",
					description: "A test action",
					parameters: Type.Object({
						key: Type.Optional(Type.String()),
					}),
					category: "read",
				},
			];
		},

		async execute(
			_action: string,
			_params: Record<string, unknown>,
		): Promise<ConnectorResult> {
			if (opts?.failExecute) {
				return { success: false, error: "Mock execution failed" };
			}
			return { success: true, data: "mock data" };
		},
	};
}
