import { useMemo } from "react";
import type { FrameworkSummary } from "../../lib/api-client";

export interface FrameworkOptionViewModel {
	id: string;
	label: string;
}

export interface FrameworkViewModel {
	options: FrameworkOptionViewModel[];
	selectedFrameworkId: string;
	isUserScopeSelected: boolean;
	isWorkspaceScopeSelected: boolean;
	isLocked: boolean;
	lockedMessage: string | null;
}

export interface FrameworkSectionProps {
	frameworks: FrameworkSummary[];
	frameworkId: string;
	frameworkScope: "user" | "workspace";
	frameworkLocked: boolean;
	onUpdateFramework: (framework: string) => Promise<void> | void;
	onUpdateFrameworkScope: (scope: "user" | "workspace") => Promise<void> | void;
}

export function buildFrameworkViewModel(
	frameworks: FrameworkSummary[],
	frameworkId: string,
	frameworkScope: "user" | "workspace",
	frameworkLocked: boolean,
): FrameworkViewModel {
	return {
		options: [{ id: "none", label: "None" }, ...frameworks].map(
			(framework) => ({
				id: framework.id,
				label: framework.id === "none" ? "None" : framework.id,
			}),
		),
		selectedFrameworkId: frameworkId,
		isUserScopeSelected: frameworkScope === "user",
		isWorkspaceScopeSelected: frameworkScope === "workspace",
		isLocked: frameworkLocked,
		lockedMessage: frameworkLocked ? "Framework is locked by policy." : null,
	};
}

export function FrameworkSection({
	frameworks,
	frameworkId,
	frameworkScope,
	frameworkLocked,
	onUpdateFramework,
	onUpdateFrameworkScope,
}: FrameworkSectionProps) {
	const framework = useMemo(
		() =>
			buildFrameworkViewModel(
				frameworks,
				frameworkId,
				frameworkScope,
				frameworkLocked,
			),
		[frameworkId, frameworks, frameworkLocked, frameworkScope],
	);

	return (
		<section className="border border-line-subtle rounded-xl overflow-hidden">
			<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
				Framework
			</div>
			<div className="p-4 space-y-4">
				<div className="flex items-center justify-between gap-4">
					<div>
						<div className="text-text-primary font-medium">
							Default framework
						</div>
						<div className="text-xs text-text-muted">
							Slash command: /framework
						</div>
					</div>
					<select
						disabled={framework.isLocked}
						value={framework.selectedFrameworkId}
						onChange={(event) => onUpdateFramework(event.target.value)}
						className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary disabled:opacity-50"
					>
						{framework.options.map((option) => (
							<option key={option.id} value={option.id}>
								{option.label}
							</option>
						))}
					</select>
				</div>

				<div className="flex items-center justify-between gap-4">
					<div>
						<div className="text-text-primary font-medium">Scope</div>
						<div className="text-xs text-text-muted">
							User or workspace default.
						</div>
					</div>
					<div className="flex items-center gap-2">
						<button
							type="button"
							disabled={framework.isLocked}
							className={`px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
								framework.isUserScopeSelected
									? "border-accent text-text-primary bg-bg-tertiary"
									: "border-line-subtle text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
							}`}
							onClick={() => onUpdateFrameworkScope("user")}
						>
							User
						</button>
						<button
							type="button"
							disabled={framework.isLocked}
							className={`px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
								framework.isWorkspaceScopeSelected
									? "border-accent text-text-primary bg-bg-tertiary"
									: "border-line-subtle text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
							}`}
							onClick={() => onUpdateFrameworkScope("workspace")}
						>
							Workspace
						</button>
					</div>
				</div>
				{framework.lockedMessage && (
					<div className="text-xs text-text-muted">
						{framework.lockedMessage}
					</div>
				)}
			</div>
		</section>
	);
}
