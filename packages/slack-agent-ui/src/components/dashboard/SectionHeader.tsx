/** Visual section divider with title and optional description. */

import type { SectionHeaderComponent } from "../../types/dashboard";

export function SectionHeader({ title, description }: SectionHeaderComponent) {
	return (
		<div className="dashboard-section-header">
			<h2 className="dashboard-section-title">{title}</h2>
			{description && <p className="dashboard-section-desc">{description}</p>}
		</div>
	);
}
