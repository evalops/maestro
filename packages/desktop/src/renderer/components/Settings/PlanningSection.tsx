import { useMemo } from "react";
import type { PlanStatus } from "../../lib/api-client";

export interface PlanningViewModel {
	isActive: boolean;
	actionLabel: "Start plan" | "Exit plan";
	showNameInput: boolean;
	showEditor: boolean;
	planFileLabel: string;
	saveDisabled: boolean;
}

export interface PlanningSectionProps {
	planStatus: PlanStatus | null;
	planDraft: string;
	planDirty: boolean;
	planName: string;
	onPlanNameChange: (name: string) => void;
	onPlanDraftChange: (draft: string) => void;
	onStartPlan: () => Promise<void> | void;
	onExitPlan: () => Promise<void> | void;
	onSavePlan: () => Promise<void> | void;
}

export function buildPlanningViewModel(
	status: PlanStatus | null,
	planDirty: boolean,
): PlanningViewModel {
	const isActive = Boolean(status?.state?.active);

	return {
		isActive,
		actionLabel: isActive ? "Exit plan" : "Start plan",
		showNameInput: !isActive,
		showEditor: isActive,
		planFileLabel: status?.state?.filePath || "Plan file not created yet",
		saveDisabled: !planDirty,
	};
}

export function PlanningSection({
	planStatus,
	planDraft,
	planDirty,
	planName,
	onPlanNameChange,
	onPlanDraftChange,
	onStartPlan,
	onExitPlan,
	onSavePlan,
}: PlanningSectionProps) {
	const planning = useMemo(
		() => buildPlanningViewModel(planStatus, planDirty),
		[planStatus, planDirty],
	);

	return (
		<section className="border border-line-subtle rounded-xl overflow-hidden">
			<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
				Planning
			</div>
			<div className="p-4 space-y-4">
				<div className="flex items-center justify-between gap-4">
					<div>
						<div className="text-text-primary font-medium">Plan mode</div>
						<div className="text-xs text-text-muted">Slash command: /plan</div>
					</div>
					<div className="flex items-center gap-2">
						{planning.isActive ? (
							<button
								type="button"
								className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
								onClick={onExitPlan}
							>
								{planning.actionLabel}
							</button>
						) : (
							<button
								type="button"
								className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
								onClick={onStartPlan}
							>
								{planning.actionLabel}
							</button>
						)}
					</div>
				</div>
				{planning.showNameInput && (
					<div className="flex items-center justify-between gap-4">
						<div className="text-xs text-text-muted">Optional plan name</div>
						<input
							type="text"
							value={planName}
							onChange={(event) => onPlanNameChange(event.target.value)}
							placeholder="Feature rollout plan"
							className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary w-64"
						/>
					</div>
				)}
				{planning.showEditor && (
					<div className="space-y-3">
						<textarea
							value={planDraft}
							onChange={(event) => onPlanDraftChange(event.target.value)}
							rows={6}
							className="w-full bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
						/>
						<div className="flex items-center justify-between gap-4">
							<button
								type="button"
								className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-50"
								onClick={onSavePlan}
								disabled={planning.saveDisabled}
							>
								Save plan
							</button>
							<div className="text-xs text-text-muted">
								{planning.planFileLabel}
							</div>
						</div>
					</div>
				)}
			</div>
		</section>
	);
}
