/** Timeline activity feed component. */

import type { ActivityFeedComponent } from "../../types/dashboard";

export function ActivityFeed({ title, items }: ActivityFeedComponent) {
	return (
		<div className="dashboard-feed">
			{title && (
				<div className="dashboard-chart-title dashboard-feed-title">
					{title}
				</div>
			)}
			<div className="dashboard-feed-items">
				{items.map((item) => (
					<div key={item.text} className="dashboard-feed-item">
						<span
							className="dashboard-feed-dot"
							style={{ background: item.color ?? "var(--accent)" }}
						/>
						<div className="dashboard-feed-content">
							<span className="dashboard-feed-text">{item.text}</span>
							{item.time && (
								<span className="dashboard-feed-time">{item.time}</span>
							)}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
