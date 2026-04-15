/** Recharts bar chart widget. */

import {
	Bar,
	BarChart,
	CartesianGrid,
	Legend,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import type { BarChartComponent } from "../../types/dashboard";
import { ChartTooltip } from "./ChartTooltip";
import { formatNumber, getColor } from "./chart-utils";

export function BarChartWidget({
	title,
	labels,
	datasets,
	stacked,
}: BarChartComponent) {
	const data = labels.map((label, i) => {
		const point: Record<string, unknown> = { name: label };
		for (const ds of datasets) {
			point[ds.label] = ds.data[i] ?? 0;
		}
		return point;
	});

	return (
		<div className="dashboard-chart-container">
			{title && <div className="dashboard-chart-title">{title}</div>}
			<ResponsiveContainer width="100%" height={300}>
				<BarChart data={data}>
					<CartesianGrid
						strokeDasharray="3 3"
						stroke="var(--chart-grid)"
						vertical={false}
					/>
					<XAxis
						dataKey="name"
						tick={{ fill: "var(--text-secondary)", fontSize: 12 }}
						axisLine={false}
						tickLine={false}
					/>
					<YAxis
						tick={{ fill: "var(--text-secondary)", fontSize: 12 }}
						axisLine={false}
						tickLine={false}
						tickFormatter={formatNumber}
						width={40}
					/>
					<Tooltip content={<ChartTooltip />} />
					{datasets.length > 1 && (
						<Legend
							iconType="circle"
							iconSize={8}
							wrapperStyle={{ fontSize: 12, color: "var(--text-secondary)" }}
						/>
					)}
					{datasets.map((ds, i) => (
						<Bar
							key={ds.label}
							dataKey={ds.label}
							fill={getColor(i)}
							radius={[4, 4, 0, 0]}
							stackId={stacked ? "stack" : undefined}
						/>
					))}
				</BarChart>
			</ResponsiveContainer>
		</div>
	);
}
