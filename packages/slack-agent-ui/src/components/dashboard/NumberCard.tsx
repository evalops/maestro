/** Single prominent number/metric card. */

import type { NumberCardComponent } from "../../types/dashboard";

export function NumberCard({
	label,
	value,
	description,
	icon,
	color,
}: NumberCardComponent) {
	return (
		<div className="dashboard-number-card">
			{icon && (
				<div
					className="dashboard-number-icon"
					style={color ? { color, background: `${color}18` } : undefined}
				>
					{icon}
				</div>
			)}
			<div className="dashboard-number-content">
				<span className="dashboard-number-label">{label}</span>
				<span
					className="dashboard-number-value"
					style={color ? { color } : undefined}
				>
					{value}
				</span>
				{description && (
					<span className="dashboard-number-desc">{description}</span>
				)}
			</div>
		</div>
	);
}
