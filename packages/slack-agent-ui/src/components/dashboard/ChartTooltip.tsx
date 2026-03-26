/** Custom Recharts tooltip matching the dashboard dark-card style. */

interface TooltipPayloadEntry {
	name?: string;
	value?: number;
	color?: string;
}

interface ChartTooltipProps {
	active?: boolean;
	payload?: readonly TooltipPayloadEntry[];
	label?: string | number;
}

export function ChartTooltip({ active, payload, label }: ChartTooltipProps) {
	if (!active || !payload?.length) return null;

	return (
		<div className="dashboard-tooltip">
			{label != null && <div className="dashboard-tooltip-label">{label}</div>}
			{payload.map((entry) => (
				<div key={entry.name} className="dashboard-tooltip-row">
					<span
						className="dashboard-tooltip-dot"
						style={{ background: entry.color }}
					/>
					<span className="dashboard-tooltip-name">{entry.name}</span>
					<span className="dashboard-tooltip-value">{entry.value}</span>
				</div>
			))}
		</div>
	);
}
