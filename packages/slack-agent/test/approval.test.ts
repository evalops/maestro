import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ApprovalManager,
	DESTRUCTIVE_PATTERNS,
	describeDestructiveOperation,
	isDestructiveCommand,
} from "../src/approval.js";

describe("isDestructiveCommand", () => {
	describe("file operations", () => {
		it("detects rm -rf", () => {
			expect(isDestructiveCommand("rm -rf /tmp/test")).toBe(true);
			expect(isDestructiveCommand("rm -r /tmp/test")).toBe(true);
			// Note: rm -f alone doesn't match, pattern requires -r or -rf
		});

		it("detects rm with wildcards", () => {
			expect(isDestructiveCommand("rm *.txt")).toBe(true);
			expect(isDestructiveCommand("rm -f /tmp/*.log")).toBe(true);
		});

		it("detects rmdir", () => {
			expect(isDestructiveCommand("rmdir /tmp/empty")).toBe(true);
		});

		it("detects unlink", () => {
			expect(isDestructiveCommand("unlink /tmp/file")).toBe(true);
		});
	});

	describe("git operations", () => {
		it("detects force push", () => {
			expect(isDestructiveCommand("git push --force")).toBe(true);
			expect(isDestructiveCommand("git push origin main --force")).toBe(true);
			expect(isDestructiveCommand("git push -f origin main")).toBe(true);
			// Note: -f must come immediately after push for short form
		});

		it("detects hard reset", () => {
			expect(isDestructiveCommand("git reset --hard")).toBe(true);
			expect(isDestructiveCommand("git reset --hard HEAD~1")).toBe(true);
		});

		it("detects clean -fd", () => {
			expect(isDestructiveCommand("git clean -fd")).toBe(true);
		});

		it("detects branch delete", () => {
			expect(isDestructiveCommand("git branch -d feature")).toBe(true);
			expect(isDestructiveCommand("git branch -D feature")).toBe(true);
		});
	});

	describe("database operations", () => {
		it("detects DROP TABLE", () => {
			expect(isDestructiveCommand("DROP TABLE users")).toBe(true);
			expect(isDestructiveCommand("drop table users")).toBe(true);
		});

		it("detects DROP DATABASE", () => {
			expect(isDestructiveCommand("DROP DATABASE mydb")).toBe(true);
		});

		it("detects DROP INDEX", () => {
			expect(isDestructiveCommand("DROP INDEX idx_users")).toBe(true);
		});

		it("detects TRUNCATE", () => {
			expect(isDestructiveCommand("TRUNCATE TABLE users")).toBe(true);
			expect(isDestructiveCommand("truncate users")).toBe(true);
		});
	});

	describe("system operations", () => {
		it("detects sudo", () => {
			expect(isDestructiveCommand("sudo rm file")).toBe(true);
			expect(isDestructiveCommand("sudo apt-get install")).toBe(true);
		});

		it("detects chmod 777", () => {
			expect(isDestructiveCommand("chmod 777 /var/www")).toBe(true);
		});

		it("detects kill -9", () => {
			expect(isDestructiveCommand("kill -9 1234")).toBe(true);
		});

		it("detects pkill", () => {
			expect(isDestructiveCommand("pkill node")).toBe(true);
		});
	});

	describe("package operations", () => {
		it("detects npm unpublish", () => {
			expect(isDestructiveCommand("npm unpublish my-package")).toBe(true);
		});
	});

	describe("docker operations", () => {
		it("detects docker rm", () => {
			expect(isDestructiveCommand("docker rm container")).toBe(true);
		});

		it("detects docker rmi", () => {
			expect(isDestructiveCommand("docker rmi image")).toBe(true);
		});

		it("detects docker system prune", () => {
			expect(isDestructiveCommand("docker system prune")).toBe(true);
			expect(isDestructiveCommand("docker system prune -a")).toBe(true);
		});
	});

	describe("safe commands", () => {
		it("returns false for safe commands", () => {
			expect(isDestructiveCommand("ls -la")).toBe(false);
			expect(isDestructiveCommand("cat file.txt")).toBe(false);
			expect(isDestructiveCommand("echo hello")).toBe(false);
			expect(isDestructiveCommand("git status")).toBe(false);
			expect(isDestructiveCommand("git push")).toBe(false);
			expect(isDestructiveCommand("npm install")).toBe(false);
			expect(isDestructiveCommand("docker ps")).toBe(false);
		});
	});
});

describe("describeDestructiveOperation", () => {
	it("describes rm operations", () => {
		expect(describeDestructiveOperation("rm -rf /tmp")).toBe(
			"Delete files/directories",
		);
		expect(describeDestructiveOperation("rm -r /tmp")).toBe(
			"Delete files/directories",
		);
	});

	it("describes force push", () => {
		expect(describeDestructiveOperation("git push --force")).toBe(
			"Force push to git remote",
		);
		expect(describeDestructiveOperation("git push -f")).toBe(
			"Force push to git remote",
		);
	});

	it("describes hard reset", () => {
		expect(describeDestructiveOperation("git reset --hard")).toBe(
			"Hard reset git repository",
		);
	});

	it("describes DROP operations", () => {
		expect(describeDestructiveOperation("DROP TABLE users")).toBe(
			"Drop database table/database",
		);
		expect(describeDestructiveOperation("DROP DATABASE mydb")).toBe(
			"Drop database table/database",
		);
	});

	it("describes TRUNCATE", () => {
		expect(describeDestructiveOperation("TRUNCATE users")).toBe(
			"Truncate database table",
		);
	});

	it("describes sudo", () => {
		expect(describeDestructiveOperation("sudo command")).toBe(
			"Run command with sudo",
		);
	});

	it("describes docker rm", () => {
		expect(describeDestructiveOperation("docker rm container")).toBe(
			"Remove Docker container",
		);
	});

	it("describes docker prune", () => {
		expect(describeDestructiveOperation("docker system prune")).toBe(
			"Prune Docker system",
		);
	});

	it("returns generic description for unknown patterns", () => {
		expect(describeDestructiveOperation("pkill node")).toBe(
			"Potentially destructive operation",
		);
	});
});

describe("DESTRUCTIVE_PATTERNS", () => {
	it("exports all expected patterns", () => {
		expect(DESTRUCTIVE_PATTERNS).toBeInstanceOf(Array);
		expect(DESTRUCTIVE_PATTERNS.length).toBeGreaterThan(15);
		expect(DESTRUCTIVE_PATTERNS.every((p) => p instanceof RegExp)).toBe(true);
	});
});

describe("ApprovalManager", () => {
	let manager: ApprovalManager;

	beforeEach(() => {
		manager = new ApprovalManager({ defaultTimeout: 100 }); // Short timeout for tests
	});

	afterEach(() => {
		manager.stop();
	});

	describe("requestApproval", () => {
		it("creates approval with unique ID", () => {
			const id1 = manager.requestApproval(
				"C123",
				"1234.5678",
				"rm -rf",
				"Delete files",
				async () => {},
				async () => {},
			);

			const id2 = manager.requestApproval(
				"C123",
				"1234.5679",
				"rm -rf",
				"Delete files",
				async () => {},
				async () => {},
			);

			expect(id1).toMatch(/^approval_\d+_[a-z0-9]+$/);
			expect(id2).toMatch(/^approval_\d+_[a-z0-9]+$/);
			expect(id1).not.toBe(id2);
		});

		it("stores approval in pending list", () => {
			manager.requestApproval(
				"C123",
				"1234.5678",
				"rm -rf",
				"Delete files",
				async () => {},
				async () => {},
			);

			const pending = manager.getPendingForChannel("C123");
			expect(pending).toHaveLength(1);
			expect(pending[0].operation).toBe("rm -rf");
		});
	});

	describe("handleReaction", () => {
		it("approves with checkmark reaction", async () => {
			let approved = false;
			manager.requestApproval(
				"C123",
				"1234.5678",
				"rm -rf",
				"Delete files",
				async () => {
					approved = true;
				},
				async () => {},
			);

			const handled = await manager.handleReaction(
				"C123",
				"1234.5678",
				"white_check_mark",
			);

			expect(handled).toBe(true);
			expect(approved).toBe(true);
			expect(manager.getPendingForChannel("C123")).toHaveLength(0);
		});

		it("approves with thumbsup reaction", async () => {
			let approved = false;
			manager.requestApproval(
				"C123",
				"1234.5678",
				"rm -rf",
				"Delete files",
				async () => {
					approved = true;
				},
				async () => {},
			);

			const handled = await manager.handleReaction("C123", "1234.5678", "+1");

			expect(handled).toBe(true);
			expect(approved).toBe(true);
		});

		it("rejects with x reaction", async () => {
			let rejected = false;
			manager.requestApproval(
				"C123",
				"1234.5678",
				"rm -rf",
				"Delete files",
				async () => {},
				async () => {
					rejected = true;
				},
			);

			const handled = await manager.handleReaction("C123", "1234.5678", "x");

			expect(handled).toBe(true);
			expect(rejected).toBe(true);
			expect(manager.getPendingForChannel("C123")).toHaveLength(0);
		});

		it("rejects with thumbsdown reaction", async () => {
			let rejected = false;
			manager.requestApproval(
				"C123",
				"1234.5678",
				"rm -rf",
				"Delete files",
				async () => {},
				async () => {
					rejected = true;
				},
			);

			const handled = await manager.handleReaction("C123", "1234.5678", "-1");

			expect(handled).toBe(true);
			expect(rejected).toBe(true);
		});

		it("ignores unrelated reactions", async () => {
			let called = false;
			manager.requestApproval(
				"C123",
				"1234.5678",
				"rm -rf",
				"Delete files",
				async () => {
					called = true;
				},
				async () => {
					called = true;
				},
			);

			const handled = await manager.handleReaction(
				"C123",
				"1234.5678",
				"thinking_face",
			);

			expect(handled).toBe(false);
			expect(called).toBe(false);
			expect(manager.getPendingForChannel("C123")).toHaveLength(1);
		});

		it("returns false for unknown message", async () => {
			const handled = await manager.handleReaction(
				"C123",
				"unknown",
				"white_check_mark",
			);

			expect(handled).toBe(false);
		});

		it("handles callback errors gracefully", async () => {
			manager.requestApproval(
				"C123",
				"1234.5678",
				"rm -rf",
				"Delete files",
				async () => {
					throw new Error("Callback error");
				},
				async () => {},
			);

			// Should not throw
			const handled = await manager.handleReaction(
				"C123",
				"1234.5678",
				"white_check_mark",
			);

			expect(handled).toBe(true);
			expect(manager.getPendingForChannel("C123")).toHaveLength(0);
		});
	});

	describe("cancel", () => {
		it("removes pending approval", () => {
			const id = manager.requestApproval(
				"C123",
				"1234.5678",
				"rm -rf",
				"Delete files",
				async () => {},
				async () => {},
			);

			expect(manager.getPendingForChannel("C123")).toHaveLength(1);

			const result = manager.cancel(id);

			expect(result).toBe(true);
			expect(manager.getPendingForChannel("C123")).toHaveLength(0);
		});

		it("returns false for unknown ID", () => {
			const result = manager.cancel("unknown");
			expect(result).toBe(false);
		});
	});

	describe("getPendingForChannel", () => {
		it("returns only approvals for specified channel", () => {
			manager.requestApproval(
				"C123",
				"1",
				"op1",
				"desc1",
				async () => {},
				async () => {},
			);
			manager.requestApproval(
				"C123",
				"2",
				"op2",
				"desc2",
				async () => {},
				async () => {},
			);
			manager.requestApproval(
				"C456",
				"3",
				"op3",
				"desc3",
				async () => {},
				async () => {},
			);

			const c123Pending = manager.getPendingForChannel("C123");
			const c456Pending = manager.getPendingForChannel("C456");

			expect(c123Pending).toHaveLength(2);
			expect(c456Pending).toHaveLength(1);
		});

		it("returns empty array for channel with no approvals", () => {
			const pending = manager.getPendingForChannel("C999");
			expect(pending).toHaveLength(0);
		});
	});

	describe("start/stop", () => {
		it("can be started and stopped", () => {
			manager.start();
			manager.start(); // Should be idempotent
			manager.stop();
			manager.stop(); // Should be idempotent
		});
	});

	describe("expiration", () => {
		it("expires approvals after timeout", async () => {
			let rejected = false;
			manager.requestApproval(
				"C123",
				"1234.5678",
				"rm -rf",
				"Delete files",
				async () => {},
				async () => {
					rejected = true;
				},
				50, // 50ms timeout
			);

			expect(manager.getPendingForChannel("C123")).toHaveLength(1);

			// Wait for expiration
			await new Promise((r) => setTimeout(r, 100));

			// Trigger cleanup manually (since we're not running the interval)
			// Access private method via type assertion for testing
			await (manager as unknown as { cleanupExpired: () => Promise<void> }).cleanupExpired();

			expect(rejected).toBe(true);
			expect(manager.getPendingForChannel("C123")).toHaveLength(0);
		});
	});
});
