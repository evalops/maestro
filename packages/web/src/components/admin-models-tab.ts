import { type LitElement, html } from "lit";
import type {
	EnterpriseApiClient,
	ModelApproval,
} from "../services/enterprise-api.js";

type ToastType = "success" | "error" | "info";

type ModelApprovalClient = Pick<
	EnterpriseApiClient,
	"getModelApprovals" | "approveModel" | "denyModel"
>;

export class AdminModelsTab {
	constructor(
		private readonly host: Pick<LitElement, "requestUpdate">,
		private readonly getApi: () => ModelApprovalClient,
		private readonly getApprovals: () => ModelApproval[],
		private readonly setApprovals: (approvals: ModelApproval[]) => void,
		private readonly showToast: (message: string, type: ToastType) => void,
		private readonly formatNumber: (value: number) => string,
		private readonly getStatusBadgeClass: (status: string) => string,
	) {}

	async load() {
		const approvalsRes = await this.getApi()
			.getModelApprovals()
			.catch(() => null);
		this.setApprovals(approvalsRes?.approvals ?? []);
	}

	render(tabLoading: boolean) {
		if (tabLoading) {
			return html`<div class="tab-loading"><span class="spinner"></span>Loading models...</div>`;
		}

		const approvals = this.getApprovals();

		return html`
			<div class="section">
				<div class="section-header">
					<h3>Model Approvals</h3>
					<span style="font-size: 0.75rem; color: var(--text-tertiary);">
						Control which models users can access
					</span>
				</div>
				<div class="section-content" style="padding: 0;">
					${
						approvals.length > 0
							? html`
								<table class="data-table">
									<thead>
										<tr>
											<th>Model</th>
											<th>Provider</th>
											<th>Status</th>
											<th>Usage</th>
											<th>Limits</th>
											<th>Actions</th>
										</tr>
									</thead>
									<tbody>
										${approvals.map(
											(approval) => html`
												<tr>
													<td><code>${approval.modelId}</code></td>
													<td>${approval.provider}</td>
													<td>
														<span class="badge ${this.getStatusBadgeClass(approval.status)}">
															${this.formatStatusLabel(approval.status)}
														</span>
													</td>
													<td>
														${this.formatNumber(approval.tokenUsed)} tokens
														${approval.spendUsed ? `/ $${(approval.spendUsed / 100).toFixed(2)}` : ""}
													</td>
													<td>
														${approval.tokenLimit ? `${this.formatNumber(approval.tokenLimit)} tokens` : ""}
														${approval.spendLimit ? `$${(approval.spendLimit / 100).toFixed(2)}` : ""}
														${!approval.tokenLimit && !approval.spendLimit ? "None" : ""}
													</td>
													<td>
														${
															approval.status === "pending"
																? html`
																	<div class="action-row">
																		<button class="btn btn-sm btn-primary" @click=${() => this.handleApproveModel(approval.modelId)}>Approve</button>
																		<button class="btn btn-sm btn-danger" @click=${() => this.handleDenyModel(approval.modelId)}>Deny</button>
																	</div>
																`
																: html`<span class="badge ${this.getStatusBadgeClass(approval.status)}">${this.formatStatusLabel(approval.status)}</span>`
														}
													</td>
												</tr>
											`,
										)}
									</tbody>
								</table>
							`
							: html`<div class="empty-state">No model approvals configured</div>`
					}
				</div>
			</div>
		`;
	}

	private readonly formatStatusLabel = (
		status: ModelApproval["status"],
	): string => {
		switch (status) {
			case "auto_approved":
				return "Auto-approved";
			case "approved":
				return "Approved";
			case "denied":
				return "Denied";
			default:
				return "Pending";
		}
	};

	private readonly handleApproveModel = async (modelId: string) => {
		try {
			await this.getApi().approveModel(modelId);
			this.showToast("Model approved", "success");
			await this.load();
		} catch (error) {
			this.showToast(
				error instanceof Error ? error.message : "Failed to approve model",
				"error",
			);
		}
	};

	private readonly handleDenyModel = async (modelId: string) => {
		try {
			await this.getApi().denyModel(modelId);
			this.showToast("Model denied", "success");
			await this.load();
		} catch (error) {
			this.showToast(
				error instanceof Error ? error.message : "Failed to deny model",
				"error",
			);
		}
	};
}
