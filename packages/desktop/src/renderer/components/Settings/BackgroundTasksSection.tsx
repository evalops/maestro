import { useMemo } from "react";
import type { BackgroundStatus } from "../../lib/api-client";

export interface BackgroundTasksViewModel {
	notificationsEnabledLabel: string;
	statusDetailsEnabledLabel: string;
	runningCount: number;
	failedCount: number;
	totalCount: number;
}

export interface BackgroundTasksSectionProps {
	backgroundStatus: BackgroundStatus | null;
	onUpdateNotifications: (enabled: boolean) => Promise<void> | void;
	onUpdateStatusDetails: (enabled: boolean) => Promise<void> | void;
}

export function buildBackgroundTasksViewModel(
	status: BackgroundStatus | null,
): BackgroundTasksViewModel {
	return {
		notificationsEnabledLabel: status?.settings.notificationsEnabled
			? "On"
			: "Off",
		statusDetailsEnabledLabel: status?.settings.statusDetailsEnabled
			? "On"
			: "Off",
		runningCount: status?.snapshot?.running ?? 0,
		failedCount: status?.snapshot?.failed ?? 0,
		totalCount: status?.snapshot?.total ?? 0,
	};
}

export function BackgroundTasksSection({
	backgroundStatus,
	onUpdateNotifications,
	onUpdateStatusDetails,
}: BackgroundTasksSectionProps) {
	const background = useMemo(
		() => buildBackgroundTasksViewModel(backgroundStatus),
		[backgroundStatus],
	);

	return (
		<section className="border border-line-subtle rounded-xl overflow-hidden">
			<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
				Background Tasks
			</div>
			<div className="p-4 space-y-4">
				<div className="flex items-center justify-between gap-4">
					<div>
						<div className="text-text-primary font-medium">Notifications</div>
						<div className="text-xs text-text-muted">
							Slash command: /background notify
						</div>
					</div>
					<label className="inline-flex items-center gap-2 text-xs text-text-tertiary">
						<input
							type="checkbox"
							checked={backgroundStatus?.settings.notificationsEnabled ?? false}
							onChange={(event) => onUpdateNotifications(event.target.checked)}
							className="h-4 w-4 rounded border-line-subtle bg-bg-tertiary text-accent focus:ring-accent"
						/>
						<span>{background.notificationsEnabledLabel}</span>
					</label>
				</div>
				<div className="flex items-center justify-between gap-4">
					<div>
						<div className="text-text-primary font-medium">Status details</div>
						<div className="text-xs text-text-muted">
							Slash command: /background details
						</div>
					</div>
					<label className="inline-flex items-center gap-2 text-xs text-text-tertiary">
						<input
							type="checkbox"
							checked={backgroundStatus?.settings.statusDetailsEnabled ?? false}
							onChange={(event) => onUpdateStatusDetails(event.target.checked)}
							className="h-4 w-4 rounded border-line-subtle bg-bg-tertiary text-accent focus:ring-accent"
						/>
						<span>{background.statusDetailsEnabledLabel}</span>
					</label>
				</div>
				<div className="text-xs text-text-muted">
					Running: {background.runningCount} · Failed: {background.failedCount}{" "}
					· Total: {background.totalCount}
				</div>
			</div>
		</section>
	);
}
