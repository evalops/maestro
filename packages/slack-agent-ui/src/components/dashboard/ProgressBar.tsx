/** Progress bar component with multiple items. */

import type { ProgressBarComponent } from "../../types/dashboard";
import { getColor } from "./chart-utils";

export function ProgressBar({ title, items }: ProgressBarComponent) {
	return (
		<div className="dashboard-progress-list">
			{title && <div className="dashboard-progress-title">{title}</div>}
			{items.map((item, i) => {
				const max = item.max ?? 100;
				const pct = Math.min(100, Math.max(0, (item.value / max) * 100));
				const color = item.color ?? getColor(i);
				return (
					<div key={item.label} className="dashboard-progress-item">
						<div className="dashboard-progress-meta">
							<span className="dashboard-progress-label">{item.label}</span>
							<span className="dashboard-progress-value">
								{item.value}
								{max !== 100 ? ` / ${max}` : "%"}
							</span>
						</div>
						<div className="dashboard-progress-track">
							<div
								className="dashboard-progress-fill"
								style={{ width: `${pct}%`, background: color }}
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}
