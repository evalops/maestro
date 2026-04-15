import { useMemo } from "react";

export type SessionBehaviorQueueMode = "one" | "all";

export interface SessionBehaviorViewModel {
	queueMode: SessionBehaviorQueueMode;
	queueModeDisabled: boolean;
	showSessionWarning: boolean;
}

export interface SessionBehaviorSectionProps {
	hasSession: boolean;
	queueMode: SessionBehaviorQueueMode;
	onUpdateQueueMode: (mode: SessionBehaviorQueueMode) => Promise<void> | void;
}

export function buildSessionBehaviorViewModel(
	hasSession: boolean,
	queueMode: SessionBehaviorQueueMode,
): SessionBehaviorViewModel {
	return {
		queueMode,
		queueModeDisabled: !hasSession,
		showSessionWarning: !hasSession,
	};
}

export function SessionBehaviorSection({
	hasSession,
	queueMode,
	onUpdateQueueMode,
}: SessionBehaviorSectionProps) {
	const sessionBehavior = useMemo(
		() => buildSessionBehaviorViewModel(hasSession, queueMode),
		[hasSession, queueMode],
	);

	return (
		<section className="border border-line-subtle rounded-xl overflow-hidden">
			<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
				Session Behavior
			</div>
			<div className="p-4 space-y-4">
				{sessionBehavior.showSessionWarning && (
					<div className="text-xs text-text-muted">
						Start a session to enable session-scoped settings.
					</div>
				)}

				<div className="flex items-center justify-between gap-4">
					<div>
						<div className="text-text-primary font-medium">Queue mode</div>
						<div className="text-xs text-text-muted">
							How follow-up prompts are queued.
						</div>
					</div>
					<select
						disabled={sessionBehavior.queueModeDisabled}
						value={sessionBehavior.queueMode}
						onChange={(event) =>
							onUpdateQueueMode(event.target.value as SessionBehaviorQueueMode)
						}
						className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary disabled:opacity-50"
					>
						<option value="one">One</option>
						<option value="all">All</option>
					</select>
				</div>
			</div>
		</section>
	);
}
