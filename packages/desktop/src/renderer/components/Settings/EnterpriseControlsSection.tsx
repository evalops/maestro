import type { ApprovalMode } from "../../lib/api-client";

export interface EnterpriseControlsSectionProps {
	approvalMode: ApprovalMode;
	guardianEnabled: boolean;
	hasSession: boolean;
	mcpServerCount: number;
	modelCount: number;
}

interface EnterpriseControlArea {
	name: string;
	status: string;
	scope: string;
	surface: string;
}

const pluralize = (count: number, singular: string, plural = `${singular}s`) =>
	`${count} ${count === 1 ? singular : plural}`;

export function EnterpriseControlsSection({
	approvalMode,
	guardianEnabled,
	hasSession,
	mcpServerCount,
	modelCount,
}: EnterpriseControlsSectionProps) {
	const areas: EnterpriseControlArea[] = [
		{
			name: "Session Defaults",
			status: hasSession ? "Session active" : "Default profile",
			scope: "Mode, approvals, queueing",
			surface: "session + policy.json",
		},
		{
			name: "Model Access",
			status:
				modelCount > 0 ? pluralize(modelCount, "model") : "No models loaded",
			scope: "Provider allowlists",
			surface: "models + policy.json",
		},
		{
			name: "Command Policy",
			status: `Approval: ${approvalMode}`,
			scope: "Shell and tool gates",
			surface: "approvals + tools",
		},
		{
			name: "MCP Server Policy",
			status:
				mcpServerCount > 0
					? pluralize(mcpServerCount, "server")
					: "No servers configured",
			scope: "Servers, auth presets",
			surface: "enterprise/mcp.json",
		},
		{
			name: "Security",
			status: guardianEnabled ? "Guardian on" : "Guardian off",
			scope: "Secrets and writes",
			surface: "guardian + paths",
		},
		{
			name: "Network Policy",
			status: "Runtime scoped",
			scope: "Remote transports",
			surface: "network + MCP",
		},
		{
			name: "Git",
			status: "Workspace scoped",
			scope: "Commits and branches",
			surface: "tools + paths",
		},
		{
			name: "Session Retention",
			status: "Local history",
			scope: "Limits and cleanup",
			surface: "limits + storage",
		},
	];

	return (
		<section className="border border-line-subtle rounded-xl overflow-hidden">
			<div className="px-4 py-2 border-b border-line-subtle">
				<div className="text-xs font-semibold text-text-tertiary uppercase tracking-wide">
					Enterprise Controls
				</div>
				<div className="mt-1 text-[11px] text-text-muted">
					Policy map for desktop rollout, runtime access, and governed agent
					behavior.
				</div>
			</div>
			<div className="divide-y divide-line-subtle/70">
				{areas.map((area) => (
					<div
						key={area.name}
						className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 px-4 py-3 text-xs"
					>
						<div className="min-w-0">
							<div className="font-medium text-text-primary truncate">
								{area.name}
							</div>
							<div className="mt-1 text-text-tertiary truncate">
								{area.surface}
							</div>
						</div>
						<div className="min-w-0 text-text-secondary truncate">
							{area.scope}
						</div>
						<div className="min-w-0 text-right text-text-muted truncate">
							{area.status}
						</div>
					</div>
				))}
			</div>
		</section>
	);
}
