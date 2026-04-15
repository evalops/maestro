/**
 * Tests for approval.ts - Approval workflows
 */

import { describe, expect, it, vi } from "vitest";
import {
	ApprovalManager,
	describeDestructiveOperation,
	isDestructiveCommand,
} from "../../packages/slack-agent/src/approval.js";

describe("isDestructiveCommand", () => {
	it("detects rm -rf", () => {
		expect(isDestructiveCommand("rm -rf /tmp/foo")).toBe(true);
		expect(isDestructiveCommand("rm -r ./build")).toBe(true);
	});

	it("detects rm with wildcards", () => {
		expect(isDestructiveCommand("rm *.log")).toBe(true);
		expect(isDestructiveCommand("rm -f temp/*")).toBe(true);
	});

	it("detects git force push", () => {
		expect(isDestructiveCommand("git push origin main --force")).toBe(true);
		expect(isDestructiveCommand("git push -f")).toBe(true);
	});

	it("detects git hard reset", () => {
		expect(isDestructiveCommand("git reset --hard HEAD~1")).toBe(true);
	});

	it("detects SQL DROP", () => {
		expect(isDestructiveCommand("DROP TABLE users")).toBe(true);
		expect(isDestructiveCommand("DROP DATABASE production")).toBe(true);
	});

	it("detects TRUNCATE", () => {
		expect(isDestructiveCommand("TRUNCATE TABLE logs")).toBe(true);
	});

	it("detects sudo", () => {
		expect(isDestructiveCommand("sudo rm -rf /")).toBe(true);
		expect(isDestructiveCommand("sudo apt install vim")).toBe(true);
	});

	it("detects docker rm", () => {
		expect(isDestructiveCommand("docker rm container123")).toBe(true);
		expect(isDestructiveCommand("docker rmi image:latest")).toBe(true);
	});

	it("allows safe commands", () => {
		expect(isDestructiveCommand("ls -la")).toBe(false);
		expect(isDestructiveCommand("git status")).toBe(false);
		expect(isDestructiveCommand("npm install")).toBe(false);
		expect(isDestructiveCommand("cat file.txt")).toBe(false);
	});
});

describe("describeDestructiveOperation", () => {
	it("describes rm operations", () => {
		expect(describeDestructiveOperation("rm -rf /tmp")).toBe(
			"Delete files/directories",
		);
	});

	it("describes git force push", () => {
		expect(describeDestructiveOperation("git push --force")).toBe(
			"Force push to git remote",
		);
	});

	it("describes DROP TABLE", () => {
		expect(describeDestructiveOperation("DROP TABLE users")).toBe(
			"Drop database table/database",
		);
	});

	it("describes sudo", () => {
		expect(describeDestructiveOperation("sudo command")).toBe(
			"Run command with sudo",
		);
	});

	it("provides generic description for unknown destructive ops", () => {
		expect(describeDestructiveOperation("pkill node")).toBe(
			"Potentially destructive operation",
		);
	});
});

describe("ApprovalManager", () => {
	it("creates pending approvals", () => {
		const manager = new ApprovalManager();
		const onApprove = vi.fn();
		const onReject = vi.fn();

		const id = manager.requestApproval(
			"C123",
			"1234567890.123456",
			"rm -rf /tmp",
			"Delete temp files",
			onApprove,
			onReject,
		);

		expect(id).toMatch(/^approval_/);
		expect(manager.getPendingForChannel("C123")).toHaveLength(1);
	});

	it("handles approval reactions", async () => {
		const manager = new ApprovalManager();
		const onApprove = vi.fn();
		const onReject = vi.fn();

		manager.requestApproval(
			"C123",
			"1234567890.123456",
			"rm -rf /tmp",
			"Delete temp files",
			onApprove,
			onReject,
		);

		const handled = await manager.handleReaction(
			"C123",
			"1234567890.123456",
			"white_check_mark",
		);

		expect(handled).toBe(true);
		expect(onApprove).toHaveBeenCalled();
		expect(onReject).not.toHaveBeenCalled();
		expect(manager.getPendingForChannel("C123")).toHaveLength(0);
	});

	it("handles rejection reactions", async () => {
		const manager = new ApprovalManager();
		const onApprove = vi.fn();
		const onReject = vi.fn();

		manager.requestApproval(
			"C123",
			"1234567890.123456",
			"rm -rf /tmp",
			"Delete temp files",
			onApprove,
			onReject,
		);

		const handled = await manager.handleReaction(
			"C123",
			"1234567890.123456",
			"x",
		);

		expect(handled).toBe(true);
		expect(onApprove).not.toHaveBeenCalled();
		expect(onReject).toHaveBeenCalled();
	});

	it("ignores reactions for unknown messages", async () => {
		const manager = new ApprovalManager();

		const handled = await manager.handleReaction(
			"C123",
			"unknown_ts",
			"white_check_mark",
		);

		expect(handled).toBe(false);
	});

	it("ignores non-approval reactions", async () => {
		const manager = new ApprovalManager();
		const onApprove = vi.fn();
		const onReject = vi.fn();

		manager.requestApproval(
			"C123",
			"1234567890.123456",
			"rm -rf /tmp",
			"Delete temp files",
			onApprove,
			onReject,
		);

		const handled = await manager.handleReaction(
			"C123",
			"1234567890.123456",
			"eyes",
		);

		expect(handled).toBe(false);
		expect(onApprove).not.toHaveBeenCalled();
		expect(onReject).not.toHaveBeenCalled();
	});

	it("can cancel pending approvals", () => {
		const manager = new ApprovalManager();
		const onApprove = vi.fn();
		const onReject = vi.fn();

		const id = manager.requestApproval(
			"C123",
			"1234567890.123456",
			"rm -rf /tmp",
			"Delete temp files",
			onApprove,
			onReject,
		);

		expect(manager.cancel(id)).toBe(true);
		expect(manager.getPendingForChannel("C123")).toHaveLength(0);
	});

	it("accepts various approval reaction formats", async () => {
		const approvalReactions = [
			"white_check_mark",
			"heavy_check_mark",
			"thumbsup",
			"+1",
		];

		for (const reaction of approvalReactions) {
			const manager = new ApprovalManager();
			const onApprove = vi.fn();
			const onReject = vi.fn();

			manager.requestApproval(
				"C123",
				"1234567890.123456",
				"test",
				"test",
				onApprove,
				onReject,
			);

			await manager.handleReaction("C123", "1234567890.123456", reaction);
			expect(onApprove).toHaveBeenCalled();
		}
	});

	it("accepts various rejection reaction formats", async () => {
		const rejectReactions = ["x", "no_entry", "thumbsdown", "-1"];

		for (const reaction of rejectReactions) {
			const manager = new ApprovalManager();
			const onApprove = vi.fn();
			const onReject = vi.fn();

			manager.requestApproval(
				"C123",
				"1234567890.123456",
				"test",
				"test",
				onApprove,
				onReject,
			);

			await manager.handleReaction("C123", "1234567890.123456", reaction);
			expect(onReject).toHaveBeenCalled();
		}
	});
});
