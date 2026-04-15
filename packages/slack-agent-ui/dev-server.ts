#!/usr/bin/env npx tsx
/**
 * Standalone API server for local UI development.
 * Starts the API server on port 3200 with file-based storage so the
 * React UI (Vite on port 3100) can proxy /api calls here.
 *
 * Usage: npx tsx packages/slack-agent-ui/dev-server.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebhookTriggerManager } from "../slack-agent/src/connectors/webhook-triggers.js";
import { generateDashboardHtml } from "../slack-agent/src/dashboard/renderer.js";
import type { DashboardSpec } from "../slack-agent/src/dashboard/types.js";
import { createApiServer } from "../slack-agent/src/ui/api-server.js";
import { DashboardRegistry } from "../slack-agent/src/ui/dashboard-registry.js";
import { createWebhookServer } from "../slack-agent/src/webhooks.js";

const PORT = Number(process.env.SLACK_AGENT_UI_PORT) || 3200;
const WEBHOOK_PORT = Number(process.env.SLACK_AGENT_UI_WEBHOOK_PORT) || 3201;
const DATA_DIR = join(import.meta.dirname, ".dev-data");
const DEV_TEAM_ID = "T_DEV";
const WORKSPACE_DIR = join(DATA_DIR, "workspaces", DEV_TEAM_ID);
const DEV_ASSETS_DIR = join(import.meta.dirname, "dev-assets");

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(WORKSPACE_DIR, { recursive: true });
mkdirSync(DEV_ASSETS_DIR, { recursive: true });

// Seed a fake installed workspace so /api/workspaces/:teamId routes are usable locally.
writeFileSync(
	join(DATA_DIR, "workspaces.json"),
	JSON.stringify(
		[
			{
				id: "dev",
				teamId: DEV_TEAM_ID,
				teamName: "Dev Workspace",
				botToken: "xoxb-dev",
				botUserId: "U_DEV_BOT",
				installedBy: "U_DEV_ADMIN",
				installedAt: new Date().toISOString(),
				status: "active",
			},
		],
		null,
		2,
	),
);

const dashboardRegistry = new DashboardRegistry(WORKSPACE_DIR);

// Seed sample dashboards so the UI isn't empty (re-seed if none have spec)
const existingDashboards = dashboardRegistry.list();
if (
	existingDashboards.length === 0 ||
	!existingDashboards.some((d) => d.spec)
) {
	for (const d of existingDashboards) dashboardRegistry.remove(d.id);
	// Generate comprehensive sample dashboard with all component types.
	// Uses extended component types (progress-bar, number-card, etc.) that
	// the backend schema accepts via additionalProperties but aren't in its
	// TS interfaces, so we cast here.
	const sampleSpec = {
		title: "Sales Pipeline Overview",
		subtitle: "Q1 2026 performance across all regions",
		theme: "dark",
		generatedAt: new Date().toISOString(),
		components: [
			// ── KPI stats ──────────────────────────────────
			{
				type: "stat-group",
				items: [
					{
						label: "Total Revenue",
						value: "$1.24M",
						change: "+12.5% vs last quarter",
						trend: "up",
						icon: "💰",
						description: "All closed-won deals",
					},
					{
						label: "Active Pipeline",
						value: "$3.8M",
						change: "+18% vs last quarter",
						trend: "up",
						icon: "📈",
						description: "Weighted pipeline value",
					},
					{
						label: "Win Rate",
						value: "34.2%",
						change: "-2.1% vs last quarter",
						trend: "down",
						icon: "🎯",
						description: "Closed-won / total",
					},
					{
						label: "Avg Deal Size",
						value: "$18.4k",
						change: "+$2.1k vs last quarter",
						trend: "up",
						icon: "📊",
					},
					{
						label: "Sales Cycle",
						value: "32 days",
						change: "-4 days vs last quarter",
						trend: "up",
						icon: "⏱️",
					},
					{
						label: "Net Retention",
						value: "118%",
						change: "+3% vs last quarter",
						trend: "up",
						icon: "🔄",
					},
				],
			},

			// ── Revenue chart ──────────────────────────────
			{
				type: "area-chart",
				title: "Monthly Revenue Trend",
				labels: ["Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"],
				datasets: [
					{
						label: "Revenue",
						data: [82, 95, 88, 110, 124, 108, 135, 142, 156],
					},
					{
						label: "Target",
						data: [90, 95, 100, 105, 110, 115, 120, 130, 140],
					},
				],
			},

			// ── Stacked bar chart ──────────────────────────
			{
				type: "bar-chart",
				title: "Deals by Stage",
				labels: ["Discovery", "Qualified", "Proposal", "Negotiation", "Closed"],
				datasets: [
					{ label: "Enterprise", data: [14, 8, 6, 4, 3] },
					{ label: "Mid-Market", data: [22, 15, 11, 7, 5] },
					{ label: "SMB", data: [31, 18, 9, 4, 2] },
				],
				stacked: true,
			},

			// ── Pipeline by source ─────────────────────────
			{
				type: "doughnut-chart",
				title: "Pipeline by Lead Source",
				labels: ["Inbound", "Outbound", "Partner", "Events", "Referral"],
				data: [38, 24, 18, 12, 8],
				colors: ["#6366f1", "#818cf8", "#a5b4fc", "#c7d2fe", "#e0e7ff"],
			},

			// ── Section header ─────────────────────────────
			{
				type: "section-header",
				title: "Team Performance",
				description: "Individual rep metrics and quota attainment for Q1",
			},

			// ── Progress bars ──────────────────────────────
			{
				type: "progress-bar",
				title: "Quota Attainment",
				items: [
					{ label: "Sarah Kim", value: 142, max: 150, color: "#22c55e" },
					{ label: "Mike Reynolds", value: 118, max: 150, color: "#6366f1" },
					{ label: "Aya Tanaka", value: 96, max: 150, color: "#f59e0b" },
					{ label: "James Chen", value: 78, max: 150, color: "#ef4444" },
					{ label: "Priya Sharma", value: 134, max: 150, color: "#22c55e" },
				],
			},

			// ── Number cards ───────────────────────────────
			{
				type: "number-card",
				label: "Meetings Booked",
				value: "284",
				description: "This quarter across all reps",
				icon: "📅",
			},
			{
				type: "number-card",
				label: "Proposals Sent",
				value: "67",
				description: "+12 this week",
				icon: "📤",
			},

			// ── Line chart (multi-dataset) ─────────────────
			{
				type: "line-chart",
				title: "Weekly Activity Trend",
				labels: [
					"W1",
					"W2",
					"W3",
					"W4",
					"W5",
					"W6",
					"W7",
					"W8",
					"W9",
					"W10",
					"W11",
					"W12",
				],
				datasets: [
					{
						label: "Calls",
						data: [45, 52, 38, 61, 55, 48, 72, 65, 58, 80, 76, 84],
					},
					{
						label: "Emails",
						data: [120, 135, 110, 142, 128, 155, 148, 160, 145, 170, 162, 178],
					},
					{
						label: "Demos",
						data: [8, 12, 6, 14, 11, 9, 16, 13, 10, 18, 15, 20],
					},
				],
			},

			// ── Pie chart ──────────────────────────────────
			{
				type: "pie-chart",
				title: "Deal Size Distribution",
				labels: ["< $5k", "$5k-15k", "$15k-50k", "$50k-100k", "> $100k"],
				data: [18, 35, 28, 14, 5],
				colors: ["#e0e7ff", "#a5b4fc", "#6366f1", "#4f46e5", "#3730a3"],
			},

			// ── Key-value list ─────────────────────────────
			{
				type: "key-value-list",
				title: "Pipeline Summary",
				items: [
					{ key: "Total Opportunities", value: "142" },
					{ key: "Weighted Value", value: "$3.8M" },
					{ key: "Expected Close (30d)", value: "$890k", color: "#22c55e" },
					{ key: "At Risk", value: "$420k", color: "#ef4444" },
					{ key: "Average Age", value: "28 days" },
					{ key: "Next Quarter Forecast", value: "$1.6M", color: "#6366f1" },
				],
			},

			// ── Section header ─────────────────────────────
			{
				type: "section-header",
				title: "Deal Details",
				description: "Active deals across all stages sorted by value",
			},

			// ── Full-width data table ──────────────────────
			{
				type: "table",
				title: "Active Deals",
				columns: [
					{ key: "deal", label: "Deal Name" },
					{ key: "company", label: "Company" },
					{ key: "value", label: "Value", align: "right" as const },
					{ key: "stage", label: "Stage" },
					{ key: "probability", label: "Prob.", align: "right" as const },
					{ key: "owner", label: "Owner" },
					{ key: "nextStep", label: "Next Step" },
				],
				rows: [
					{
						deal: "Enterprise Platform",
						company: "Acme Corp",
						value: "$124,000",
						stage: "Negotiation",
						probability: "80%",
						owner: "Sarah K.",
						nextStep: "Contract review",
					},
					{
						deal: "Data Migration Suite",
						company: "TechStart Inc",
						value: "$86,500",
						stage: "Proposal",
						probability: "60%",
						owner: "Mike R.",
						nextStep: "Technical demo",
					},
					{
						deal: "API Integration",
						company: "Global Systems",
						value: "$52,000",
						stage: "Qualified",
						probability: "40%",
						owner: "Sarah K.",
						nextStep: "Requirements doc",
					},
					{
						deal: "Analytics Pro",
						company: "NextGen AI",
						value: "$45,200",
						stage: "Proposal",
						probability: "55%",
						owner: "Aya T.",
						nextStep: "Pricing approval",
					},
					{
						deal: "Support Premium",
						company: "DataFlow Ltd",
						value: "$38,400",
						stage: "Discovery",
						probability: "25%",
						owner: "James C.",
						nextStep: "Stakeholder meeting",
					},
					{
						deal: "Cloud Deployment",
						company: "Meridian Labs",
						value: "$67,000",
						stage: "Negotiation",
						probability: "75%",
						owner: "Priya S.",
						nextStep: "Legal review",
					},
					{
						deal: "Security Audit Tool",
						company: "Fortis Inc",
						value: "$29,800",
						stage: "Qualified",
						probability: "35%",
						owner: "Mike R.",
						nextStep: "POC setup",
					},
					{
						deal: "Workflow Automation",
						company: "Syncra.io",
						value: "$41,500",
						stage: "Proposal",
						probability: "50%",
						owner: "Aya T.",
						nextStep: "ROI presentation",
					},
				],
			},

			// ── Activity feed ──────────────────────────────
			{
				type: "activity-feed",
				title: "Recent Activity",
				items: [
					{
						text: 'Deal "Acme Corp Enterprise Platform" moved to Negotiation',
						time: "2 min ago",
						color: "#22c55e",
					},
					{
						text: "New lead from HubSpot: TechStart Inc — qualified by SDR",
						time: "15 min ago",
						color: "#3b82f6",
					},
					{
						text: 'Sarah K. closed "Meridian Labs" for $67,000',
						time: "1 hour ago",
						color: "#22c55e",
					},
					{
						text: "Follow-up reminder: Global Systems proposal review",
						time: "2 hours ago",
						color: "#eab308",
					},
					{
						text: "Mike R. scheduled demo with Fortis Inc (Thursday 2pm)",
						time: "3 hours ago",
						color: "#6366f1",
					},
					{
						text: 'Deal "Omega Ltd" marked as Lost — budget freeze',
						time: "5 hours ago",
						color: "#ef4444",
					},
					{
						text: "Weekly pipeline report sent to #sales-leadership",
						time: "6 hours ago",
						color: "#6366f1",
					},
				],
			},
		],
	};

	const sampleHtml = generateDashboardHtml(sampleSpec as DashboardSpec);
	writeFileSync(join(DEV_ASSETS_DIR, "sample-dashboard.html"), sampleHtml);

	dashboardRegistry.register({
		label: "Sales Pipeline Overview",
		url: `http://localhost:${PORT}/sample-dashboard.html`,
		directory: "/app/dashboards/sales-pipeline",
		port: 8080,
		expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
		spec: sampleSpec as DashboardSpec,
	});
}

const server = createApiServer({
	port: PORT,
	workingDir: DATA_DIR,
	host: "127.0.0.1",
	staticDir: DEV_ASSETS_DIR,
	slackOAuth:
		process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET
			? {
					clientId: process.env.SLACK_CLIENT_ID,
					clientSecret: process.env.SLACK_CLIENT_SECRET,
					scopes: process.env.SLACK_OAUTH_SCOPES
						? process.env.SLACK_OAUTH_SCOPES.split(",")
								.map((s) => s.trim())
								.filter(Boolean)
						: undefined,
					redirectUri: process.env.SLACK_OAUTH_REDIRECT_URI,
					stateSecret: process.env.SLACK_OAUTH_STATE_SECRET,
				}
			: undefined,
});

await server.start();
console.log(`\n  API server running at http://localhost:${PORT}/api/health`);
console.log("  UI dev server should be at http://localhost:3100/\n");

// Also start a webhook ingestion server for local trigger testing.
// In production this is usually run separately and/or placed behind a reverse proxy.
const triggerManager = new WebhookTriggerManager(WORKSPACE_DIR);
triggerManager.setRunCallback(async (channel, prompt) => {
	// This is a dev stub. Real runs happen in the Slack runtime.
	console.log(`  [dev trigger] would run in #${channel}: ${prompt}`);
});

const webhookServer = createWebhookServer(
	{
		port: WEBHOOK_PORT,
		defaultTeamId: DEV_TEAM_ID,
	},
	async (event) => {
		const fired = await triggerManager.processEvent(event);
		console.log(
			`  [dev webhook] ${event.source} for ${event.teamId} fired ${fired}`,
		);
	},
);

await webhookServer.start();
console.log(
	`  Webhook server running at http://localhost:${WEBHOOK_PORT}/webhooks/health\n`,
);
