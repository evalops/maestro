import { html } from "lit";
import type { EnterpriseControlPlaneInput } from "../services/enterprise-control-plane.js";
import { buildEnterpriseControlPlaneSummary } from "../services/enterprise-control-plane.js";

export class AdminCommandCenterTab {
	constructor(
		private readonly formatDate: (dateStr: string) => string,
		private readonly toneClass: (tone: string) => string,
	) {}

	render(tabLoading: boolean, input: EnterpriseControlPlaneInput) {
		if (tabLoading) {
			return html`<div class="tab-loading"><span class="spinner"></span>Loading enterprise controls...</div>`;
		}

		const summary = buildEnterpriseControlPlaneSummary(input);

		return html`
			<div class="section">
				<div class="section-header">
					<h3>Enterprise Command Center</h3>
					<span class="badge ${this.toneClass(summary.posture.tone)}">
						${summary.posture.label}
					</span>
				</div>
				<div class="section-content">
					<div class="posture-detail">${summary.posture.detail}</div>
					<div class="stats-grid command-metrics">
						${summary.metrics.map(
							(metric) => html`
								<div class="stat-card ${this.toneClass(metric.tone)}">
									<div class="stat-value">${metric.value}</div>
									<div class="stat-label">${metric.label}</div>
									<div class="metric-detail">${metric.detail}</div>
								</div>
							`,
						)}
					</div>
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Control-Plane Lanes</h3>
				</div>
				<div class="section-content" style="padding: 0;">
					<table class="data-table control-lanes">
						<thead>
							<tr>
								<th>Lane</th>
								<th>Source</th>
								<th>Control</th>
								<th>Status</th>
								<th>Evidence</th>
								<th>Next Action</th>
							</tr>
						</thead>
						<tbody>
							${summary.lanes.map(
								(lane) => html`
									<tr>
										<td><strong>${lane.name}</strong></td>
										<td>${lane.source}</td>
										<td>${lane.control}</td>
										<td>
											<span class="badge ${this.toneClass(lane.tone)}">${lane.status}</span>
										</td>
										<td>${lane.evidence}</td>
										<td>${lane.nextAction}</td>
									</tr>
								`,
							)}
						</tbody>
					</table>
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Enterprise Watchlist (${summary.watchItems.length})</h3>
				</div>
				<div class="section-content" style="padding: 0;">
					${
						summary.watchItems.length > 0
							? summary.watchItems.map(
									(item) => html`
										<div class="alert-item">
											<span class="alert-icon">${this.watchIcon(item.severity)}</span>
											<div class="alert-content">
												<div class="alert-message">${item.label}</div>
												<div class="watch-detail">${item.detail}</div>
												<div class="alert-meta">
													<span class="badge ${this.toneClass(item.severity)}">${item.source}</span>
													${
														item.createdAt
															? html`&nbsp;•&nbsp; ${this.formatDate(item.createdAt)}`
															: ""
													}
												</div>
											</div>
										</div>
									`,
								)
							: html`<div class="empty-state">No enterprise watch items</div>`
					}
				</div>
			</div>
		`;
	}

	private watchIcon(tone: string): string {
		switch (tone) {
			case "error":
				return "!!";
			case "warning":
				return "!";
			case "success":
				return "OK";
			default:
				return "i";
		}
	}
}
