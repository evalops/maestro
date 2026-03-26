/** Grid of KPI metric cards. */

import type { StatGroupComponent } from "../../types/dashboard";

export function StatGroup({ items }: StatGroupComponent) {
	return (
		<div className="dashboard-stat-grid">
			{items.map((stat) => (
				<div key={stat.label} className="dashboard-stat-card">
					<div className="dashboard-stat-top">
						{stat.icon && (
							<span className="dashboard-stat-icon">{stat.icon}</span>
						)}
						<span className="dashboard-stat-label">{stat.label}</span>
					</div>
					<span className="dashboard-stat-value">{stat.value}</span>
					{stat.change && (
						<span
							className="dashboard-stat-change"
							data-trend={stat.trend ?? "neutral"}
						>
							{stat.trend === "up" && "\u25B2 "}
							{stat.trend === "down" && "\u25BC "}
							{stat.change}
						</span>
					)}
					{stat.description && (
						<span className="dashboard-stat-desc">{stat.description}</span>
					)}
				</div>
			))}
		</div>
	);
}
