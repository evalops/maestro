import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type SessionBackup,
	type SessionRecoveryConfig,
	SessionRecoveryManager,
	cleanupExpiredBackups,
	createSessionRecoveryManager,
	deleteSessionBackups,
	getSessionRecoveryConfig,
	listSessionBackups,
	loadSessionBackup,
	saveSessionBackup,
} from "../../src/agent/session-recovery.js";
import type { AppMessage } from "../../src/agent/types.js";

describe("Session Recovery", () => {
	let testDir: string;
	let testConfig: SessionRecoveryConfig;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "composer-session-recovery-test-"));
		testConfig = {
			enabled: true,
			backupDir: testDir,
			backupInterval: 1000, // 1 second for testing
			maxBackupsPerSession: 3,
			maxBackupAge: 60000, // 1 minute for testing
		};
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("getSessionRecoveryConfig", () => {
		it("returns default configuration", () => {
			const config = getSessionRecoveryConfig();

			expect(config.enabled).toBe(true);
			expect(config.backupDir).toBeDefined();
			expect(config.backupInterval).toBeGreaterThan(0);
			expect(config.maxBackupsPerSession).toBeGreaterThan(0);
		});
	});

	describe("saveSessionBackup / loadSessionBackup", () => {
		it("saves and loads backup", () => {
			const messages: AppMessage[] = [
				{ role: "user", content: "Hello", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "Hi there!" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-3-opus",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			];

			const backup: SessionBackup = {
				sessionId: "test-session-123",
				messages,
				systemPrompt: "You are helpful",
				modelId: "claude-3-opus",
				createdAt: new Date().toISOString(),
				sessionStartedAt: new Date().toISOString(),
				recoveryAttempts: 0,
			};

			const filePath = saveSessionBackup(backup, testConfig);
			expect(filePath).not.toBeNull();
			if (filePath) {
				expect(existsSync(filePath)).toBe(true);
			}

			const loaded = loadSessionBackup("test-session-123", testConfig);
			expect(loaded).toEqual(backup);
		});

		it("returns null when disabled", () => {
			const backup: SessionBackup = {
				sessionId: "test",
				messages: [],
				createdAt: new Date().toISOString(),
				sessionStartedAt: new Date().toISOString(),
				recoveryAttempts: 0,
			};

			const result = saveSessionBackup(backup, {
				...testConfig,
				enabled: false,
			});

			expect(result).toBeNull();
		});

		it("returns null when no backup exists", () => {
			const loaded = loadSessionBackup("nonexistent", testConfig);

			expect(loaded).toBeNull();
		});
	});

	describe("listSessionBackups", () => {
		it("returns empty array when no backups", () => {
			const backups = listSessionBackups(testConfig);

			expect(backups).toEqual([]);
		});

		it("lists unique sessions", () => {
			const backup1: SessionBackup = {
				sessionId: "session-1",
				messages: [{ role: "user", content: "Hello 1", timestamp: Date.now() }],
				createdAt: new Date().toISOString(),
				sessionStartedAt: new Date().toISOString(),
				recoveryAttempts: 0,
			};

			const backup2: SessionBackup = {
				sessionId: "session-2",
				messages: [{ role: "user", content: "Hello 2", timestamp: Date.now() }],
				createdAt: new Date().toISOString(),
				sessionStartedAt: new Date().toISOString(),
				recoveryAttempts: 0,
			};

			saveSessionBackup(backup1, testConfig);
			saveSessionBackup(backup2, testConfig);

			const backups = listSessionBackups(testConfig);

			expect(backups).toHaveLength(2);
			const sessionIds = backups.map((b) => b.sessionId);
			expect(sessionIds).toContain("session-1");
			expect(sessionIds).toContain("session-2");
		});
	});

	describe("deleteSessionBackups", () => {
		it("deletes backups for a session", () => {
			const backup: SessionBackup = {
				sessionId: "test-session",
				messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
				createdAt: new Date().toISOString(),
				sessionStartedAt: new Date().toISOString(),
				recoveryAttempts: 0,
			};

			saveSessionBackup(backup, testConfig);
			expect(loadSessionBackup("test-session", testConfig)).not.toBeNull();

			const deleted = deleteSessionBackups("test-session", testConfig);

			expect(deleted).toBeGreaterThan(0);
			expect(loadSessionBackup("test-session", testConfig)).toBeNull();
		});

		it("returns 0 when no backups exist", () => {
			const deleted = deleteSessionBackups("nonexistent", testConfig);

			expect(deleted).toBe(0);
		});
	});

	describe("cleanupExpiredBackups", () => {
		it("removes old backups", async () => {
			const oldDate = new Date(Date.now() - 120000).toISOString(); // 2 minutes ago
			const backup: SessionBackup = {
				sessionId: "old-session",
				messages: [
					{ role: "user", content: "Old", timestamp: Date.now() - 120000 },
				],
				createdAt: oldDate,
				sessionStartedAt: oldDate,
				recoveryAttempts: 0,
			};

			saveSessionBackup(backup, testConfig);

			// Config has maxBackupAge of 1 minute
			const deleted = cleanupExpiredBackups(testConfig);

			expect(deleted).toBeGreaterThan(0);
			expect(loadSessionBackup("old-session", testConfig)).toBeNull();
		});

		it("keeps recent backups", () => {
			const backup: SessionBackup = {
				sessionId: "recent-session",
				messages: [{ role: "user", content: "Recent", timestamp: Date.now() }],
				createdAt: new Date().toISOString(),
				sessionStartedAt: new Date().toISOString(),
				recoveryAttempts: 0,
			};

			saveSessionBackup(backup, testConfig);
			const deleted = cleanupExpiredBackups(testConfig);

			expect(deleted).toBe(0);
			expect(loadSessionBackup("recent-session", testConfig)).not.toBeNull();
		});
	});

	describe("SessionRecoveryManager", () => {
		it("creates with default config", () => {
			const manager = createSessionRecoveryManager();

			expect(manager).toBeDefined();
		});

		it("starts and tracks session", () => {
			const manager = new SessionRecoveryManager(testConfig);

			manager.startSession({
				sessionId: "test-session",
				systemPrompt: "You are helpful",
				modelId: "claude-3-opus",
				cwd: "/home/user/project",
			});

			const backup = manager.getCurrentBackup();
			expect(backup).not.toBeNull();
			expect(backup?.sessionId).toBe("test-session");
			expect(backup?.systemPrompt).toBe("You are helpful");
			expect(backup?.modelId).toBe("claude-3-opus");
			expect(backup?.cwd).toBe("/home/user/project");
		});

		it("updates messages", () => {
			const manager = new SessionRecoveryManager(testConfig);
			manager.startSession({ sessionId: "test" });

			const messages: AppMessage[] = [
				{ role: "user", content: "Hello", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "Hi!" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-3-opus",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			];
			manager.updateMessages(messages);

			expect(manager.getCurrentBackup()?.messages).toEqual(messages);
		});

		it("updates summary", () => {
			const manager = new SessionRecoveryManager(testConfig);
			manager.startSession({ sessionId: "test" });

			manager.updateSummary("Working on feature X");

			expect(manager.getCurrentBackup()?.summary).toBe("Working on feature X");
		});

		it("forces backup", () => {
			const manager = new SessionRecoveryManager(testConfig);
			manager.startSession({ sessionId: "test-force" });
			manager.updateMessages([
				{ role: "user", content: "Hello", timestamp: Date.now() },
			]);

			const filePath = manager.forceBackup();

			expect(filePath).not.toBeNull();
			if (filePath) {
				expect(existsSync(filePath)).toBe(true);
			}
		});

		it("marks session as recovered", () => {
			const manager = new SessionRecoveryManager(testConfig);
			manager.startSession({ sessionId: "test" });

			manager.markRecovered("context_limit");

			const backup = manager.getCurrentBackup();
			expect(backup?.recoveryReason).toBe("context_limit");
			expect(backup?.recoveryAttempts).toBe(1);
		});

		it("ends session and creates final backup", () => {
			const manager = new SessionRecoveryManager(testConfig);
			manager.startSession({ sessionId: "test-end" });
			manager.updateMessages([
				{ role: "user", content: "Hello", timestamp: Date.now() },
			]);

			manager.endSession();

			expect(manager.getCurrentBackup()).toBeNull();
			expect(loadSessionBackup("test-end", testConfig)).not.toBeNull();
		});

		it("checks for recoverable session", () => {
			const manager = new SessionRecoveryManager(testConfig);

			// Create a backup first
			const backup: SessionBackup = {
				sessionId: "recoverable",
				messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
				createdAt: new Date().toISOString(),
				sessionStartedAt: new Date().toISOString(),
				recoveryAttempts: 0,
			};
			saveSessionBackup(backup, testConfig);

			expect(manager.hasRecoverableSession("recoverable")).toBe(true);
			expect(manager.hasRecoverableSession("nonexistent")).toBe(false);
		});

		it("recovers a session", () => {
			const originalMessages: AppMessage[] = [
				{ role: "user", content: "Original message", timestamp: Date.now() },
			];

			const backup: SessionBackup = {
				sessionId: "to-recover",
				messages: originalMessages,
				systemPrompt: "Original prompt",
				createdAt: new Date().toISOString(),
				sessionStartedAt: new Date().toISOString(),
				recoveryAttempts: 0,
			};
			saveSessionBackup(backup, testConfig);

			const manager = new SessionRecoveryManager(testConfig);
			const recovered = manager.recoverSession("to-recover");

			expect(recovered).not.toBeNull();
			expect(recovered?.messages).toEqual(originalMessages);
			expect(recovered?.recoveryReason).toBe("manual_recovery");
			expect(recovered?.recoveryAttempts).toBe(1);
		});

		it("returns null when recovering non-existent session", () => {
			const manager = new SessionRecoveryManager(testConfig);
			const recovered = manager.recoverSession("nonexistent");

			expect(recovered).toBeNull();
		});

		it("includes git state in backup", () => {
			const manager = new SessionRecoveryManager(testConfig);
			manager.startSession({
				sessionId: "git-test",
				gitState: {
					branch: "feature/test",
					commitSha: "abc123def456",
					isDirty: true,
				},
			});

			const backup = manager.getCurrentBackup();
			expect(backup?.gitState?.branch).toBe("feature/test");
			expect(backup?.gitState?.commitSha).toBe("abc123def456");
			expect(backup?.gitState?.isDirty).toBe(true);
		});
	});
});
