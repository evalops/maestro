import { fixture, html } from "@open-wc/testing";
import { LitElement } from "lit";
import { assert, describe, it } from "vitest";
import type {
	Alert,
	AuditLog,
	DirectoryRule,
	ModelApproval,
	OrgUsageSummary,
	OrganizationSettings,
	UsageQuota,
} from "../services/enterprise-api.js";
import { AdminCommandCenterTab } from "./admin-command-center-tab.js";

class TestAdminCommandCenterHost extends LitElement {
	readonly commandCenter = new AdminCommandCenterTab(
		(value) => new Date(value).toISOString(),
		(tone) => tone,
	);

	override render() {
		const usage: OrgUsageSummary = {
			totalTokens: 220_000,
			totalSessions: 12,
			totalUsers: 4,
			topUsers: [],
			modelBreakdown: [],
		};
		const quota: UsageQuota = {
			userId: "user-1",
			orgId: "org-1",
			tokenQuota: 100_000,
			tokenUsed: 92_000,
			tokenRemaining: 8_000,
			spendLimit: null,
			spendUsed: 0,
			spendRemaining: 0,
			quotaResetAt: null,
		};
		const alerts: Alert[] = [
			{
				id: "alert-1",
				orgId: "org-1",
				severity: "high",
				type: "run_policy",
				message: "Run requested a restricted directory",
				isRead: false,
				createdAt: "2026-04-20T11:00:00.000Z",
			},
		];
		const auditLogs: AuditLog[] = [
			{
				id: "audit-1",
				orgId: "org-1",
				userId: "user-1",
				action: "tool.execute",
				resourceType: "shell",
				status: "denied",
				createdAt: "2026-04-20T11:00:01.000Z",
			},
		];
		const modelApprovals: ModelApproval[] = [
			{
				id: "model-1",
				orgId: "org-1",
				modelId: "gpt-5.4",
				provider: "openai",
				status: "pending",
				spendUsed: 0,
				tokenUsed: 0,
			},
		];
		const directoryRules: DirectoryRule[] = [
			{
				id: "rule-1",
				orgId: "org-1",
				pattern: "/secure/**",
				isAllowed: false,
				priority: 1,
			},
		];
		const orgSettings: OrganizationSettings = {
			piiRedactionEnabled: true,
			alertWebhooks: ["https://siem.example/events"],
		};

		return this.commandCenter.render(false, {
			usage,
			quota,
			alerts,
			auditLogs,
			modelApprovals,
			directoryRules,
			orgSettings,
		});
	}
}

if (!customElements.get("test-admin-command-center-host")) {
	customElements.define(
		"test-admin-command-center-host",
		TestAdminCommandCenterHost,
	);
}

describe("AdminCommandCenterTab", () => {
	it("renders enterprise lanes and watchlist from existing admin data", async () => {
		const element = await fixture<TestAdminCommandCenterHost>(
			html`<test-admin-command-center-host></test-admin-command-center-host>`,
		);
		await element.updateComplete;

		const text = (element.shadowRoot?.textContent ?? "").replace(/\s+/g, " ");

		assert.include(text, "Enterprise Command Center");
		assert.include(text, "Needs operator review");
		assert.include(text, "Control-Plane Lanes");
		assert.include(text, "Model Governance");
		assert.include(text, "Data Boundaries");
		assert.include(text, "Enterprise Watchlist");
		assert.include(text, "gpt-5.4");
		assert.include(text, "Run requested a restricted directory");
	});
});
