import { type LitElement, html } from "lit";
import type {
	DirectoryRule,
	EnterpriseApiClient,
} from "../services/enterprise-api.js";

type ToastType = "success" | "error" | "info";

type ConfirmDialog = {
	title: string;
	message: string;
	confirmText: string;
	onConfirm: () => void | Promise<void>;
};

type DirectoryRulesClient = Pick<
	EnterpriseApiClient,
	"getDirectoryRules" | "createDirectoryRule" | "deleteDirectoryRule"
>;

export class AdminDirectoriesTab {
	private newRulePattern = "";

	private newRuleAccess: "allow" | "deny" = "allow";

	private newRuleDescription = "";

	constructor(
		private readonly host: Pick<LitElement, "requestUpdate">,
		private readonly getApi: () => DirectoryRulesClient,
		private readonly getRules: () => DirectoryRule[],
		private readonly setRules: (rules: DirectoryRule[]) => void,
		private readonly showToast: (message: string, type: ToastType) => void,
		private readonly showConfirm: (options: ConfirmDialog) => void,
	) {}

	async load() {
		const rulesRes = await this.getApi()
			.getDirectoryRules()
			.catch(() => null);
		this.setRules(rulesRes?.rules ?? []);
	}

	render(tabLoading: boolean) {
		if (tabLoading) {
			return html`<div class="tab-loading"><span class="spinner"></span>Loading directory rules...</div>`;
		}

		const rules = this.getRules();

		return html`
			<div class="section">
				<div class="section-header">
					<h3>Add Directory Rule</h3>
				</div>
				<div class="section-content">
					<div style="display: grid; grid-template-columns: 1fr 140px 1fr auto; gap: 0.75rem; align-items: flex-end;">
						<div class="form-group" style="margin-bottom: 0;">
							<label class="form-label">Pattern (glob syntax)</label>
							<input
								type="text"
								class="form-input"
								placeholder="/app/src/**"
								.value=${this.newRulePattern}
								@input=${this.handlePatternInput}
							/>
						</div>
						<div class="form-group" style="margin-bottom: 0;">
							<label class="form-label">Access</label>
							<select
								class="form-input"
								.value=${this.newRuleAccess}
								@change=${this.handleAccessChange}
							>
								<option value="allow">Allow</option>
								<option value="deny">Deny</option>
							</select>
						</div>
						<div class="form-group" style="margin-bottom: 0;">
							<label class="form-label">Description (optional)</label>
							<input
								type="text"
								class="form-input"
								placeholder="Allow access to source files"
								.value=${this.newRuleDescription}
								@input=${this.handleDescriptionInput}
							/>
						</div>
						<button class="btn btn-primary" @click=${this.handleAddDirectoryRule}>Add Rule</button>
					</div>
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Directory Access Rules (${rules.length})</h3>
				</div>
				<div class="section-content" style="padding: 0;">
					${
						rules.length > 0
							? html`
								<table class="data-table">
									<thead>
										<tr>
											<th>Pattern</th>
											<th>Access</th>
											<th>Priority</th>
											<th>Description</th>
											<th>Actions</th>
										</tr>
									</thead>
									<tbody>
										${rules.map(
											(rule) => html`
												<tr>
													<td><code>${rule.pattern}</code></td>
													<td>
														<span class="badge ${rule.isAllowed ? "success" : "error"}">
															${rule.isAllowed ? "Allow" : "Deny"}
														</span>
													</td>
													<td>${rule.priority}</td>
													<td>${rule.description || "-"}</td>
													<td>
														<button class="btn btn-sm btn-danger" @click=${() => this.confirmDeleteRule(rule)}>Delete</button>
													</td>
												</tr>
											`,
										)}
									</tbody>
								</table>
							`
							: html`<div class="empty-state">No directory rules configured</div>`
					}
				</div>
			</div>
		`;
	}

	private readonly handlePatternInput = (event: Event) => {
		this.newRulePattern = (event.target as HTMLInputElement).value;
		this.host.requestUpdate();
	};

	private readonly handleAccessChange = (event: Event) => {
		this.newRuleAccess = (event.target as HTMLSelectElement).value as
			| "allow"
			| "deny";
		this.host.requestUpdate();
	};

	private readonly handleDescriptionInput = (event: Event) => {
		this.newRuleDescription = (event.target as HTMLInputElement).value;
		this.host.requestUpdate();
	};

	private readonly handleAddDirectoryRule = async () => {
		if (!this.newRulePattern) {
			this.showToast("Please enter a pattern", "error");
			return;
		}

		try {
			await this.getApi().createDirectoryRule({
				pattern: this.newRulePattern,
				isAllowed: this.newRuleAccess === "allow",
				description: this.newRuleDescription || undefined,
			});
			this.showToast("Rule created", "success");
			this.newRulePattern = "";
			this.newRuleDescription = "";
			await this.load();
			this.host.requestUpdate();
		} catch (error) {
			this.showToast(
				error instanceof Error ? error.message : "Failed to create rule",
				"error",
			);
		}
	};

	private confirmDeleteRule(rule: DirectoryRule) {
		this.showConfirm({
			title: "Delete Directory Rule",
			message: `Are you sure you want to delete the rule for "${rule.pattern}"?`,
			confirmText: "Delete",
			onConfirm: async () => {
				try {
					await this.getApi().deleteDirectoryRule(rule.id);
					this.showToast("Rule deleted", "success");
					await this.load();
				} catch (error) {
					this.showToast(
						error instanceof Error ? error.message : "Failed to delete rule",
						"error",
					);
				}
			},
		});
	}
}
