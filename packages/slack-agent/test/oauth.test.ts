import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceManager, verifySlackSignature } from "../src/oauth.js";

// Helper to create OAuthStateManager instance (class is not exported)
// We test it indirectly through the server or by importing the module internals
// For now, we'll focus on testable exports

describe("WorkspaceManager", () => {
	let dir: string;
	let manager: WorkspaceManager;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "slack-agent-oauth-"));
		manager = new WorkspaceManager(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	describe("upsert", () => {
		it("adds new workspace", async () => {
			manager.upsert({
				id: "ws-1",
				teamId: "T123",
				teamName: "Test Team",
				botToken: "xoxb-token",
				botUserId: "U123",
				installedBy: "U456",
				installedAt: new Date().toISOString(),
				status: "active",
			});

			const ws = manager.get("T123");
			expect(ws).toBeDefined();
			expect(ws?.teamName).toBe("Test Team");
		});

		it("updates existing workspace", async () => {
			manager.upsert({
				id: "ws-1",
				teamId: "T123",
				teamName: "Old Name",
				botToken: "xoxb-token",
				botUserId: "U123",
				installedBy: "U456",
				installedAt: new Date().toISOString(),
				status: "active",
			});

			manager.upsert({
				id: "ws-1",
				teamId: "T123",
				teamName: "New Name",
				botToken: "xoxb-new-token",
				botUserId: "U123",
				installedBy: "U456",
				installedAt: new Date().toISOString(),
				status: "active",
			});

			const ws = manager.get("T123");
			expect(ws?.teamName).toBe("New Name");
			expect(ws?.botToken).toBe("xoxb-new-token");
		});
	});

	describe("get", () => {
		it("returns undefined for non-existent workspace", async () => {
			const ws = manager.get("T999");
			expect(ws).toBeUndefined();
		});

		it("returns workspace by team ID", async () => {
			manager.upsert({
				id: "ws-1",
				teamId: "T123",
				teamName: "Test Team",
				botToken: "xoxb-token",
				botUserId: "U123",
				installedBy: "U456",
				installedAt: new Date().toISOString(),
				status: "active",
			});

			const ws = manager.get("T123");
			expect(ws?.teamId).toBe("T123");
		});
	});

	describe("getAll", () => {
		it("returns only active workspaces", async () => {
			manager.upsert({
				id: "ws-1",
				teamId: "T1",
				teamName: "Active Team",
				botToken: "xoxb-1",
				botUserId: "U1",
				installedBy: "U456",
				installedAt: new Date().toISOString(),
				status: "active",
			});

			manager.upsert({
				id: "ws-2",
				teamId: "T2",
				teamName: "Inactive Team",
				botToken: "xoxb-2",
				botUserId: "U2",
				installedBy: "U456",
				installedAt: new Date().toISOString(),
				status: "uninstalled",
			});

			const workspaces = manager.getAll();
			expect(workspaces).toHaveLength(1);
			expect(workspaces[0].teamId).toBe("T1");
		});
	});

	describe("markUninstalled", () => {
		it("marks workspace as uninstalled", async () => {
			manager.upsert({
				id: "ws-1",
				teamId: "T123",
				teamName: "Test Team",
				botToken: "xoxb-token",
				botUserId: "U123",
				installedBy: "U456",
				installedAt: new Date().toISOString(),
				status: "active",
			});

			manager.markUninstalled("T123");

			const ws = manager.get("T123");
			expect(ws?.status).toBe("uninstalled");
		});

		it("does nothing for non-existent workspace", async () => {
			// Should not throw
			manager.markUninstalled("T999");
		});
	});

	describe("remove", () => {
		it("removes workspace and returns true", async () => {
			manager.upsert({
				id: "ws-1",
				teamId: "T123",
				teamName: "Test Team",
				botToken: "xoxb-token",
				botUserId: "U123",
				installedBy: "U456",
				installedAt: new Date().toISOString(),
				status: "active",
			});

			const result = manager.remove("T123");
			expect(result).toBe(true);

			const ws = manager.get("T123");
			expect(ws).toBeUndefined();
		});

		it("returns false for non-existent workspace", async () => {
			const result = manager.remove("T999");
			expect(result).toBe(false);
		});
	});

	describe("persistence", () => {
		it("persists workspaces across manager instances", async () => {
			manager.upsert({
				id: "ws-1",
				teamId: "T123",
				teamName: "Test Team",
				botToken: "xoxb-token",
				botUserId: "U123",
				installedBy: "U456",
				installedAt: new Date().toISOString(),
				status: "active",
			});

			// Create new manager instance with same directory
			const manager2 = new WorkspaceManager(dir);
			const ws = manager2.get("T123");

			expect(ws).toBeDefined();
			expect(ws?.teamName).toBe("Test Team");
		});
	});
});

describe("verifySlackSignature", () => {
	const signingSecret = "test-signing-secret";

	function createSignature(
		secret: string,
		timestamp: string,
		body: string,
	): string {
		const sigBasestring = `v0:${timestamp}:${body}`;
		return `v0=${crypto
			.createHmac("sha256", secret)
			.update(sigBasestring)
			.digest("hex")}`;
	}

	it("verifies valid signature", () => {
		const timestamp = Math.floor(Date.now() / 1000).toString();
		const body = '{"event":"test"}';
		const signature = createSignature(signingSecret, timestamp, body);

		const result = verifySlackSignature(
			signingSecret,
			signature,
			timestamp,
			body,
		);
		expect(result).toBe(true);
	});

	it("rejects invalid signature", () => {
		const timestamp = Math.floor(Date.now() / 1000).toString();
		const body = '{"event":"test"}';
		const signature = "v0=invalid-signature";

		const result = verifySlackSignature(
			signingSecret,
			signature,
			timestamp,
			body,
		);
		expect(result).toBe(false);
	});

	it("rejects expired timestamp (replay attack prevention)", () => {
		// Timestamp from 10 minutes ago
		const timestamp = (Math.floor(Date.now() / 1000) - 600).toString();
		const body = '{"event":"test"}';
		const signature = createSignature(signingSecret, timestamp, body);

		const result = verifySlackSignature(
			signingSecret,
			signature,
			timestamp,
			body,
		);
		expect(result).toBe(false);
	});

	it("rejects future timestamp (replay attack prevention)", () => {
		// Timestamp from 10 minutes in the future
		const timestamp = (Math.floor(Date.now() / 1000) + 600).toString();
		const body = '{"event":"test"}';
		const signature = createSignature(signingSecret, timestamp, body);

		const result = verifySlackSignature(
			signingSecret,
			signature,
			timestamp,
			body,
		);
		expect(result).toBe(false);
	});

	it("rejects tampered body", () => {
		const timestamp = Math.floor(Date.now() / 1000).toString();
		const originalBody = '{"event":"test"}';
		const signature = createSignature(signingSecret, timestamp, originalBody);
		const tamperedBody = '{"event":"hacked"}';

		const result = verifySlackSignature(
			signingSecret,
			signature,
			timestamp,
			tamperedBody,
		);
		expect(result).toBe(false);
	});

	it("rejects wrong signing secret", () => {
		const timestamp = Math.floor(Date.now() / 1000).toString();
		const body = '{"event":"test"}';
		const signature = createSignature("wrong-secret", timestamp, body);

		const result = verifySlackSignature(
			signingSecret,
			signature,
			timestamp,
			body,
		);
		expect(result).toBe(false);
	});
});
