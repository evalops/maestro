import { html } from "lit";
import type {
	RunHealthLevel,
	WorkspaceStatus,
} from "../services/api-client.js";
import type { ComposerChatIconName } from "./composer-chat-icons.js";

type IconRenderer = (name: ComposerChatIconName) => unknown;

export function getRunHealthPillClass(status: RunHealthLevel | undefined) {
	if (status === "unhealthy") return "error";
	if (status === "degraded") return "warning";
	if (status === "healthy") return "success";
	return "info";
}

export function renderComposerHealthPopover({
	showHealth,
	closeHealth,
	renderIcon,
	overallRunHealthClass,
	overallRunHealthStatus,
	apiBaseUrl,
	latency,
	lastUpdated,
	runHealth,
	lastApiError,
}: {
	showHealth: boolean;
	closeHealth: () => void;
	renderIcon: IconRenderer;
	overallRunHealthClass: string;
	overallRunHealthStatus: string;
	apiBaseUrl: string;
	latency: number | null;
	lastUpdated: string | null;
	runHealth: WorkspaceStatus["runHealth"] | null;
	lastApiError: string | null;
}) {
	if (!showHealth) {
		return "";
	}

	return html`
		<div class="health-popover">
			<div class="health-popover-header">
				<span class="health-popover-label">RUN HEALTH</span>
				<button class="icon-btn" @click=${closeHealth}>${renderIcon("close")}</button>
			</div>
			<div class="health-popover-row">
				<span>Overall:</span>
				<strong class="pill ${overallRunHealthClass}">${overallRunHealthStatus}</strong>
			</div>
			<div class="health-popover-row">
				<span>Base:</span>
				<span class="health-row-value">${apiBaseUrl}</span>
			</div>
			<div class="health-popover-row">
				<span>Latency:</span>
				<span class="health-row-value">${latency ? `${Math.round(latency)}ms` : "n/a"}</span>
			</div>
			<div class="health-popover-row">
				<span>Last updated:</span>
				<span class="health-row-value">${lastUpdated ? new Date(lastUpdated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "n/a"}</span>
			</div>
			${
				runHealth?.slos?.length
					? html`
						<div class="health-slo-list">
							${runHealth.slos.map(
								(slo) => html`
									<div class="health-slo ${slo.status}">
										<div class="health-slo-header">
											<span class="health-slo-label">${slo.label}</span>
											<span class="pill ${getRunHealthPillClass(slo.status)}">${slo.status}</span>
										</div>
										<div class="health-slo-observed">${slo.observed}</div>
										<div class="health-slo-target">${slo.target}</div>
										${slo.detail ? html`<div class="health-slo-detail">${slo.detail}</div>` : ""}
									</div>
								`,
							)}
						</div>
				  `
					: ""
			}
			<div class="health-popover-row">
				<span>Last error:</span>
				<span class="health-row-value">${lastApiError || "none"}</span>
			</div>
		</div>
	`;
}

export function renderComposerShortcutsModal({
	showShortcuts,
	closeShortcuts,
	renderIcon,
}: {
	showShortcuts: boolean;
	closeShortcuts: () => void;
	renderIcon: IconRenderer;
}) {
	if (!showShortcuts) {
		return "";
	}

	return html`
		<div class="shortcuts-modal">
			<div class="shortcuts-modal-header">
				<span class="shortcuts-modal-title">Keyboard shortcuts</span>
				<button class="icon-btn" @click=${closeShortcuts}>${renderIcon("close")}</button>
			</div>
			<div class="shortcuts-grid">
				<span class="pill">Enter</span><span>Send message</span>
				<span class="pill">Shift+Enter</span><span>New line</span>
				<span class="pill">?</span><span>Toggle this help</span>
				<span class="pill">↻</span><span>Refresh API status</span>
				<span class="pill">⌘/Ctrl + K</span><span>Browser find (fwd to your editor)</span>
				<span class="pill">⌘/Ctrl + M</span><span>Toggle compact layout</span>
			</div>
		</div>
	`;
}
