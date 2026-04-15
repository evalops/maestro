import { useMemo } from "react";
import type {
	ApprovalMode,
	GuardianRunResult,
	GuardianStatus,
} from "../../lib/api-client";

export interface GuardianLastRunViewModel {
	status: GuardianRunResult["status"];
	summary: string;
	durationLabel: string;
	timestampLabel: string;
}

export interface SafetyApprovalsViewModel {
	approvalMode: ApprovalMode;
	guardianChecked: boolean;
	guardianEnabledLabel: string;
	guardianActionLabel: string;
	guardianActionDisabled: boolean;
	lastRun: GuardianLastRunViewModel | null;
}

export interface SafetyApprovalsSectionProps {
	approvalMode: ApprovalMode;
	guardianStatus: GuardianStatus | null;
	guardianRunning: boolean;
	onUpdateApproval: (mode: ApprovalMode) => Promise<void> | void;
	onUpdateGuardianEnabled: (enabled: boolean) => Promise<void> | void;
	onRunGuardianNow: () => Promise<void> | void;
}

export function formatGuardianTimestamp(value?: number | string): string {
	if (!value) return "Unknown";

	const date = typeof value === "number" ? new Date(value) : new Date(value);
	if (Number.isNaN(date.getTime())) return "Unknown";

	return date.toLocaleString();
}

export function formatGuardianDuration(value?: number): string {
	if (!value || value <= 0) return "";
	if (value < 1000) return `${Math.round(value)}ms`;
	if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
	return `${Math.round(value / 1000)}s`;
}

export function buildSafetyApprovalsViewModel(
	approvalMode: ApprovalMode,
	guardianStatus: GuardianStatus | null,
	guardianRunning: boolean,
): SafetyApprovalsViewModel {
	const lastRun = guardianStatus?.state?.lastRun;

	return {
		approvalMode,
		guardianChecked: guardianStatus?.enabled ?? true,
		guardianEnabledLabel: guardianStatus?.enabled ? "On" : "Off",
		guardianActionLabel: guardianRunning ? "Running…" : "Run now",
		guardianActionDisabled: guardianRunning,
		lastRun: lastRun
			? {
					status: lastRun.status,
					summary: lastRun.summary,
					durationLabel: formatGuardianDuration(lastRun.durationMs),
					timestampLabel: formatGuardianTimestamp(lastRun.startedAt),
				}
			: null,
	};
}

export function SafetyApprovalsSection({
	approvalMode,
	guardianStatus,
	guardianRunning,
	onUpdateApproval,
	onUpdateGuardianEnabled,
	onRunGuardianNow,
}: SafetyApprovalsSectionProps) {
	const safety = useMemo(
		() =>
			buildSafetyApprovalsViewModel(
				approvalMode,
				guardianStatus,
				guardianRunning,
			),
		[approvalMode, guardianRunning, guardianStatus],
	);

	return (
		<section className="border border-line-subtle rounded-xl overflow-hidden">
			<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
				Safety & Approvals
			</div>
			<div className="p-4 space-y-4">
				<div className="flex items-center justify-between gap-4">
					<div>
						<div className="text-text-primary font-medium">Approval mode</div>
						<div className="text-xs text-text-muted">
							Auto, prompt, or fail for tool use.
						</div>
					</div>
					<select
						value={safety.approvalMode}
						onChange={(event) =>
							onUpdateApproval(event.target.value as ApprovalMode)
						}
						className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
					>
						<option value="auto">Auto</option>
						<option value="prompt">Prompt</option>
						<option value="fail">Fail</option>
					</select>
				</div>

				<div className="flex items-center justify-between gap-4">
					<div>
						<div className="text-text-primary font-medium">Guardian</div>
						<div className="text-xs text-text-muted">
							Secrets scanning on writes and commits.
						</div>
					</div>
					<div className="flex items-center gap-2">
						<label className="inline-flex items-center gap-2 text-xs text-text-tertiary">
							<input
								type="checkbox"
								checked={safety.guardianChecked}
								onChange={(event) =>
									onUpdateGuardianEnabled(event.target.checked)
								}
								className="h-4 w-4 rounded border-line-subtle bg-bg-tertiary text-accent focus:ring-accent"
							/>
							<span>{safety.guardianEnabledLabel}</span>
						</label>
						<button
							type="button"
							className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
							onClick={onRunGuardianNow}
							disabled={safety.guardianActionDisabled}
						>
							{safety.guardianActionLabel}
						</button>
					</div>
				</div>
				{safety.lastRun && (
					<div className="text-xs text-text-muted">
						Last run {safety.lastRun.status} · {safety.lastRun.summary} ·{" "}
						{safety.lastRun.durationLabel}· {safety.lastRun.timestampLabel}
					</div>
				)}
			</div>
		</section>
	);
}
