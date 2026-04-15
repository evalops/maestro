import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	PermissionManager,
	getAllowedToolsForRole,
	getRoleDescription,
} from "../src/permissions.js";

describe("PermissionManager", () => {
	let dir: string;
	let manager: PermissionManager;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "slack-agent-permissions-"));
		manager = new PermissionManager(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	describe("getUser", () => {
		it("creates new user with default role", async () => {
			const user = manager.getUser("U123");
			expect(user.role).toBe("user");
			expect(user.isBlocked).toBe(false);
		});

		it("returns existing user", async () => {
			const user1 = manager.getUser("U123");
			const user2 = manager.getUser("U123");
			expect(user1).toEqual(user2);
		});
	});

	describe("check", () => {
		it("admin has full access", async () => {
			// First, set user as admin
			const adminManager = new PermissionManager(dir, { defaultRole: "admin" });
			const result = adminManager.check("U123", "any_action");
			expect(result.allowed).toBe(true);
			expect(result.role).toBe("admin");
		});

		it("blocked user is denied", async () => {
			// Use a single manager instance - create admin first, then block user
			const adminManager = new PermissionManager(dir, { defaultRole: "admin" });
			adminManager.getUser("admin"); // Admin user
			adminManager.setDefaultRole("user"); // Change default for new users
			adminManager.getUser("U123"); // Create regular user
			adminManager.blockUser("admin", "U123", "Test block");

			const result = adminManager.check("U123", "any_action");
			expect(result.allowed).toBe(false);
			expect(result.reason).toBe("Test block");
		});

		it("user can execute allowed tools", async () => {
			const result = manager.check("U123", "execute_tool", "read");
			expect(result.allowed).toBe(true);
		});

		it("user cannot execute admin-only tools", async () => {
			const result = manager.check("U123", "clear_context");
			expect(result.allowed).toBe(false);
		});

		it("viewer has read-only access", async () => {
			const viewerManager = new PermissionManager(dir, {
				defaultRole: "viewer",
			});

			const readResult = viewerManager.check("V1", "execute_tool", "read");
			expect(readResult.allowed).toBe(true);

			const writeResult = viewerManager.check("V1", "execute_tool", "write");
			expect(writeResult.allowed).toBe(false);
		});

		it("power_user can execute any tool", async () => {
			const powerManager = new PermissionManager(dir, {
				defaultRole: "power_user",
			});

			const result = powerManager.check("P1", "execute_tool", "anything");
			expect(result.allowed).toBe(true);
		});
	});

	describe("canExecuteTool", () => {
		it("user can execute common tools", async () => {
			const readResult = manager.canExecuteTool("U123", "read");
			expect(readResult.allowed).toBe(true);
		});

		it("viewer cannot execute write tools", async () => {
			const viewerManager = new PermissionManager(dir, {
				defaultRole: "viewer",
			});
			const writeResult = viewerManager.canExecuteTool("V1", "write");
			expect(writeResult.allowed).toBe(false);
		});
	});

	describe("canCancelTask", () => {
		it("admin can cancel any task", async () => {
			const adminManager = new PermissionManager(dir, { defaultRole: "admin" });
			const result = adminManager.canCancelTask("admin", "other_user");
			expect(result.allowed).toBe(true);
		});

		it("power_user can cancel any task", async () => {
			const powerManager = new PermissionManager(dir, {
				defaultRole: "power_user",
			});
			const result = powerManager.canCancelTask("power", "other_user");
			expect(result.allowed).toBe(true);
		});

		it("user can cancel own task", async () => {
			const result = manager.canCancelTask("U123", "U123");
			expect(result.allowed).toBe(true);
		});

		it("user cannot cancel other's task", async () => {
			const result = manager.canCancelTask("U123", "U456");
			expect(result.allowed).toBe(false);
			expect(result.reason).toBe("Can only cancel your own tasks");
		});
	});

	describe("setRole", () => {
		it("admin can change user role", async () => {
			const adminManager = new PermissionManager(dir, { defaultRole: "admin" });
			adminManager.getUser("admin");
			adminManager.getUser("U123");

			const result = adminManager.setRole("admin", "U123", "power_user");
			expect(result.success).toBe(true);

			const user = adminManager.getUser("U123");
			expect(user.role).toBe("power_user");
		});

		it("non-admin cannot change roles", async () => {
			manager.getUser("U123");
			manager.getUser("U456");

			const result = manager.setRole("U123", "U456", "admin");
			expect(result.success).toBe(false);
			expect(result.error).toBe("Only admins can change roles");
		});

		it("admin cannot change own role", async () => {
			const adminManager = new PermissionManager(dir, { defaultRole: "admin" });
			adminManager.getUser("admin");

			const result = adminManager.setRole("admin", "admin", "user");
			expect(result.success).toBe(false);
			expect(result.error).toBe("Cannot change your own role");
		});
	});

	describe("blockUser", () => {
		it("admin can block user", async () => {
			const adminManager = new PermissionManager(dir, { defaultRole: "admin" });
			adminManager.getUser("admin");
			adminManager.getUser("U123");

			const result = adminManager.blockUser("admin", "U123", "Spam");
			expect(result.success).toBe(true);

			const user = adminManager.getUser("U123");
			expect(user.isBlocked).toBe(true);
			expect(user.blockedReason).toBe("Spam");
		});

		it("non-admin cannot block users", async () => {
			manager.getUser("U123");
			manager.getUser("U456");

			const result = manager.blockUser("U123", "U456", "Test");
			expect(result.success).toBe(false);
			expect(result.error).toBe("Only admins can block users");
		});

		it("admin cannot block themselves", async () => {
			const adminManager = new PermissionManager(dir, { defaultRole: "admin" });
			adminManager.getUser("admin");

			const result = adminManager.blockUser("admin", "admin", "Test");
			expect(result.success).toBe(false);
			expect(result.error).toBe("Cannot block yourself");
		});
	});

	describe("unblockUser", () => {
		it("admin can unblock user", async () => {
			const adminManager = new PermissionManager(dir, { defaultRole: "admin" });
			adminManager.getUser("admin");
			adminManager.blockUser("admin", "U123", "Test");

			const result = adminManager.unblockUser("admin", "U123");
			expect(result.success).toBe(true);

			const user = adminManager.getUser("U123");
			expect(user.isBlocked).toBe(false);
		});
	});

	describe("listUsers", () => {
		it("lists all users with permissions", async () => {
			manager.getUser("U1");
			manager.getUser("U2");
			manager.getUser("U3");

			const users = manager.listUsers();
			expect(users.length).toBe(3);
			expect(users.map((u) => u.userId)).toContain("U1");
			expect(users.map((u) => u.userId)).toContain("U2");
			expect(users.map((u) => u.userId)).toContain("U3");
		});
	});

	describe("setDefaultRole", () => {
		it("changes default role for new users", async () => {
			manager.setDefaultRole("viewer");
			const user = manager.getUser("newuser");
			expect(user.role).toBe("viewer");
		});
	});
});

describe("getRoleDescription", () => {
	it("returns description for admin", () => {
		expect(getRoleDescription("admin")).toBe(
			"Full access to all features and settings",
		);
	});

	it("returns description for power_user", () => {
		expect(getRoleDescription("power_user")).toBe(
			"Execute any tool, manage tasks and context",
		);
	});

	it("returns description for user", () => {
		expect(getRoleDescription("user")).toBe(
			"Execute common tools, manage own tasks",
		);
	});

	it("returns description for viewer", () => {
		expect(getRoleDescription("viewer")).toBe(
			"Read-only access, can search and view status",
		);
	});
});

describe("getAllowedToolsForRole", () => {
	it("returns 'all' for admin", () => {
		expect(getAllowedToolsForRole("admin")).toBe("all");
	});

	it("returns 'all' for power_user", () => {
		expect(getAllowedToolsForRole("power_user")).toBe("all");
	});

	it("returns specific tools for user", () => {
		const tools = getAllowedToolsForRole("user");
		expect(Array.isArray(tools)).toBe(true);
		expect(tools).toContain("read");
		expect(tools).toContain("write");
		expect(tools).toContain("bash");
	});

	it("returns limited tools for viewer", () => {
		const tools = getAllowedToolsForRole("viewer");
		expect(Array.isArray(tools)).toBe(true);
		expect(tools).toContain("read");
		expect(tools).toContain("search");
		expect(tools).not.toContain("write");
		expect(tools).not.toContain("bash");
	});
});
