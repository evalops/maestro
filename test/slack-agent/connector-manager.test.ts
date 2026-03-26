/**
 * Tests for ConnectorManager (Slack-facing /connect commands).
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectorManager } from "../../packages/slack-agent/src/connectors/connector-manager.js";
import { CredentialManager } from "../../packages/slack-agent/src/connectors/credentials.js";
import { registerBuiltInConnectors } from "../../packages/slack-agent/src/connectors/index.js";

registerBuiltInConnectors();
import { FileStorageBackend } from "../../packages/slack-agent/src/storage.js";

describe("ConnectorManager", () => {
	let testDir: string;
	let credDir: string;
	let mgr: ConnectorManager;
	let credMgr: CredentialManager;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`conn-mgr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		credDir = join(testDir, ".credentials");
		mkdirSync(testDir, { recursive: true });
		const storage = new FileStorageBackend(credDir);
		credMgr = new CredentialManager(storage);
		mgr = new ConnectorManager({
			workingDir: testDir,
			credentialManager: credMgr,
		});
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("lists available types when no args provided", async () => {
		const response = await mgr.handleConnect("", "U123");
		expect(response).toContain("Available connector types");
		expect(response).toContain("rest_api");
		expect(response).toContain("hubspot");
	});

	it("adds a connector to connectors.json", async () => {
		const response = await mgr.handleConnect("hubspot my-hubspot", "U123");
		expect(response).toContain("my-hubspot");
		expect(response).toContain("added");

		const config = JSON.parse(
			readFileSync(join(testDir, "connectors.json"), "utf-8"),
		);
		expect(config.connectors).toHaveLength(1);
		expect(config.connectors[0].type).toBe("hubspot");
		expect(config.connectors[0].name).toBe("my-hubspot");
		expect(config.connectors[0].enabled).toBe(true);
	});

	it("rejects duplicate connector names", async () => {
		await mgr.handleConnect("hubspot dup", "U123");
		const response = await mgr.handleConnect("stripe dup", "U123");
		expect(response).toContain("already exists");
	});

	it("rejects unknown connector types", async () => {
		const response = await mgr.handleConnect("unknown_type test", "U123");
		expect(response).toContain("Unknown connector type");
	});

	it("sets credentials", async () => {
		await mgr.handleConnect("hubspot my-hs", "U123");
		const response = await mgr.handleSetCredentials("my-hs pat-abc123", "U123");
		expect(response).toContain("Credentials saved");

		const creds = await credMgr.get("my-hs");
		expect(creds).not.toBeNull();
		expect(creds!.secret).toBe("pat-abc123");
	});

	it("sets credentials with metadata", async () => {
		await mgr.handleConnect("rest_api my-api", "U123");
		const response = await mgr.handleSetCredentials(
			"my-api sk-123 baseUrl=https://api.example.com",
			"U123",
		);
		expect(response).toContain("Credentials saved");

		const creds = await credMgr.get("my-api");
		expect(creds!.metadata?.baseUrl).toBe("https://api.example.com");
	});

	it("rejects credentials for nonexistent connector", async () => {
		const response = await mgr.handleSetCredentials("missing key", "U123");
		expect(response).toContain("not found");
	});

	it("disconnects a connector", async () => {
		await mgr.handleConnect("hubspot to-remove", "U123");
		await mgr.handleSetCredentials("to-remove key123", "U123");

		const response = await mgr.handleDisconnect("to-remove", "U123");
		expect(response).toContain("disconnected");

		const creds = await credMgr.get("to-remove");
		expect(creds).toBeNull();
	});

	it("lists connectors with status", async () => {
		await mgr.handleConnect("hubspot hs1", "U123");
		await mgr.handleConnect("stripe st1", "U123");
		await mgr.handleSetCredentials("hs1 key1", "U123");

		const response = await mgr.handleList();
		expect(response).toContain("hs1");
		expect(response).toContain("st1");
		expect(response).toContain("ready");
		expect(response).toContain("needs credentials");
	});

	it("lists empty connectors", async () => {
		const response = await mgr.handleList();
		expect(response).toContain("No connectors configured");
	});

	it("provides setup hints per connector type", async () => {
		const response = await mgr.handleConnect("zendesk my-zd", "U123");
		expect(response).toContain("subdomain");
	});
});
