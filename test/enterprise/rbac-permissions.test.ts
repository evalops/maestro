import { describe, expect, it } from "vitest";
import {
	ACTIONS,
	RESOURCES,
	SYSTEM_ROLES,
} from "../../src/rbac/permissions.js";

describe("RBAC Permissions", () => {
	describe("RESOURCES", () => {
		it("defines all required resources", () => {
			expect(RESOURCES.SESSIONS).toBe("sessions");
			expect(RESOURCES.MODELS).toBe("models");
			expect(RESOURCES.USERS).toBe("users");
			expect(RESOURCES.ORGS).toBe("orgs");
			expect(RESOURCES.AUDIT).toBe("audit");
			expect(RESOURCES.CONFIG).toBe("config");
			expect(RESOURCES.TOOLS).toBe("tools");
			expect(RESOURCES.API_KEYS).toBe("api_keys");
			expect(RESOURCES.ROLES).toBe("roles");
			expect(RESOURCES.DIRECTORIES).toBe("directories");
			expect(RESOURCES.ANY).toBe("*");
		});
	});

	describe("ACTIONS", () => {
		it("defines all required actions", () => {
			expect(ACTIONS.READ).toBe("read");
			expect(ACTIONS.WRITE).toBe("write");
			expect(ACTIONS.DELETE).toBe("delete");
			expect(ACTIONS.EXECUTE).toBe("execute");
			expect(ACTIONS.ADMIN).toBe("admin");
			expect(ACTIONS.WILDCARD).toBe("*");
		});
	});

	describe("SYSTEM_ROLES", () => {
		it("defines org_owner role", () => {
			expect(SYSTEM_ROLES.ORG_OWNER.name).toBe("org_owner");
			expect(SYSTEM_ROLES.ORG_OWNER.description).toContain("owner");
		});

		it("defines org_admin role", () => {
			expect(SYSTEM_ROLES.ORG_ADMIN.name).toBe("org_admin");
			expect(SYSTEM_ROLES.ORG_ADMIN.permissions.length).toBeGreaterThan(0);
		});

		it("defines org_member role", () => {
			expect(SYSTEM_ROLES.ORG_MEMBER.name).toBe("org_member");
			expect(SYSTEM_ROLES.ORG_MEMBER.permissions.length).toBeGreaterThan(0);
		});

		it("defines org_viewer role", () => {
			expect(SYSTEM_ROLES.ORG_VIEWER.name).toBe("org_viewer");
			// Viewer should only have read permissions
			const hasOnlyRead = SYSTEM_ROLES.ORG_VIEWER.permissions.every(
				(p) => p.action === ACTIONS.READ,
			);
			expect(hasOnlyRead).toBe(true);
		});

		it("org_owner has wildcard permission across resources", () => {
			const ownerPerms = SYSTEM_ROLES.ORG_OWNER.permissions;
			const hasOrgWildcard = ownerPerms.some(
				(p) => p.resource === RESOURCES.ANY && p.action === ACTIONS.WILDCARD,
			);
			expect(hasOrgWildcard).toBe(true);
		});

		it("org_member can execute models", () => {
			const memberPerms = SYSTEM_ROLES.ORG_MEMBER.permissions;
			const canExecuteModels = memberPerms.some(
				(p) => p.resource === RESOURCES.MODELS && p.action === ACTIONS.EXECUTE,
			);
			expect(canExecuteModels).toBe(true);
		});

		it("org_member can use tools", () => {
			const memberPerms = SYSTEM_ROLES.ORG_MEMBER.permissions;
			const canUseTools = memberPerms.some(
				(p) => p.resource === RESOURCES.TOOLS && p.action === ACTIONS.EXECUTE,
			);
			expect(canUseTools).toBe(true);
		});
	});
});
