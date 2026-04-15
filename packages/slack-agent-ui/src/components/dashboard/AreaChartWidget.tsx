/** Recharts area chart widget with gradient fills. */

import {
	Area,
	AreaChart,
	CartesianGrid,
	Legend,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import type { AreaChartComponent } from "../../types/dashboard";
import { ChartTooltip } from "./ChartTooltip";
import { formatNumber, getColor } from "./chart-utils";

export function AreaChartWidget({
	title,
	labels,
	datasets,
}: AreaChartComponent) {
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
				<AreaChart data={data}>
					<defs>
						{datasets.map((ds, i) => (
							<linearGradient
								key={ds.label}
								id={`gradient-${i}`}
								x1="0"
								y1="0"
								x2="0"
								y2="1"
							>
								<stop offset="5%" stopColor={getColor(i)} stopOpacity={0.3} />
								<stop offset="95%" stopColor={getColor(i)} stopOpacity={0} />
							</linearGradient>
						))}
					</defs>
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
						<Area
							key={ds.label}
							type="monotone"
							dataKey={ds.label}
							stroke={getColor(i)}
							strokeWidth={2}
							fill={`url(#gradient-${i})`}
						/>
					))}
				</AreaChart>
			</ResponsiveContainer>
		</div>
	);
}
