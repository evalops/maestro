import { useMemo } from "react";
import type { CleanMode, FooterMode, UiStatus } from "../../lib/api-client";

export interface TerminalUiViewModel {
	controlsDisabled: boolean;
	showSessionWarning: boolean;
	zenModeLabel: string;
	cleanMode: CleanMode;
	footerMode: FooterMode;
	compactToolsLabel: string;
}

export interface TerminalUiSectionProps {
	uiStatus: UiStatus;
	hasSession: boolean;
	onUpdateZen: (enabled: boolean) => Promise<void> | void;
	onUpdateCleanMode: (mode: CleanMode) => Promise<void> | void;
	onUpdateFooterMode: (mode: FooterMode) => Promise<void> | void;
	onUpdateCompactTools: (enabled: boolean) => Promise<void> | void;
}

export function buildTerminalUiViewModel(
	uiStatus: UiStatus,
	hasSession: boolean,
): TerminalUiViewModel {
	return {
		controlsDisabled: !hasSession,
		showSessionWarning: !hasSession,
		zenModeLabel: uiStatus.zenMode ? "On" : "Off",
		cleanMode: uiStatus.cleanMode,
		footerMode: uiStatus.footerMode,
		compactToolsLabel: uiStatus.compactTools ? "On" : "Off",
	};
}

export function TerminalUiSection({
	uiStatus,
	hasSession,
	onUpdateZen,
	onUpdateCleanMode,
	onUpdateFooterMode,
	onUpdateCompactTools,
}: TerminalUiSectionProps) {
	const terminalUi = useMemo(
		() => buildTerminalUiViewModel(uiStatus, hasSession),
		[hasSession, uiStatus],
	);

	return (
		<section className="border border-line-subtle rounded-xl overflow-hidden">
			<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
				Terminal UI (CLI Only)
			</div>
			<div className="p-4 space-y-4">
				<div className="text-xs text-text-muted">
					These settings affect the terminal interface only. The desktop UI
					ignores them.
				</div>
				{terminalUi.showSessionWarning && (
					<div className="text-xs text-text-muted">
						Start a session to enable session-scoped settings.
					</div>
				)}
				<div className="flex items-center justify-between gap-4">
					<div>
						<div className="text-text-primary font-medium">Zen mode</div>
						<div className="text-xs text-text-muted">Reduce TUI clutter.</div>
					</div>
					<label className="inline-flex items-center gap-2 text-xs text-text-tertiary">
						<input
							type="checkbox"
							disabled={terminalUi.controlsDisabled}
							checked={uiStatus.zenMode}
							onChange={(event) => onUpdateZen(event.target.checked)}
							className="h-4 w-4 rounded border-line-subtle bg-bg-tertiary text-accent focus:ring-accent"
						/>
						<span>{terminalUi.zenModeLabel}</span>
					</label>
				</div>

				<div className="flex items-center justify-between gap-4">
					<div>
						<div className="text-text-primary font-medium">Clean mode</div>
						<div className="text-xs text-text-muted">
							Clean up TUI output formatting.
						</div>
					</div>
					<select
						disabled={terminalUi.controlsDisabled}
						value={terminalUi.cleanMode}
						onChange={(event) =>
							onUpdateCleanMode(event.target.value as CleanMode)
						}
						className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary disabled:opacity-50"
					>
						<option value="off">Off</option>
						<option value="soft">Soft</option>
						<option value="aggressive">Aggressive</option>
					</select>
				</div>

				<div className="flex items-center justify-between gap-4">
					<div>
						<div className="text-text-primary font-medium">Footer mode</div>
						<div className="text-xs text-text-muted">
							TUI status footer density.
						</div>
					</div>
					<select
						disabled={terminalUi.controlsDisabled}
						value={terminalUi.footerMode}
						onChange={(event) =>
							onUpdateFooterMode(event.target.value as FooterMode)
						}
						className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary disabled:opacity-50"
					>
						<option value="ensemble">Ensemble</option>
						<option value="solo">Solo</option>
					</select>
				</div>

				<div className="flex items-center justify-between gap-4">
					<div>
						<div className="text-text-primary font-medium">Compact tools</div>
						<div className="text-xs text-text-muted">
							Reduce TUI tool output cards.
						</div>
					</div>
					<label className="inline-flex items-center gap-2 text-xs text-text-tertiary">
						<input
							type="checkbox"
							disabled={terminalUi.controlsDisabled}
							checked={uiStatus.compactTools}
							onChange={(event) => onUpdateCompactTools(event.target.checked)}
							className="h-4 w-4 rounded border-line-subtle bg-bg-tertiary text-accent focus:ring-accent"
						/>
						<span>{terminalUi.compactToolsLabel}</span>
					</label>
				</div>
			</div>
		</section>
	);
}
