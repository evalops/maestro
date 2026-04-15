/**
 * Tests for the CredentialManager.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CredentialManager,
	createCredentialGetter,
} from "../../packages/slack-agent/src/connectors/credentials.js";
import { FileStorageBackend } from "../../packages/slack-agent/src/storage.js";

describe("CredentialManager", () => {
	let testDir: string;
	let storage: FileStorageBackend;
	let manager: CredentialManager;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`cred-mgr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
		storage = new FileStorageBackend(testDir);
		manager = new CredentialManager(storage);
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("returns null for missing credentials", async () => {
		const result = await manager.get("nonexistent");
		expect(result).toBeNull();
	});

	it("stores and retrieves credentials", async () => {
		await manager.set("my-hubspot", {
			type: "api_key",
			secret: "pat-123",
			metadata: { baseUrl: "https://api.hubapi.com" },
		});

		const creds = await manager.get("my-hubspot");
		expect(creds).not.toBeNull();
		expect(creds!.type).toBe("api_key");
		expect(creds!.secret).toBe("pat-123");
		expect(creds!.metadata?.baseUrl).toBe("https://api.hubapi.com");
	});

	it("checks existence", async () => {
		expect(await manager.exists("test")).toBe(false);
		await manager.set("test", { type: "api_key", secret: "s" });
		expect(await manager.exists("test")).toBe(true);
	});

	it("deletes credentials", async () => {
		await manager.set("to-delete", { type: "api_key", secret: "s" });
		expect(await manager.exists("to-delete")).toBe(true);

		const deleted = await manager.delete("to-delete");
		expect(deleted).toBe(true);
		expect(await manager.exists("to-delete")).toBe(false);
	});

	it("lists stored credentials", async () => {
		await manager.set("cred-a", { type: "api_key", secret: "a" });
		await manager.set("cred-b", { type: "oauth", secret: "b" });

		const names = await manager.list();
		expect(names).toContain("cred-a");
		expect(names).toContain("cred-b");
		expect(names.length).toBe(2);
	});

	it("createCredentialGetter returns a working callback", async () => {
		await manager.set("test-conn", { type: "api_key", secret: "abc" });

		const getter = createCredentialGetter(manager);
		const result = await getter("test-conn");
		expect(result).not.toBeNull();
		expect(result!.secret).toBe("abc");

		const missing = await getter("missing");
		expect(missing).toBeNull();
	});

	it("overwrites existing credentials", async () => {
		await manager.set("overwrite", { type: "api_key", secret: "old" });
		await manager.set("overwrite", { type: "api_key", secret: "new" });

		const creds = await manager.get("overwrite");
		expect(creds!.secret).toBe("new");
	});
});
