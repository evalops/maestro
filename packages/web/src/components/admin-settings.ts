/**
 * Enterprise Admin Settings Component
 * Comprehensive admin panel for RBAC, audit logs, users, and security settings
 */

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
	type Alert,
	type AuditLog,
	type DirectoryRule,
	type EnterpriseApiClient,
	type ModelApproval,
	type OrgMember,
	type OrgUsageSummary,
	type Organization,
	type Role,
	type UsageQuota,
	type User,
	getEnterpriseApi,
} from "../services/enterprise-api.js";

type AdminTab =
	| "overview"
	| "users"
	| "models"
	| "directories"
	| "security"
	| "audit";

@customElement("admin-settings")
export class AdminSettings extends LitElement {
	static styles = css`
		:host {
			display: flex;
			flex-direction: column;
			height: 100%;
			background: var(--bg-primary);
			color: var(--text-primary);
			font-family: var(--font-sans);
		}

		.admin-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 1.25rem 1.5rem;
			border-bottom: 1px solid var(--border-primary);
			background: var(--bg-primary);
		}

		.admin-header h2 {
			font-size: 1rem;
			font-weight: 600;
			margin: 0;
			color: var(--text-primary);
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}

		.close-btn {
			width: 28px;
			height: 28px;
			padding: 0;
			background: transparent;
			border: 1px solid var(--border-primary);
			border-radius: 6px;
			color: var(--text-secondary);
			cursor: pointer;
			transition: all 0.2s;
			font-size: 0.9rem;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.close-btn:hover {
			background: var(--bg-panel);
			color: var(--text-primary);
			border-color: var(--border-secondary);
		}

		.admin-layout {
			display: flex;
			flex: 1;
			overflow: hidden;
		}

		.sidebar {
			width: 200px;
			background: var(--bg-secondary);
			border-right: 1px solid var(--border-primary);
			padding: 1rem 0;
			overflow-y: auto;
		}

		.nav-item {
			display: flex;
			align-items: center;
			gap: 0.75rem;
			padding: 0.75rem 1.25rem;
			cursor: pointer;
			color: var(--text-secondary);
			font-size: 0.85rem;
			font-weight: 500;
			transition: all 0.15s;
			border-left: 3px solid transparent;
		}

		.nav-item:hover {
			background: var(--bg-panel);
			color: var(--text-primary);
		}

		.nav-item.active {
			background: var(--accent-blue-dim);
			color: var(--accent-blue);
			border-left-color: var(--accent-blue);
		}

		.nav-icon {
			font-size: 1rem;
		}

		.main-content {
			flex: 1;
			overflow-y: auto;
			padding: 1.5rem;
		}

		.section {
			margin-bottom: 1.5rem;
			background: var(--bg-secondary);
			border: 1px solid var(--border-primary);
			border-radius: 8px;
			overflow: hidden;
		}

		.section-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0.75rem 1rem;
			background: var(--bg-panel);
			border-bottom: 1px solid var(--border-primary);
		}

		.section-header h3 {
			font-family: var(--font-mono);
			font-size: 0.7rem;
			font-weight: 600;
			margin: 0;
			color: var(--text-secondary);
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.section-content {
			padding: 1rem;
		}

		.stats-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
			gap: 1rem;
			margin-bottom: 1.5rem;
		}

		.stat-card {
			background: var(--bg-secondary);
			border: 1px solid var(--border-primary);
			border-radius: 8px;
			padding: 1.25rem;
			text-align: center;
		}

		.stat-value {
			font-size: 2rem;
			font-weight: 700;
			color: var(--text-primary);
			margin-bottom: 0.35rem;
			font-family: var(--font-mono);
		}

		.stat-label {
			font-size: 0.7rem;
			color: var(--text-secondary);
			text-transform: uppercase;
			letter-spacing: 0.05em;
			font-family: var(--font-mono);
		}

		.stat-card.warning .stat-value {
			color: var(--accent-yellow);
		}

		.stat-card.danger .stat-value {
			color: var(--accent-red);
		}

		.stat-card.success .stat-value {
			color: var(--accent-green);
		}

		/* Tables */
		.data-table {
			width: 100%;
			border-collapse: collapse;
			font-size: 0.8rem;
		}

		.data-table th {
			text-align: left;
			padding: 0.75rem 1rem;
			font-family: var(--font-mono);
			font-size: 0.65rem;
			font-weight: 600;
			color: var(--text-tertiary);
			text-transform: uppercase;
			letter-spacing: 0.05em;
			border-bottom: 1px solid var(--border-primary);
			background: var(--bg-panel);
		}

		.data-table td {
			padding: 0.75rem 1rem;
			border-bottom: 1px solid var(--border-primary);
			color: var(--text-primary);
		}

		.data-table tr:last-child td {
			border-bottom: none;
		}

		.data-table tr:hover td {
			background: var(--bg-panel);
		}

		/* Badges */
		.badge {
			display: inline-block;
			padding: 0.2rem 0.5rem;
			background: var(--bg-panel);
			border: 1px solid var(--border-primary);
			border-radius: 4px;
			font-size: 0.65rem;
			font-weight: 600;
			color: var(--text-secondary);
			text-transform: uppercase;
			font-family: var(--font-mono);
		}

		.badge.success {
			background: rgba(16, 185, 129, 0.1);
			color: var(--accent-green);
			border-color: transparent;
		}

		.badge.warning {
			background: rgba(245, 158, 11, 0.1);
			color: var(--accent-yellow);
			border-color: transparent;
		}

		.badge.error {
			background: rgba(239, 68, 68, 0.1);
			color: var(--accent-red);
			border-color: transparent;
		}

		.badge.info {
			background: var(--accent-blue-dim);
			color: var(--accent-blue);
			border-color: transparent;
		}

		/* Buttons */
		.btn {
			padding: 0.5rem 1rem;
			border-radius: 6px;
			font-size: 0.8rem;
			font-weight: 500;
			cursor: pointer;
			transition: all 0.15s;
			border: 1px solid var(--border-primary);
			background: var(--bg-secondary);
			color: var(--text-primary);
		}

		.btn:hover {
			background: var(--bg-panel);
			border-color: var(--border-secondary);
		}

		.btn-primary {
			background: var(--accent-blue);
			color: white;
			border-color: var(--accent-blue);
		}

		.btn-primary:hover {
			background: var(--accent-blue-hover);
		}

		.btn-danger {
			background: transparent;
			color: var(--accent-red);
			border-color: var(--accent-red);
		}

		.btn-danger:hover {
			background: rgba(239, 68, 68, 0.1);
		}

		.btn-sm {
			padding: 0.35rem 0.75rem;
			font-size: 0.7rem;
		}

		/* Forms */
		.form-group {
			margin-bottom: 1rem;
		}

		.form-label {
			display: block;
			font-size: 0.75rem;
			font-weight: 500;
			color: var(--text-secondary);
			margin-bottom: 0.5rem;
		}

		.form-input {
			width: 100%;
			padding: 0.5rem 0.75rem;
			border: 1px solid var(--border-primary);
			border-radius: 6px;
			background: var(--bg-primary);
			color: var(--text-primary);
			font-size: 0.85rem;
			font-family: var(--font-sans);
		}

		.form-input:focus {
			outline: none;
			border-color: var(--accent-blue);
			box-shadow: 0 0 0 2px var(--accent-blue-dim);
		}

		.form-input::placeholder {
			color: var(--text-tertiary);
		}

		/* Quota bar */
		.quota-bar {
			height: 8px;
			background: var(--bg-panel);
			border-radius: 4px;
			overflow: hidden;
			margin-top: 0.5rem;
		}

		.quota-fill {
			height: 100%;
			background: var(--accent-blue);
			border-radius: 4px;
			transition: width 0.3s ease;
		}

		.quota-fill.warning {
			background: var(--accent-yellow);
		}

		.quota-fill.danger {
			background: var(--accent-red);
		}

		/* Alert list */
		.alert-item {
			display: flex;
			align-items: flex-start;
			gap: 1rem;
			padding: 1rem;
			border-bottom: 1px solid var(--border-primary);
		}

		.alert-item:last-child {
			border-bottom: none;
		}

		.alert-icon {
			font-size: 1.25rem;
		}

		.alert-content {
			flex: 1;
		}

		.alert-message {
			font-size: 0.85rem;
			color: var(--text-primary);
			margin-bottom: 0.25rem;
		}

		.alert-meta {
			font-size: 0.7rem;
			color: var(--text-tertiary);
		}

		/* Loading / Empty states */
		.loading,
		.empty-state {
			text-align: center;
			padding: 3rem 1rem;
			color: var(--text-tertiary);
			font-size: 0.85rem;
		}

		.error-message {
			background: rgba(239, 68, 68, 0.1);
			border-left: 3px solid var(--accent-red);
			padding: 0.75rem 1rem;
			margin-bottom: 1rem;
			font-size: 0.8rem;
			color: var(--accent-red);
		}

		/* Responsive */
		@media (max-width: 768px) {
			.admin-layout {
				flex-direction: column;
			}

			.sidebar {
				width: 100%;
				display: flex;
				overflow-x: auto;
				padding: 0.5rem;
				border-right: none;
				border-bottom: 1px solid var(--border-primary);
			}

			.nav-item {
				padding: 0.5rem 1rem;
				border-left: none;
				border-bottom: 2px solid transparent;
				white-space: nowrap;
			}

			.nav-item.active {
				border-left: none;
				border-bottom-color: var(--accent-blue);
			}

			.stats-grid {
				grid-template-columns: repeat(2, 1fr);
			}

			.data-table {
				display: block;
				overflow-x: auto;
			}
		}
	`;

	@property({ type: Boolean }) open = false;

	@state() private currentTab: AdminTab = "overview";
	@state() private loading = true;
	@state() private error: string | null = null;

	// Data states
	@state() private quota: UsageQuota | null = null;
	@state() private orgUsage: OrgUsageSummary | null = null;
	@state() private members: OrgMember[] = [];
	@state() private roles: Role[] = [];
	@state() private auditLogs: AuditLog[] = [];
	@state() private alerts: Alert[] = [];
	@state() private modelApprovals: ModelApproval[] = [];
	@state() private directoryRules: DirectoryRule[] = [];

	private api: EnterpriseApiClient;

	constructor() {
		super();
		this.api = getEnterpriseApi();
	}

	async connectedCallback() {
		super.connectedCallback();
		if (this.api.isAuthenticated()) {
			await this.loadData();
		}
	}

	private async loadData() {
		this.loading = true;
		this.error = null;

		try {
			const [quotaRes, usageRes, alertsRes] = await Promise.all([
				this.api.getUsageQuota().catch(() => null),
				this.api.getOrgUsage().catch(() => null),
				this.api.getAlerts().catch(() => ({ alerts: [] })),
			]);

			this.quota = quotaRes;
			this.orgUsage = usageRes;
			this.alerts = alertsRes.alerts;
		} catch (e) {
			this.error = e instanceof Error ? e.message : "Failed to load data";
		} finally {
			this.loading = false;
		}
	}

	private async loadTabData(tab: AdminTab) {
		try {
			switch (tab) {
				case "users": {
					const [membersRes, rolesRes] = await Promise.all([
						this.api.getOrgMembers(),
						this.api.getRoles(),
					]);
					this.members = membersRes.members;
					this.roles = rolesRes.roles;
					break;
				}
				case "models": {
					const approvalsRes = await this.api.getModelApprovals();
					this.modelApprovals = approvalsRes.approvals;
					break;
				}
				case "directories": {
					const rulesRes = await this.api.getDirectoryRules();
					this.directoryRules = rulesRes.rules;
					break;
				}
				case "audit": {
					const logsRes = await this.api.getAuditLogs({ limit: 100 });
					this.auditLogs = logsRes.logs;
					break;
				}
			}
		} catch (e) {
			console.error(`Failed to load ${tab} data:`, e);
		}
	}

	private async selectTab(tab: AdminTab) {
		this.currentTab = tab;
		await this.loadTabData(tab);
	}

	private close() {
		this.dispatchEvent(
			new CustomEvent("close", { bubbles: true, composed: true }),
		);
	}

	private formatNumber(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
		return n.toString();
	}

	private formatDate(dateStr: string): string {
		const date = new Date(dateStr);
		return date.toLocaleString();
	}

	private getQuotaPercent(): number {
		if (!this.quota || !this.quota.tokenQuota) return 0;
		return (this.quota.tokenUsed / this.quota.tokenQuota) * 100;
	}

	private getQuotaClass(): string {
		const percent = this.getQuotaPercent();
		if (percent >= 100) return "danger";
		if (percent >= 80) return "warning";
		return "";
	}

	private getSeverityIcon(severity: string): string {
		switch (severity) {
			case "critical":
				return "🚨";
			case "high":
				return "⚠️";
			case "medium":
				return "⚡";
			case "low":
				return "💡";
			default:
				return "ℹ️";
		}
	}

	private getStatusBadgeClass(status: string): string {
		switch (status) {
			case "success":
			case "approved":
			case "auto_approved":
				return "success";
			case "failure":
			case "error":
			case "denied":
				return "error";
			case "pending":
				return "warning";
			default:
				return "";
		}
	}

	// =========================================================================
	// RENDER METHODS
	// =========================================================================

	private renderOverviewTab() {
		const unreadAlerts = this.alerts.filter((a) => !a.isRead).length;

		return html`
			<div class="stats-grid">
				<div class="stat-card">
					<div class="stat-value">${this.formatNumber(this.orgUsage?.totalTokens || 0)}</div>
					<div class="stat-label">Total Tokens</div>
				</div>
				<div class="stat-card">
					<div class="stat-value">${this.orgUsage?.totalSessions || 0}</div>
					<div class="stat-label">Sessions</div>
				</div>
				<div class="stat-card">
					<div class="stat-value">${this.orgUsage?.totalUsers || 0}</div>
					<div class="stat-label">Users</div>
				</div>
				<div class="stat-card ${unreadAlerts > 0 ? "warning" : ""}">
					<div class="stat-value">${unreadAlerts}</div>
					<div class="stat-label">Active Alerts</div>
				</div>
			</div>

			${
				this.quota
					? html`
					<div class="section">
						<div class="section-header">
							<h3>Your Usage Quota</h3>
						</div>
						<div class="section-content">
							<div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
								<span>${this.formatNumber(this.quota.tokenUsed)} tokens used</span>
								<span>${this.quota.tokenQuota ? `${this.formatNumber(this.quota.tokenQuota)} limit` : "Unlimited"}</span>
							</div>
							<div class="quota-bar">
								<div
									class="quota-fill ${this.getQuotaClass()}"
									style="width: ${Math.min(this.getQuotaPercent(), 100)}%"
								></div>
							</div>
						</div>
					</div>
				`
					: ""
			}

			${
				this.alerts.length > 0
					? html`
					<div class="section">
						<div class="section-header">
							<h3>Recent Alerts</h3>
						</div>
						<div class="section-content" style="padding: 0;">
							${this.alerts.slice(0, 5).map(
								(alert) => html`
									<div class="alert-item">
										<span class="alert-icon">${this.getSeverityIcon(alert.severity)}</span>
										<div class="alert-content">
											<div class="alert-message">${alert.message}</div>
											<div class="alert-meta">
												<span class="badge ${this.getStatusBadgeClass(alert.severity)}">${alert.severity}</span>
												&nbsp;•&nbsp; ${this.formatDate(alert.createdAt)}
											</div>
										</div>
									</div>
								`,
							)}
						</div>
					</div>
				`
					: ""
			}

			${
				this.orgUsage && this.orgUsage.topUsers.length > 0
					? html`
					<div class="section">
						<div class="section-header">
							<h3>Top Users by Token Usage</h3>
						</div>
						<div class="section-content" style="padding: 0;">
							<table class="data-table">
								<thead>
									<tr>
										<th>User ID</th>
										<th>Tokens Used</th>
									</tr>
								</thead>
								<tbody>
									${this.orgUsage.topUsers.map(
										(user) => html`
											<tr>
												<td><code>${user.userId.slice(0, 8)}...</code></td>
												<td>${this.formatNumber(user.tokenUsed)}</td>
											</tr>
										`,
									)}
								</tbody>
							</table>
						</div>
					</div>
				`
					: ""
			}
		`;
	}

	private renderUsersTab() {
		return html`
			<div class="section">
				<div class="section-header">
					<h3>Team Members</h3>
					<button class="btn btn-primary btn-sm">+ Invite User</button>
				</div>
				<div class="section-content" style="padding: 0;">
					${
						this.members.length > 0
							? html`
							<table class="data-table">
								<thead>
									<tr>
										<th>User</th>
										<th>Role</th>
										<th>Token Usage</th>
										<th>Joined</th>
										<th>Actions</th>
									</tr>
								</thead>
								<tbody>
									${this.members.map(
										(member) => html`
											<tr>
												<td>
													<strong>${member.user.name}</strong><br />
													<span style="color: var(--text-tertiary); font-size: 0.75rem;">
														${member.user.email}
													</span>
												</td>
												<td>
													<span class="badge info">${member.role.name}</span>
												</td>
												<td>
													${this.formatNumber(member.tokenUsed)}
													${member.tokenQuota ? `/ ${this.formatNumber(member.tokenQuota)}` : ""}
												</td>
												<td>${this.formatDate(member.joinedAt)}</td>
												<td>
													<button class="btn btn-sm">Edit</button>
												</td>
											</tr>
										`,
									)}
								</tbody>
							</table>
						`
							: html`<div class="empty-state">No team members found</div>`
					}
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Available Roles</h3>
				</div>
				<div class="section-content" style="padding: 0;">
					<table class="data-table">
						<thead>
							<tr>
								<th>Role</th>
								<th>Description</th>
								<th>Type</th>
							</tr>
						</thead>
						<tbody>
							${this.roles.map(
								(role) => html`
									<tr>
										<td><span class="badge info">${role.name}</span></td>
										<td>${role.description || "-"}</td>
										<td>${role.isSystem ? "System" : "Custom"}</td>
									</tr>
								`,
							)}
						</tbody>
					</table>
				</div>
			</div>
		`;
	}

	private renderModelsTab() {
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
						this.modelApprovals.length > 0
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
									${this.modelApprovals.map(
										(approval) => html`
											<tr>
												<td><code>${approval.modelId}</code></td>
												<td>${approval.provider}</td>
												<td>
													<span class="badge ${this.getStatusBadgeClass(approval.status)}">
														${approval.status}
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
															<button class="btn btn-sm btn-primary">Approve</button>
															<button class="btn btn-sm btn-danger">Deny</button>
														`
															: html`<button class="btn btn-sm">Edit</button>`
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

	private renderDirectoriesTab() {
		return html`
			<div class="section">
				<div class="section-header">
					<h3>Directory Access Rules</h3>
					<button class="btn btn-primary btn-sm">+ Add Rule</button>
				</div>
				<div class="section-content" style="padding: 0;">
					${
						this.directoryRules.length > 0
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
									${this.directoryRules.map(
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
													<button class="btn btn-sm btn-danger">Delete</button>
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

			<div class="section">
				<div class="section-header">
					<h3>Add Directory Rule</h3>
				</div>
				<div class="section-content">
					<div class="form-group">
						<label class="form-label">Pattern (glob syntax)</label>
						<input type="text" class="form-input" placeholder="/app/src/**" />
					</div>
					<div class="form-group">
						<label class="form-label">Access Type</label>
						<select class="form-input">
							<option value="allow">Allow</option>
							<option value="deny">Deny</option>
						</select>
					</div>
					<div class="form-group">
						<label class="form-label">Description</label>
						<input type="text" class="form-input" placeholder="Allow access to source files" />
					</div>
					<button class="btn btn-primary">Add Rule</button>
				</div>
			</div>
		`;
	}

	private renderSecurityTab() {
		return html`
			<div class="section">
				<div class="section-header">
					<h3>PII Detection Settings</h3>
				</div>
				<div class="section-content">
					<div class="form-group">
						<label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
							<input type="checkbox" checked />
							<span>Enable PII auto-detection and redaction</span>
						</label>
					</div>
					<div class="form-group">
						<label class="form-label">Custom PII Patterns (one regex per line)</label>
						<textarea
							class="form-input"
							rows="4"
							placeholder="EMP-\\d{6}
INTERNAL-[A-Z]{3}-\\d{4}"
						></textarea>
					</div>
					<button class="btn btn-primary">Save Settings</button>
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Audit Retention</h3>
				</div>
				<div class="section-content">
					<div class="form-group">
						<label class="form-label">Retention Period (days)</label>
						<input type="number" class="form-input" value="90" min="30" max="365" />
					</div>
					<button class="btn btn-primary">Update</button>
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Alert Webhooks</h3>
				</div>
				<div class="section-content">
					<div class="form-group">
						<label class="form-label">Webhook URLs (one per line)</label>
						<textarea
							class="form-input"
							rows="3"
							placeholder="https://hooks.slack.com/services/..."
						></textarea>
					</div>
					<button class="btn btn-primary">Save Webhooks</button>
				</div>
			</div>
		`;
	}

	private renderAuditTab() {
		return html`
			<div class="section">
				<div class="section-header">
					<h3>Audit Logs</h3>
					<button class="btn btn-sm">Export CSV</button>
				</div>
				<div class="section-content" style="padding: 0;">
					${
						this.auditLogs.length > 0
							? html`
							<table class="data-table">
								<thead>
									<tr>
										<th>Timestamp</th>
										<th>Action</th>
										<th>User</th>
										<th>Status</th>
										<th>Details</th>
									</tr>
								</thead>
								<tbody>
									${this.auditLogs.map(
										(log) => html`
											<tr>
												<td style="white-space: nowrap; font-size: 0.75rem;">
													${this.formatDate(log.createdAt)}
												</td>
												<td><code style="font-size: 0.75rem;">${log.action}</code></td>
												<td>
													<code style="font-size: 0.7rem;">${log.userId?.slice(0, 8)}...</code>
												</td>
												<td>
													<span class="badge ${this.getStatusBadgeClass(log.status)}">
														${log.status}
													</span>
												</td>
												<td style="font-size: 0.75rem; max-width: 200px; overflow: hidden; text-overflow: ellipsis;">
													${
														log.metadata
															? JSON.stringify(log.metadata).slice(0, 50)
															: "-"
													}
												</td>
											</tr>
										`,
									)}
								</tbody>
							</table>
						`
							: html`<div class="empty-state">No audit logs available</div>`
					}
				</div>
			</div>
		`;
	}

	private renderCurrentTab() {
		switch (this.currentTab) {
			case "overview":
				return this.renderOverviewTab();
			case "users":
				return this.renderUsersTab();
			case "models":
				return this.renderModelsTab();
			case "directories":
				return this.renderDirectoriesTab();
			case "security":
				return this.renderSecurityTab();
			case "audit":
				return this.renderAuditTab();
			default:
				return this.renderOverviewTab();
		}
	}

	render() {
		return html`
			<div class="admin-header">
				<h2>🛡️ Admin Settings</h2>
				<button class="close-btn" @click=${this.close}>✕</button>
			</div>

			${this.error ? html`<div class="error-message">${this.error}</div>` : ""}

			<div class="admin-layout">
				<nav class="sidebar">
					<div
						class="nav-item ${this.currentTab === "overview" ? "active" : ""}"
						@click=${() => this.selectTab("overview")}
					>
						<span class="nav-icon">📊</span>
						<span>Overview</span>
					</div>
					<div
						class="nav-item ${this.currentTab === "users" ? "active" : ""}"
						@click=${() => this.selectTab("users")}
					>
						<span class="nav-icon">👥</span>
						<span>Users & Roles</span>
					</div>
					<div
						class="nav-item ${this.currentTab === "models" ? "active" : ""}"
						@click=${() => this.selectTab("models")}
					>
						<span class="nav-icon">🤖</span>
						<span>Model Approvals</span>
					</div>
					<div
						class="nav-item ${this.currentTab === "directories" ? "active" : ""}"
						@click=${() => this.selectTab("directories")}
					>
						<span class="nav-icon">📁</span>
						<span>Directories</span>
					</div>
					<div
						class="nav-item ${this.currentTab === "security" ? "active" : ""}"
						@click=${() => this.selectTab("security")}
					>
						<span class="nav-icon">🔐</span>
						<span>Security & PII</span>
					</div>
					<div
						class="nav-item ${this.currentTab === "audit" ? "active" : ""}"
						@click=${() => this.selectTab("audit")}
					>
						<span class="nav-icon">📝</span>
						<span>Audit Logs</span>
					</div>
				</nav>

				<main class="main-content">
					${
						this.loading
							? html`<div class="loading">Loading...</div>`
							: this.renderCurrentTab()
					}
				</main>
			</div>
		`;
	}
}
