import { assert, describe, it } from "vitest";
import type {
	Alert,
	AuditLog,
	DirectoryRule,
	ModelApproval,
	OrgUsageSummary,
	OrganizationSettings,
	UsageQuota,
} from "./enterprise-api.js";
import { buildEnterpriseControlPlaneSummary } from "./enterprise-control-plane.js";

const usage: OrgUsageSummary = {
	totalTokens: 120_000,
	totalSessions: 18,
	totalUsers: 6,
	topUsers: [],
	modelBreakdown: [],
};

const quota: UsageQuota = {
	userId: "user-1",
	orgId: "org-1",
	tokenQuota: 100_000,
	tokenUsed: 85_000,
	tokenRemaining: 15_000,
	spendLimit: 500,
	spendUsed: 250,
	spendRemaining: 250,
	quotaResetAt: null,
};

const settings: OrganizationSettings = {
	piiRedactionEnabled: true,
	alertWebhooks: ["https://siem.example/events"],
	auditRetentionDays: 365,
};

describe("buildEnterpriseControlPlaneSummary", () => {
	it("rolls existing admin primitives into enterprise posture lanes", () => {
		const alerts: Alert[] = [
			{
				id: "alert-1",
				orgId: "org-1",
				severity: "high",
				type: "policy_drift",
				message: "Directory policy changed outside the release window",
				isRead: false,
				createdAt: "2026-04-20T10:00:00.000Z",
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
				pattern: "/finance/**",
				isAllowed: false,
				priority: 10,
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
				createdAt: "2026-04-20T10:01:00.000Z",
			},
		];

		const summary = buildEnterpriseControlPlaneSummary({
			usage,
			quota,
			alerts,
			auditLogs,
			modelApprovals,
			directoryRules,
			orgSettings: settings,
		});

		assert.equal(summary.posture.label, "Needs operator review");
		assert.include(
			summary.metrics.map((metric) => metric.label),
			"Open Controls",
		);
		assert.include(
			summary.lanes.map((lane) => lane.name),
			"Model Governance",
		);
		assert.equal(
			summary.lanes.find((lane) => lane.name === "Model Governance")?.status,
			"Approval backlog",
		);
		assert.include(
			summary.watchItems.map((item) => item.label),
			"gpt-5.4",
		);
		assert.include(
			summary.watchItems.map((item) => item.label),
			"Quota pressure",
		);
	});

	it("keeps a quiet configured org in ready posture", () => {
		const summary = buildEnterpriseControlPlaneSummary({
			usage,
			quota: { ...quota, tokenUsed: 10_000, tokenRemaining: 90_000 },
			alerts: [],
			auditLogs: [
				{
					id: "audit-1",
					orgId: "org-1",
					userId: "user-1",
					action: "run.completed",
					status: "success",
					createdAt: "2026-04-20T10:01:00.000Z",
				},
			],
			modelApprovals: [
				{
					id: "model-1",
					orgId: "org-1",
					modelId: "gpt-5.4",
					provider: "openai",
					status: "approved",
					spendUsed: 10,
					tokenUsed: 1200,
				},
			],
			directoryRules: [
				{
					id: "rule-1",
					orgId: "org-1",
					pattern: "/workspace/**",
					isAllowed: true,
					priority: 1,
				},
			],
			orgSettings: settings,
		});

		assert.equal(summary.posture.label, "Ready");
		assert.deepEqual(
			summary.watchItems.map((item) => item.id),
			[],
		);
		assert.equal(
			summary.lanes.find((lane) => lane.name === "Audit and SIEM")?.status,
			"Routed",
		);
	});

	it("preserves informational alert severity as an info watchlist tone", () => {
		const summary = buildEnterpriseControlPlaneSummary({
			usage,
			quota: { ...quota, tokenUsed: 10_000, tokenRemaining: 90_000 },
			alerts: [
				{
					id: "alert-1",
					orgId: "org-1",
					severity: "info",
					type: "billing_notice",
					message: "Monthly usage export is ready",
					isRead: false,
					createdAt: "2026-04-20T10:00:00.000Z",
				},
			],
			auditLogs: [],
			modelApprovals: [],
			directoryRules: [
				{
					id: "rule-1",
					orgId: "org-1",
					pattern: "/workspace/**",
					isAllowed: true,
					priority: 1,
				},
			],
			orgSettings: settings,
		});

		assert.equal(
			summary.watchItems.find((item) => item.id === "alert-alert-1")?.severity,
			"info",
		);
	});

	it("treats exceeded spend caps as quota pressure", () => {
		const summary = buildEnterpriseControlPlaneSummary({
			usage,
			quota: {
				...quota,
				tokenQuota: null,
				tokenUsed: 10_000,
				spendLimit: 100,
				spendUsed: 125,
				spendRemaining: 0,
			},
			alerts: [],
			auditLogs: [],
			modelApprovals: [],
			directoryRules: [
				{
					id: "rule-1",
					orgId: "org-1",
					pattern: "/workspace/**",
					isAllowed: true,
					priority: 1,
				},
			],
			orgSettings: settings,
		});

		assert.equal(
			summary.lanes.find((lane) => lane.name === "Quota and Cost")?.status,
			"Exceeded",
		);
		assert.equal(
			summary.watchItems.find((item) => item.id === "quota-pressure")?.severity,
			"error",
		);
		assert.equal(
			summary.lanes.find((lane) => lane.name === "Quota and Cost")?.evidence,
			"10000 tokens used, no token cap; $1.25 of $1.00 spend used",
		);
	});

	it("treats zero quota limits as explicit caps", () => {
		const summary = buildEnterpriseControlPlaneSummary({
			usage,
			quota: {
				...quota,
				tokenQuota: 0,
				tokenUsed: 1,
				tokenRemaining: 0,
				spendLimit: 0,
				spendUsed: 0,
				spendRemaining: 0,
			},
			alerts: [],
			auditLogs: [],
			modelApprovals: [],
			directoryRules: [
				{
					id: "rule-1",
					orgId: "org-1",
					pattern: "/workspace/**",
					isAllowed: true,
					priority: 1,
				},
			],
			orgSettings: settings,
		});

		assert.equal(
			summary.lanes.find((lane) => lane.name === "Quota and Cost")?.status,
			"Exceeded",
		);
		assert.equal(
			summary.lanes.find((lane) => lane.name === "Quota and Cost")?.evidence,
			"1 of 0 tokens used; $0.00 of $0.00 spend used",
		);
	});

	it("marks missing quota snapshots as unavailable", () => {
		const summary = buildEnterpriseControlPlaneSummary({
			usage,
			quota: null,
			alerts: [],
			auditLogs: [],
			modelApprovals: [],
			directoryRules: [
				{
					id: "rule-1",
					orgId: "org-1",
					pattern: "/workspace/**",
					isAllowed: true,
					priority: 1,
				},
			],
			orgSettings: settings,
		});

		assert.equal(
			summary.lanes.find((lane) => lane.name === "Quota and Cost")?.status,
			"Unavailable",
		);
		assert.equal(
			summary.watchItems.find((item) => item.id === "quota-pressure")?.detail,
			"No quota snapshot loaded",
		);
	});
});
