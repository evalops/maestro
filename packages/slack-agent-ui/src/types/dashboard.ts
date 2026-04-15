/**
 * Dashboard specification types for the React viewer.
 * Pure TypeScript interfaces mirroring the server-side types (no TypeBox).
 */

export interface StatItem {
	label: string;
	value: string;
	change?: string;
	trend?: "up" | "down" | "neutral";
	icon?: string;
	description?: string;
}

export interface ChartDataset {
	label: string;
	data: number[];
}

export interface TableColumn {
	key: string;
	label: string;
	align?: "left" | "center" | "right";
	sortable?: boolean;
}

export interface ActivityItem {
	text: string;
	time?: string;
	color?: string;
}

export interface ProgressItem {
	label: string;
	value: number;
	max?: number;
	color?: string;
}

export interface KeyValueItem {
	key: string;
	value: string;
	color?: string;
}

// ── Component types ────────────────────────────────

export interface StatGroupComponent {
	type: "stat-group";
	items: StatItem[];
}

export interface BarChartComponent {
	type: "bar-chart";
	title?: string;
	labels: string[];
	datasets: ChartDataset[];
	stacked?: boolean;
}

export interface LineChartComponent {
	type: "line-chart";
	title?: string;
	labels: string[];
	datasets: ChartDataset[];
}

export interface AreaChartComponent {
	type: "area-chart";
	title?: string;
	labels: string[];
	datasets: ChartDataset[];
}

export interface PieChartComponent {
	type: "pie-chart";
	title?: string;
	labels: string[];
	data: number[];
	colors?: string[];
}

export interface DoughnutChartComponent {
	type: "doughnut-chart";
	title?: string;
	labels: string[];
	data: number[];
	colors?: string[];
}

export interface TableComponent {
	type: "table";
	title?: string;
	columns: TableColumn[];
	rows: Record<string, unknown>[];
}

export interface ActivityFeedComponent {
	type: "activity-feed";
	title?: string;
	items: ActivityItem[];
}

export interface ProgressBarComponent {
	type: "progress-bar";
	title?: string;
	items: ProgressItem[];
}

export interface NumberCardComponent {
	type: "number-card";
	label: string;
	value: string;
	description?: string;
	icon?: string;
	color?: string;
}

export interface SectionHeaderComponent {
	type: "section-header";
	title: string;
	description?: string;
}

export interface KeyValueListComponent {
	type: "key-value-list";
	title?: string;
	items: KeyValueItem[];
}

export type DashboardComponent =
	| StatGroupComponent
	| BarChartComponent
	| LineChartComponent
	| AreaChartComponent
	| PieChartComponent
	| DoughnutChartComponent
	| TableComponent
	| ActivityFeedComponent
	| ProgressBarComponent
	| NumberCardComponent
	| SectionHeaderComponent
	| KeyValueListComponent;

export interface DashboardSpec {
	title: string;
	subtitle?: string;
	theme?: "dark" | "light";
	generatedAt?: string;
	components: DashboardComponent[];
}
