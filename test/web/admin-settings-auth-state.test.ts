// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../packages/web/src/components/admin-settings.js";

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function auditLog(id: string) {
	return {
		id,
		orgId: "org-1",
		userId: "user-1",
		action: "admin.audit.view",
		status: "success",
		createdAt: "2026-04-30T00:00:00Z",
	};
}

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

	it("keeps tab loading tied to the latest tab selection", async () => {
		const members = deferred<{ members: [] }>();
		const roles = deferred<{ roles: [] }>();
		const element = document.createElement("admin-settings") as HTMLElement & {
			api: {
				isAuthenticated: ReturnType<typeof vi.fn>;
				getUsageQuota: ReturnType<typeof vi.fn>;
				getOrgUsage: ReturnType<typeof vi.fn>;
				getAlerts: ReturnType<typeof vi.fn>;
				getModelApprovals: ReturnType<typeof vi.fn>;
				getDirectoryRules: ReturnType<typeof vi.fn>;
				getOrgSettings: ReturnType<typeof vi.fn>;
				getAuditLogs: ReturnType<typeof vi.fn>;
				getOrgMembers: ReturnType<typeof vi.fn>;
				getRoles: ReturnType<typeof vi.fn>;
			};
			selectTab: (tab: string) => Promise<void>;
			tabLoading: boolean;
			updateComplete?: Promise<void>;
		};

		element.api = {
			isAuthenticated: vi.fn().mockReturnValue(true),
			getUsageQuota: vi.fn().mockResolvedValue(null),
			getOrgUsage: vi.fn().mockResolvedValue(null),
			getAlerts: vi.fn().mockResolvedValue({ alerts: [] }),
			getModelApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
			getDirectoryRules: vi.fn().mockResolvedValue({ rules: [] }),
			getOrgSettings: vi.fn().mockResolvedValue({}),
			getAuditLogs: vi.fn().mockResolvedValue({ logs: [] }),
			getOrgMembers: vi.fn().mockReturnValue(members.promise),
			getRoles: vi.fn().mockReturnValue(roles.promise),
		};

		document.body.appendChild(element);
		await element.updateComplete;

		const commandCenterLoad = element.selectTab("command-center");
		const usersLoad = element.selectTab("users");

		await commandCenterLoad;
		await element.updateComplete;

		expect(element.tabLoading).toBe(true);

		members.resolve({ members: [] });
		roles.resolve({ roles: [] });
		await usersLoad;
		await element.updateComplete;

		expect(element.tabLoading).toBe(false);
	});

	it("ignores stale command center audit logs after switching to the audit tab", async () => {
		const commandCenterLogs = deferred<{
			logs: ReturnType<typeof auditLog>[];
		}>();
		const auditTabLogs = deferred<{ logs: ReturnType<typeof auditLog>[] }>();
		const element = document.createElement("admin-settings") as HTMLElement & {
			api: {
				isAuthenticated: ReturnType<typeof vi.fn>;
				getUsageQuota: ReturnType<typeof vi.fn>;
				getOrgUsage: ReturnType<typeof vi.fn>;
				getAlerts: ReturnType<typeof vi.fn>;
				getModelApprovals: ReturnType<typeof vi.fn>;
				getDirectoryRules: ReturnType<typeof vi.fn>;
				getOrgSettings: ReturnType<typeof vi.fn>;
				getAuditLogs: ReturnType<typeof vi.fn>;
			};
			auditLogs: ReturnType<typeof auditLog>[];
			selectTab: (tab: string) => Promise<void>;
			updateComplete?: Promise<void>;
		};

		element.api = {
			isAuthenticated: vi.fn().mockReturnValue(true),
			getUsageQuota: vi.fn().mockResolvedValue(null),
			getOrgUsage: vi.fn().mockResolvedValue(null),
			getAlerts: vi.fn().mockResolvedValue({ alerts: [] }),
			getModelApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
			getDirectoryRules: vi.fn().mockResolvedValue({ rules: [] }),
			getOrgSettings: vi.fn().mockResolvedValue({}),
			getAuditLogs: vi.fn(({ limit }: { limit: number }) =>
				limit === 100 ? commandCenterLogs.promise : auditTabLogs.promise,
			),
		};

		document.body.appendChild(element);
		await element.updateComplete;

		const commandCenterLoad = element.selectTab("command-center");
		const auditLoad = element.selectTab("audit");

		auditTabLogs.resolve({ logs: [auditLog("audit-tab-500")] });
		await auditLoad;
		await element.updateComplete;

		expect(element.auditLogs.map((log) => log.id)).toEqual(["audit-tab-500"]);

		commandCenterLogs.resolve({ logs: [auditLog("command-center-100")] });
		await commandCenterLoad;
		await element.updateComplete;

		expect(element.auditLogs.map((log) => log.id)).toEqual(["audit-tab-500"]);
	});
});
