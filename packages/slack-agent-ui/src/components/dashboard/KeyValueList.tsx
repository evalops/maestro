/** Key-value detail pairs list. */

import type { KeyValueListComponent } from "../../types/dashboard";

export function KeyValueList({ title, items }: KeyValueListComponent) {
	return (
		<div className="dashboard-kv-list">
			{title && <div className="dashboard-kv-title">{title}</div>}
			{items.map((item) => (
				<div key={item.key} className="dashboard-kv-item">
					<span className="dashboard-kv-key">{item.key}</span>
					<span
						className="dashboard-kv-value"
						style={item.color ? { color: item.color } : undefined}
					>
						{item.value}
					</span>
				</div>
			))}
		</div>
	);
}
