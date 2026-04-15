// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../packages/web/src/components/admin-settings.js";

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("admin-settings auth states", () => {
	it("shows an auth-required state instead of fake defaults", async () => {
		const element = document.createElement("admin-settings") as HTMLElement & {
			api: {
				isAuthenticated: ReturnType<typeof vi.fn>;
			};
			updateComplete?: Promise<void>;
		};

		element.api = {
			isAuthenticated: vi.fn().mockReturnValue(false),
		};

		document.body.appendChild(element);
		await element.updateComplete;

		const text = (element.shadowRoot?.textContent ?? "").replace(/\s+/g, " ");
		expect(text).toContain(
			"Sign in with enterprise credentials to view admin settings.",
		);
		expect(text).not.toContain("Total Tokens");
		expect(text).not.toContain("Your Usage Quota");
	});

	it("shows empty states when authenticated data is unavailable", async () => {
		const element = document.createElement("admin-settings") as HTMLElement & {
			api: {
				isAuthenticated: ReturnType<typeof vi.fn>;
			};
			roles: Array<unknown>;
			modelApprovals: Array<unknown>;
			directoryRules: Array<unknown>;
			currentTab: string;
			updateComplete?: Promise<void>;
		};

		element.api = {
			isAuthenticated: vi.fn().mockReturnValue(true),
		};
		element.roles = [];
		element.modelApprovals = [];
		element.directoryRules = [];
		element.currentTab = "models";

		document.body.appendChild(element);
		await element.updateComplete;

		let text = (element.shadowRoot?.textContent ?? "").replace(/\s+/g, " ");
		expect(text).toContain("No model approvals configured");

		element.currentTab = "directories";
		await element.updateComplete;

		text = (element.shadowRoot?.textContent ?? "").replace(/\s+/g, " ");
		expect(text).toContain("No directory rules configured");
	});

	it("prevents invites when roles are unavailable", async () => {
		const element = document.createElement("admin-settings") as HTMLElement & {
			api: {
				isAuthenticated: ReturnType<typeof vi.fn>;
				getUsageQuota: ReturnType<typeof vi.fn>;
				getOrgUsage: ReturnType<typeof vi.fn>;
				inviteUser: ReturnType<typeof vi.fn>;
			};
			inviteEmail: string;
			inviteRoleId: string;
			roles: Array<unknown>;
			currentTab: string;
			handleInviteUser: () => Promise<void>;
			updateComplete?: Promise<void>;
		};

		element.api = {
			isAuthenticated: vi.fn().mockReturnValue(true),
			getUsageQuota: vi.fn().mockResolvedValue(null),
			getOrgUsage: vi.fn().mockResolvedValue(null),
			inviteUser: vi.fn(),
		};
		element.inviteEmail = "user@example.com";
		element.inviteRoleId = "developer";
		element.roles = [];
		element.currentTab = "users";

		document.body.appendChild(element);
		await element.updateComplete;

		await element.handleInviteUser();
		await element.updateComplete;

		expect(element.api.inviteUser).not.toHaveBeenCalled();
		const text = (element.shadowRoot?.textContent ?? "").replace(/\s+/g, " ");
		expect(text).toContain("No roles available");
		expect(text).toContain(
			"Please wait for roles to load before inviting users.",
		);
	});

	it("selects the first available role after roles load", async () => {
		const element = document.createElement("admin-settings") as HTMLElement & {
			api: {
				isAuthenticated: ReturnType<typeof vi.fn>;
				getOrgMembers: ReturnType<typeof vi.fn>;
				getRoles: ReturnType<typeof vi.fn>;
				getUsageQuota: ReturnType<typeof vi.fn>;
				getOrgUsage: ReturnType<typeof vi.fn>;
				inviteUser: ReturnType<typeof vi.fn>;
			};
			inviteEmail: string;
			inviteRoleId: string;
			loadTabData: (tab: string) => Promise<void>;
			updateComplete?: Promise<void>;
		};

		element.api = {
			isAuthenticated: vi.fn().mockReturnValue(true),
			getOrgMembers: vi.fn().mockResolvedValue({ members: [] }),
			getRoles: vi.fn().mockResolvedValue({
				roles: [
					{
						id: "org_member",
						name: "Member",
						description: "Standard access",
						isSystem: true,
					},
				],
			}),
			getUsageQuota: vi.fn().mockResolvedValue(null),
			getOrgUsage: vi.fn().mockResolvedValue(null),
			inviteUser: vi.fn(),
		};

		document.body.appendChild(element);
		await element.updateComplete;

		await element.loadTabData("users");
		await element.updateComplete;

		expect(element.inviteRoleId).toBe("org_member");

		element.inviteEmail = "member@example.com";
		await element.handleInviteUser();

		expect(element.api.inviteUser).toHaveBeenCalledWith(
			"member@example.com",
			"org_member",
		);
	});
});
