/**
 * Integration tests for Approval Workflow
 *
 * Tests the approval manager with simulated reaction events
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApprovalManager,
	describeDestructiveOperation,
	isDestructiveCommand,
} from "../../../packages/slack-agent/src/approval.js";

describe("Approval Workflow Integration", () => {
	let approvalManager: ApprovalManager;

	beforeEach(() => {
		approvalManager = new ApprovalManager({ defaultTimeout: 5000 });
		approvalManager.start();
	});

	afterEach(() => {
		approvalManager.stop();
	});

	describe("Command Detection", () => {
		it("detects various destructive rm patterns", () => {
			const destructive = [
				"rm -rf /tmp/build",
				"rm -r ./node_modules",
				"rm -f *.log",
				"rm temp/*",
				"sudo rm -rf /",
			];

			for (const cmd of destructive) {
				expect(isDestructiveCommand(cmd)).toBe(true);
			}
		});

		it("detects git force operations", () => {
			const destructive = [
				"git push --force",
				"git push -f origin main",
				"git push origin feature --force-with-lease",
				"git reset --hard HEAD~5",
				"git clean -fd",
				"git branch -D feature-branch",
			];

			for (const cmd of destructive) {
				expect(isDestructiveCommand(cmd)).toBe(true);
			}
		});

		it("detects database destructive operations", () => {
			const destructive = [
				"DROP TABLE users",
				"DROP DATABASE production",
				"TRUNCATE TABLE logs",
				"drop table sessions",
			];

			for (const cmd of destructive) {
				expect(isDestructiveCommand(cmd)).toBe(true);
			}
		});

		it("allows safe operations", () => {
			const safe = [
				"ls -la",
				"cat file.txt",
				"git status",
				"git push origin main",
				"npm install",
				"docker ps",
				"SELECT * FROM users",
				"mkdir new_folder",
				"cp file1.txt file2.txt",
			];

			for (const cmd of safe) {
				expect(isDestructiveCommand(cmd)).toBe(false);
			}
		});
	});

	describe("Approval Flow", () => {
		it("completes full approval flow", async () => {
			const approved = vi.fn();
			const rejected = vi.fn();

			// Request approval
			const approvalId = approvalManager.requestApproval(
				"C123456",
				"1234567890.123456",
				"rm -rf /tmp/build",
				"Delete build directory",
				approved,
				rejected,
			);

			expect(approvalId).toMatch(/^approval_/);
			expect(approvalManager.getPendingForChannel("C123456")).toHaveLength(1);

			// Simulate approval reaction
			const handled = await approvalManager.handleReaction(
				"C123456",
				"1234567890.123456",
				"white_check_mark",
			);

			expect(handled).toBe(true);
			expect(approved).toHaveBeenCalledTimes(1);
			expect(rejected).not.toHaveBeenCalled();
			expect(approvalManager.getPendingForChannel("C123456")).toHaveLength(0);
		});

		it("completes full rejection flow", async () => {
			const approved = vi.fn();
			const rejected = vi.fn();

			approvalManager.requestApproval(
				"C123456",
				"1234567890.123456",
				"git push --force",
				"Force push to main",
				approved,
				rejected,
			);

			// Simulate rejection reaction
			const handled = await approvalManager.handleReaction(
				"C123456",
				"1234567890.123456",
				"x",
			);

			expect(handled).toBe(true);
			expect(approved).not.toHaveBeenCalled();
			expect(rejected).toHaveBeenCalledTimes(1);
		});

		it("times out pending approvals", async () => {
			vi.useFakeTimers();

			const approved = vi.fn();
			const rejected = vi.fn();

			// Create manager with short timeout
			const quickManager = new ApprovalManager({ defaultTimeout: 1000 });
			quickManager.start();

			quickManager.requestApproval(
				"C123456",
				"1234567890.123456",
				"rm -rf /",
				"Delete everything",
				approved,
				rejected,
				1000, // 1 second timeout
			);

			expect(quickManager.getPendingForChannel("C123456")).toHaveLength(1);

			// Fast forward past timeout AND the 30-second cleanup interval
			// The cleanup runs every 30 seconds, so we need to advance at least 30s
			await vi.advanceTimersByTimeAsync(31000);

			// Rejection should have been called due to timeout
			expect(rejected).toHaveBeenCalledTimes(1);
			expect(approved).not.toHaveBeenCalled();
			expect(quickManager.getPendingForChannel("C123456")).toHaveLength(0);

			quickManager.stop();
			vi.useRealTimers();
		});

		it("handles multiple pending approvals", async () => {
			const callbacks = {
				approved1: vi.fn(),
				rejected1: vi.fn(),
				approved2: vi.fn(),
				rejected2: vi.fn(),
			};

			// Request two approvals
			approvalManager.requestApproval(
				"C123456",
				"1111111111.111111",
				"rm -rf /tmp/a",
				"Delete A",
				callbacks.approved1,
				callbacks.rejected1,
			);

			approvalManager.requestApproval(
				"C123456",
				"2222222222.222222",
				"rm -rf /tmp/b",
				"Delete B",
				callbacks.approved2,
				callbacks.rejected2,
			);

			expect(approvalManager.getPendingForChannel("C123456")).toHaveLength(2);

			// Approve first, reject second
			await approvalManager.handleReaction(
				"C123456",
				"1111111111.111111",
				"thumbsup",
			);

			await approvalManager.handleReaction(
				"C123456",
				"2222222222.222222",
				"thumbsdown",
			);

			expect(callbacks.approved1).toHaveBeenCalled();
			expect(callbacks.rejected1).not.toHaveBeenCalled();
			expect(callbacks.approved2).not.toHaveBeenCalled();
			expect(callbacks.rejected2).toHaveBeenCalled();
		});

		it("ignores reactions on non-pending messages", async () => {
			const approved = vi.fn();
			const rejected = vi.fn();

			approvalManager.requestApproval(
				"C123456",
				"1234567890.123456",
				"rm -rf /tmp",
				"Delete tmp",
				approved,
				rejected,
			);

			// React to a different message
			const handled = await approvalManager.handleReaction(
				"C123456",
				"9999999999.999999",
				"white_check_mark",
			);

			expect(handled).toBe(false);
			expect(approved).not.toHaveBeenCalled();
			expect(rejected).not.toHaveBeenCalled();
		});

		it("ignores non-approval reactions", async () => {
			const approved = vi.fn();
			const rejected = vi.fn();

			approvalManager.requestApproval(
				"C123456",
				"1234567890.123456",
				"rm -rf /tmp",
				"Delete tmp",
				approved,
				rejected,
			);

			// React with non-approval emoji
			const handled = await approvalManager.handleReaction(
				"C123456",
				"1234567890.123456",
				"eyes",
			);

			expect(handled).toBe(false);
			expect(approved).not.toHaveBeenCalled();
			expect(rejected).not.toHaveBeenCalled();

			// Approval should still be pending
			expect(approvalManager.getPendingForChannel("C123456")).toHaveLength(1);
		});
	});

	describe("Description Generation", () => {
		it("provides meaningful descriptions", () => {
			expect(describeDestructiveOperation("rm -rf /tmp")).toBe(
				"Delete files/directories",
			);
			expect(describeDestructiveOperation("git push --force")).toBe(
				"Force push to git remote",
			);
			expect(describeDestructiveOperation("git reset --hard")).toBe(
				"Hard reset git repository",
			);
			expect(describeDestructiveOperation("DROP TABLE users")).toBe(
				"Drop database table/database",
			);
			expect(describeDestructiveOperation("TRUNCATE logs")).toBe(
				"Truncate database table",
			);
			expect(describeDestructiveOperation("sudo apt install")).toBe(
				"Run command with sudo",
			);
			expect(describeDestructiveOperation("docker rm container")).toBe(
				"Remove Docker container",
			);
		});
	});

	describe("Cross-channel Isolation", () => {
		it("isolates approvals by channel", async () => {
			const channel1Approved = vi.fn();
			const channel2Approved = vi.fn();

			approvalManager.requestApproval(
				"C111111",
				"1234567890.123456",
				"rm -rf /a",
				"Delete A",
				channel1Approved,
				vi.fn(),
			);

			approvalManager.requestApproval(
				"C222222",
				"1234567890.123456", // Same timestamp, different channel
				"rm -rf /b",
				"Delete B",
				channel2Approved,
				vi.fn(),
			);

			// Approve in channel 1
			await approvalManager.handleReaction(
				"C111111",
				"1234567890.123456",
				"white_check_mark",
			);

			expect(channel1Approved).toHaveBeenCalled();
			expect(channel2Approved).not.toHaveBeenCalled();

			// Channel 2 still has pending approval
			expect(approvalManager.getPendingForChannel("C111111")).toHaveLength(0);
			expect(approvalManager.getPendingForChannel("C222222")).toHaveLength(1);
		});
	});
});
