/**
 * Dashboard specification types and TypeBox schema.
 *
 * Defines the JSON structure that agents provide to build_dashboard.
 * The schema is intentionally loose (additionalProperties: true) so
 * the LLM can construct component specs reliably without needing to
 * match a strict discriminated union.
 */

import { type Static, Type } from "@sinclair/typebox";

// ── TypeScript interfaces ──────────────────────────────────────────

export interface StatItem {
	label: string;
	value: string;
	change?: string;
	trend?: "up" | "down" | "neutral";
}

export interface ChartDataset {
	label: string;
	data: number[];
}

export interface TableColumn {
	key: string;
	label: string;
	align?: "left" | "center" | "right";
}

export interface ActivityItem {
	text: string;
	time?: string;
	color?: string;
}

export interface StatGroupComponent {
	type: "stat-group";
	items: StatItem[];
}

export interface BarChartComponent {
	type: "bar-chart";
	labels: string[];
	datasets: ChartDataset[];
	stacked?: boolean;
}

export interface LineChartComponent {
	type: "line-chart";
	labels: string[];
	datasets: ChartDataset[];
}

export interface AreaChartComponent {
	type: "area-chart";
	labels: string[];
	datasets: ChartDataset[];
}

export interface PieChartComponent {
	type: "pie-chart";
	labels: string[];
	data: number[];
	colors?: string[];
}

export interface DoughnutChartComponent {
	type: "doughnut-chart";
	labels: string[];
	data: number[];
	colors?: string[];
}

export interface TableComponent {
	type: "table";
	columns: TableColumn[];
	rows: Record<string, unknown>[];
}

export interface ActivityFeedComponent {
	type: "activity-feed";
	items: ActivityItem[];
}

export type DashboardComponent =
	| StatGroupComponent
	| BarChartComponent
	| LineChartComponent
	| AreaChartComponent
	| PieChartComponent
	| DoughnutChartComponent
	| TableComponent
	| ActivityFeedComponent;

export interface DashboardSpec {
	title: string;
	subtitle?: string;
	theme?: "dark" | "light";
	generatedAt?: string;
	components: DashboardComponent[];
}

// ── TypeBox schema (intentionally loose for LLM tool calling) ──────

const ComponentSchema = Type.Object(
	{
		type: Type.String({
			description:
				"Component type: stat-group, bar-chart, line-chart, area-chart, pie-chart, doughnut-chart, table, activity-feed",
		}),
	},
	{ additionalProperties: true },
);

export const DashboardSpecSchema = Type.Object({
	label: Type.String({
		description:
			"Brief description shown to user (e.g., 'Build MRR dashboard')",
	}),
	title: Type.String({ description: "Dashboard title" }),
	subtitle: Type.Optional(
		Type.String({ description: "Subtitle shown below the title" }),
	),
	theme: Type.Optional(
		Type.Union([Type.Literal("dark"), Type.Literal("light")], {
			description: "Color theme (default: dark)",
			default: "dark",
		}),
	),
	components: Type.Array(ComponentSchema, {
		description: "Array of dashboard components to render",
	}),
	auto_deploy: Type.Optional(
		Type.Boolean({
			description: "Automatically deploy and return a URL (default: true)",
			default: true,
		}),
	),
	port: Type.Optional(
		Type.Number({
			description: "Port to serve on (default: 8080)",
			default: 8080,
		}),
	),
	expiresIn: Type.Optional(
		Type.Number({
			description: "Preview URL expiry in seconds (default: 3600)",
			default: 3600,
		}),
	),
});

export type DashboardSpecInput = Static<typeof DashboardSpecSchema>;
