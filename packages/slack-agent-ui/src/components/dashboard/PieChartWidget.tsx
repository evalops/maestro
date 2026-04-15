/** Recharts pie/doughnut chart widget. */

import {
	Cell,
	Legend,
	Pie,
	PieChart,
	ResponsiveContainer,
	Tooltip,
} from "recharts";
import type {
	DoughnutChartComponent,
	PieChartComponent,
} from "../../types/dashboard";
import { ChartTooltip } from "./ChartTooltip";
import { COLORS, getColor } from "./chart-utils";

interface Props {
	title?: string;
	labels: string[];
	data: number[];
	colors?: string[];
	doughnut?: boolean;
}

export function PieChartWidget(
	props: (PieChartComponent | DoughnutChartComponent) & { doughnut?: boolean },
) {
	return <PieChartInner {...props} />;
}

function PieChartInner({ title, labels, data, colors, doughnut }: Props) {
	const chartData = labels.map((label, i) => ({
		name: label,
		value: data[i] ?? 0,
	}));

	const palette = colors?.length ? colors : COLORS;

	return (
		<div className="dashboard-chart-container">
			{title && <div className="dashboard-chart-title">{title}</div>}
			<ResponsiveContainer width="100%" height={320}>
				<PieChart>
					<Pie
						data={chartData}
						dataKey="value"
						nameKey="name"
						cx="45%"
						cy="50%"
						innerRadius={doughnut ? 70 : 0}
						outerRadius={120}
						paddingAngle={2}
					>
						{chartData.map((entry, i) => (
							<Cell
								key={entry.name}
								fill={palette[i % palette.length] ?? getColor(i)}
							/>
						))}
					</Pie>
					<Tooltip content={<ChartTooltip />} />
					<Legend
						layout="vertical"
						align="right"
						verticalAlign="middle"
						iconType="circle"
						iconSize={8}
						formatter={(value: string) => (
							<span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
								{value}
							</span>
						)}
					/>
				</PieChart>
			</ResponsiveContainer>
		</div>
	);
}
