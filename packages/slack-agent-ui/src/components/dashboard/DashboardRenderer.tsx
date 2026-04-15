/** Main orchestrator: renders a DashboardSpec as native React components. */

import type { DashboardSpec } from "../../types/dashboard";
import { ActivityFeed } from "./ActivityFeed";
import { AreaChartWidget } from "./AreaChartWidget";
import { BarChartWidget } from "./BarChartWidget";
import { DataTable } from "./DataTable";
import { KeyValueList } from "./KeyValueList";
import { LineChartWidget } from "./LineChartWidget";
import { NumberCard } from "./NumberCard";
import { PieChartWidget } from "./PieChartWidget";
import { ProgressBar } from "./ProgressBar";
import { SectionHeader } from "./SectionHeader";
import { StatGroup } from "./StatGroup";

interface Props {
	spec: DashboardSpec;
}

/** Components that should span full width in the 2-column grid. */
const FULL_WIDTH_TYPES = new Set([
	"stat-group",
	"section-header",
	"table",
	"activity-feed",
]);

export function DashboardRenderer({ spec }: Props) {
	return (
		<div className="dashboard-grid">
			{spec.components.map((component, i) => {
				const isFull = FULL_WIDTH_TYPES.has(component.type);
				return (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: static dashboard sections don't reorder
						key={i}
						className={`dashboard-section${isFull ? " dashboard-section-full" : ""}`}
					>
						{renderComponent(component)}
					</div>
				);
			})}
		</div>
	);
}

function renderComponent(component: DashboardSpec["components"][number]) {
	switch (component.type) {
		case "stat-group":
			return <StatGroup {...component} />;
		case "bar-chart":
			return <BarChartWidget {...component} />;
		case "line-chart":
			return <LineChartWidget {...component} />;
		case "area-chart":
			return <AreaChartWidget {...component} />;
		case "pie-chart":
			return <PieChartWidget {...component} />;
		case "doughnut-chart":
			return <PieChartWidget {...component} doughnut />;
		case "table":
			return <DataTable {...component} />;
		case "activity-feed":
			return <ActivityFeed {...component} />;
		case "progress-bar":
			return <ProgressBar {...component} />;
		case "number-card":
			return <NumberCard {...component} />;
		case "section-header":
			return <SectionHeader {...component} />;
		case "key-value-list":
			return <KeyValueList {...component} />;
		default:
			return null;
	}
}
