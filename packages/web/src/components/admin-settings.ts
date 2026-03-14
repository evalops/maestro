/**
 * Enterprise Admin Settings Component
 * Comprehensive admin panel for RBAC, audit logs, users, and security settings
 */

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ApiClient } from "../services/api-client.js";
import {
	type Alert,
	type AuditLog,
	type DirectoryRule,
	type EnterpriseApiClient,
	type ModelApproval,
	type OrgMember,
	type OrgUsageSummary,
	type Organization,
	type OrganizationSettings,
	type Role,
	type UsageQuota,
	type User,
	getEnterpriseApi,
} from "../services/enterprise-api.js";
import { AdminAuditTab } from "./admin-audit-tab.js";
import { AdminPolicyTab } from "./admin-policy-tab.js";

type AdminTab =
	| "overview"
	| "users"
	| "models"
	| "directories"
	| "security"
	| "policy"
	| "audit";

interface Toast {
	message: string;
	type: "success" | "error" | "info";
}

interface ConfirmDialog {
	title: string;
	message: string;
	confirmText: string;
	onConfirm: () => void;
}

@customElement("admin-settings")
export class AdminSettings extends LitElement {
	static override styles = css`
		/* ============================================================
		   CONTROL ROOM - Enterprise Admin Aesthetic
		   Inspired by mission control centers and financial terminals
		   ============================================================ */

		@import url("https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=DM+Sans:wght@400;500;600;700&display=swap");

		:host {
			--admin-bg-deep: #08090a;
			--admin-bg-base: #0c0d0f;
			--admin-bg-elevated: #111214;
			--admin-bg-surface: #161719;
			--admin-border: #1e2023;
			--admin-border-subtle: #141517;
			--admin-text-primary: #e8e9eb;
			--admin-text-secondary: #8b8d91;
			--admin-text-tertiary: #5c5e62;
			--admin-accent-amber: #d4a012;
			--admin-accent-amber-dim: rgba(212, 160, 18, 0.12);
			--admin-accent-amber-glow: rgba(212, 160, 18, 0.25);
			--admin-accent-green: #22c55e;
			--admin-accent-green-dim: rgba(34, 197, 94, 0.12);
			--admin-accent-red: #ef4444;
			--admin-accent-red-dim: rgba(239, 68, 68, 0.12);
			--admin-accent-blue: #3b82f6;
			--admin-accent-blue-dim: rgba(59, 130, 246, 0.12);

			--font-display: "DM Sans", system-ui, sans-serif;
			--font-mono: "JetBrains Mono", "SF Mono", monospace;

			display: flex;
			flex-direction: column;
			height: 100%;
			background: var(--admin-bg-deep);
			color: var(--admin-text-primary);
			font-family: var(--font-display);
			position: relative;
		}

		/* Subtle grid background */
		:host::before {
			content: "";
			position: absolute;
			inset: 0;
			background-image:
				linear-gradient(var(--admin-border-subtle) 1px, transparent 1px),
				linear-gradient(90deg, var(--admin-border-subtle) 1px, transparent 1px);
			background-size: 40px 40px;
			opacity: 0.4;
			pointer-events: none;
		}

		/* Header - Minimal, purposeful */
		.admin-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 1rem 1.5rem;
			background: var(--admin-bg-base);
			border-bottom: 1px solid var(--admin-border);
			position: relative;
			z-index: 10;
		}

		.admin-header::after {
			content: "";
			position: absolute;
			bottom: 0;
			left: 0;
			right: 0;
			height: 1px;
			background: linear-gradient(90deg, transparent, var(--admin-accent-amber) 20%, var(--admin-accent-amber) 80%, transparent);
			opacity: 0.3;
		}

		.admin-header h2 {
			font-family: var(--font-mono);
			font-size: 0.75rem;
			font-weight: 600;
			margin: 0;
			color: var(--admin-text-secondary);
			text-transform: uppercase;
			letter-spacing: 0.15em;
			display: flex;
			align-items: center;
			gap: 0.75rem;
		}

		.admin-header h2::before {
			content: "";
			width: 8px;
			height: 8px;
			background: var(--admin-accent-amber);
			border-radius: 50%;
			box-shadow: 0 0 12px var(--admin-accent-amber-glow);
			animation: pulse-glow 2s ease-in-out infinite;
		}

		@keyframes pulse-glow {
			0%, 100% { opacity: 1; }
			50% { opacity: 0.5; }
		}

		.close-btn {
			width: 32px;
			height: 32px;
			padding: 0;
			background: transparent;
			border: 1px solid var(--admin-border);
			color: var(--admin-text-tertiary);
			cursor: pointer;
			transition: all 0.15s ease;
			font-family: var(--font-mono);
			font-size: 1rem;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.close-btn:hover {
			background: var(--admin-accent-red-dim);
			border-color: var(--admin-accent-red);
			color: var(--admin-accent-red);
		}

		/* Layout */
		.admin-layout {
			display: flex;
			flex: 1;
			overflow: hidden;
			position: relative;
			z-index: 1;
		}

		/* Sidebar - Vertical nav */
		.sidebar {
			width: 220px;
			background: var(--admin-bg-base);
			border-right: 1px solid var(--admin-border);
			padding: 1.5rem 0;
			overflow-y: auto;
			display: flex;
			flex-direction: column;
			gap: 0.25rem;
		}

		.nav-item {
			display: flex;
			align-items: center;
			padding: 0.875rem 1.5rem;
			cursor: pointer;
			color: var(--admin-text-secondary);
			font-family: var(--font-mono);
			font-size: 0.7rem;
			font-weight: 500;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			transition: all 0.15s ease;
			position: relative;
			margin: 0 0.75rem;
			border-radius: 4px;
		}

		.nav-item::before {
			content: "";
			position: absolute;
			left: 0;
			top: 50%;
			transform: translateY(-50%);
			width: 3px;
			height: 0;
			background: var(--admin-accent-amber);
			transition: height 0.15s ease;
			border-radius: 0 2px 2px 0;
		}

		.nav-item:hover {
			background: var(--admin-bg-elevated);
			color: var(--admin-text-primary);
		}

		.nav-item.active {
			background: var(--admin-accent-amber-dim);
			color: var(--admin-accent-amber);
		}

		.nav-item.active::before {
			height: 16px;
		}

		/* Main content */
		.main-content {
			flex: 1;
			overflow-y: auto;
			padding: 2rem;
			background: var(--admin-bg-deep);
		}

		/* Sections - Card-like containers */
		.section {
			margin-bottom: 1.5rem;
			background: var(--admin-bg-base);
			border: 1px solid var(--admin-border);
			overflow: hidden;
		}

		.section-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 1rem 1.25rem;
			background: var(--admin-bg-elevated);
			border-bottom: 1px solid var(--admin-border);
		}

		.section-header h3 {
			font-family: var(--font-mono);
			font-size: 0.65rem;
			font-weight: 600;
			margin: 0;
			color: var(--admin-text-tertiary);
			text-transform: uppercase;
			letter-spacing: 0.12em;
		}

		.section-content {
			padding: 1.25rem;
		}

		/* Stats grid - Data dashboard feel */
		.stats-grid {
			display: grid;
			grid-template-columns: repeat(4, 1fr);
			gap: 1px;
			background: var(--admin-border);
			border: 1px solid var(--admin-border);
			margin-bottom: 2rem;
		}

		.stat-card {
			background: var(--admin-bg-base);
			padding: 1.5rem;
			text-align: left;
			position: relative;
			transition: background 0.15s ease;
		}

		.stat-card:hover {
			background: var(--admin-bg-elevated);
		}

		.stat-card::after {
			content: "";
			position: absolute;
			top: 0;
			left: 0;
			right: 0;
			height: 2px;
			background: var(--admin-border);
			transition: background 0.15s ease;
		}

		.stat-card:hover::after {
			background: var(--admin-accent-amber);
		}

		.stat-value {
			font-family: var(--font-mono);
			font-size: 2rem;
			font-weight: 700;
			color: var(--admin-text-primary);
			margin-bottom: 0.5rem;
			line-height: 1;
			letter-spacing: -0.02em;
		}

		.stat-label {
			font-family: var(--font-mono);
			font-size: 0.6rem;
			color: var(--admin-text-tertiary);
			text-transform: uppercase;
			letter-spacing: 0.1em;
		}

		.stat-card.warning .stat-value {
			color: var(--admin-accent-amber);
		}

		.stat-card.danger .stat-value {
			color: var(--admin-accent-red);
		}

		.stat-card.success .stat-value {
			color: var(--admin-accent-green);
		}

		/* Tables - Terminal-style data grid */
		.data-table {
			width: 100%;
			border-collapse: collapse;
			font-size: 0.8rem;
		}

		.data-table th {
			text-align: left;
			padding: 0.875rem 1rem;
			font-family: var(--font-mono);
			font-size: 0.6rem;
			font-weight: 600;
			color: var(--admin-text-tertiary);
			text-transform: uppercase;
			letter-spacing: 0.1em;
			border-bottom: 1px solid var(--admin-border);
			background: var(--admin-bg-elevated);
		}

		.data-table td {
			padding: 0.875rem 1rem;
			border-bottom: 1px solid var(--admin-border-subtle);
			color: var(--admin-text-primary);
			font-family: var(--font-display);
		}

		.data-table tr:last-child td {
			border-bottom: none;
		}

		.data-table tr {
			transition: background 0.1s ease;
		}

		.data-table tr:hover td {
			background: var(--admin-bg-elevated);
		}

		.data-table code {
			font-family: var(--font-mono);
			font-size: 0.75rem;
			color: var(--admin-accent-amber);
			background: var(--admin-accent-amber-dim);
			padding: 0.15rem 0.4rem;
		}

		/* Badges - Minimal indicators */
		.badge {
			display: inline-flex;
			align-items: center;
			padding: 0.25rem 0.5rem;
			background: var(--admin-bg-surface);
			border: none;
			font-family: var(--font-mono);
			font-size: 0.6rem;
			font-weight: 600;
			color: var(--admin-text-secondary);
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.badge::before {
			content: "";
			width: 6px;
			height: 6px;
			border-radius: 50%;
			margin-right: 0.4rem;
			background: currentColor;
			opacity: 0.5;
		}

		.badge.success {
			background: var(--admin-accent-green-dim);
			color: var(--admin-accent-green);
		}

		.badge.success::before {
			opacity: 1;
		}

		.badge.warning {
			background: var(--admin-accent-amber-dim);
			color: var(--admin-accent-amber);
		}

		.badge.warning::before {
			opacity: 1;
		}

		.badge.error {
			background: var(--admin-accent-red-dim);
			color: var(--admin-accent-red);
		}

		.badge.error::before {
			opacity: 1;
		}

		.badge.info {
			background: var(--admin-accent-blue-dim);
			color: var(--admin-accent-blue);
		}

		.badge.info::before {
			opacity: 1;
		}

		/* Buttons - Sharp, utilitarian */
		.btn {
			padding: 0.625rem 1rem;
			font-family: var(--font-mono);
			font-size: 0.7rem;
			font-weight: 500;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			cursor: pointer;
			transition: all 0.15s ease;
			border: 1px solid var(--admin-border);
			background: var(--admin-bg-elevated);
			color: var(--admin-text-secondary);
		}

		.btn:hover {
			background: var(--admin-bg-surface);
			border-color: var(--admin-text-tertiary);
			color: var(--admin-text-primary);
		}

		.btn-primary {
			background: var(--admin-accent-amber-dim);
			color: var(--admin-accent-amber);
			border-color: transparent;
		}

		.btn-primary:hover {
			background: var(--admin-accent-amber);
			color: var(--admin-bg-deep);
		}

		.btn-danger {
			background: transparent;
			color: var(--admin-accent-red);
			border-color: var(--admin-accent-red);
		}

		.btn-danger:hover {
			background: var(--admin-accent-red);
			color: white;
		}

		.btn-sm {
			padding: 0.4rem 0.625rem;
			font-size: 0.6rem;
		}

		/* Forms - Clean inputs */
		.form-group {
			margin-bottom: 1.25rem;
		}

		.form-label {
			display: block;
			font-family: var(--font-mono);
			font-size: 0.6rem;
			font-weight: 600;
			color: var(--admin-text-tertiary);
			text-transform: uppercase;
			letter-spacing: 0.1em;
			margin-bottom: 0.5rem;
		}

		.form-input {
			width: 100%;
			padding: 0.625rem 0.875rem;
			border: 1px solid var(--admin-border);
			background: var(--admin-bg-deep);
			color: var(--admin-text-primary);
			font-family: var(--font-mono);
			font-size: 0.8rem;
			transition: all 0.15s ease;
		}

		.form-input:focus {
			outline: none;
			border-color: var(--admin-accent-amber);
			box-shadow: 0 0 0 1px var(--admin-accent-amber-dim);
		}

		.form-input::placeholder {
			color: var(--admin-text-tertiary);
		}

		textarea.form-input {
			resize: vertical;
			min-height: 100px;
		}

		select.form-input {
			cursor: pointer;
		}

		/* Quota bar - Linear progress */
		.quota-bar {
			height: 4px;
			background: var(--admin-border);
			overflow: hidden;
			margin-top: 0.75rem;
		}

		.quota-fill {
			height: 100%;
			background: var(--admin-accent-green);
			transition: width 0.4s ease;
		}

		.quota-fill.warning {
			background: var(--admin-accent-amber);
		}

		.quota-fill.danger {
			background: var(--admin-accent-red);
		}

		/* Alert list - Status feed */
		.alert-item {
			display: flex;
			align-items: flex-start;
			gap: 1rem;
			padding: 1rem 1.25rem;
			border-bottom: 1px solid var(--admin-border-subtle);
			transition: background 0.15s ease;
		}

		.alert-item:hover {
			background: var(--admin-bg-elevated);
		}

		.alert-item:last-child {
			border-bottom: none;
		}

		.alert-icon {
			font-family: var(--font-mono);
			font-size: 0.8rem;
			font-weight: 700;
			width: 24px;
			height: 24px;
			display: flex;
			align-items: center;
			justify-content: center;
			background: var(--admin-bg-surface);
			color: var(--admin-text-tertiary);
		}

		.alert-content {
			flex: 1;
			min-width: 0;
		}

		.alert-message {
			font-size: 0.85rem;
			color: var(--admin-text-primary);
			margin-bottom: 0.35rem;
			line-height: 1.4;
		}

		.alert-meta {
			font-family: var(--font-mono);
			font-size: 0.65rem;
			color: var(--admin-text-tertiary);
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}

		/* Loading / Empty states */
		.loading,
		.empty-state {
			text-align: center;
			padding: 4rem 2rem;
			color: var(--admin-text-tertiary);
			font-family: var(--font-mono);
			font-size: 0.75rem;
			text-transform: uppercase;
			letter-spacing: 0.1em;
		}

		.error-message {
			background: var(--admin-accent-red-dim);
			border-left: 3px solid var(--admin-accent-red);
			padding: 1rem 1.25rem;
			margin: 0 2rem 1.5rem;
			font-family: var(--font-mono);
			font-size: 0.75rem;
			color: var(--admin-accent-red);
		}

		/* Toast notifications - Minimal feedback */
		.toast {
			position: fixed;
			bottom: 24px;
			right: 24px;
			padding: 0.875rem 1.25rem;
			background: var(--admin-bg-elevated);
			border: 1px solid var(--admin-border);
			color: var(--admin-text-primary);
			font-family: var(--font-mono);
			font-size: 0.75rem;
			z-index: 1000;
			animation: toast-in 0.25s ease;
			display: flex;
			align-items: center;
			gap: 0.75rem;
		}

		.toast::before {
			content: "";
			width: 8px;
			height: 8px;
			border-radius: 50%;
			background: var(--admin-text-tertiary);
		}

		.toast.success::before {
			background: var(--admin-accent-green);
			box-shadow: 0 0 8px var(--admin-accent-green);
		}

		.toast.error::before {
			background: var(--admin-accent-red);
			box-shadow: 0 0 8px var(--admin-accent-red);
		}

		.toast.info::before {
			background: var(--admin-accent-amber);
			box-shadow: 0 0 8px var(--admin-accent-amber);
		}

		@keyframes toast-in {
			from {
				opacity: 0;
				transform: translateX(20px);
			}
			to {
				opacity: 1;
				transform: translateX(0);
			}
		}

		/* Confirm dialog - Stark modal */
		.dialog-overlay {
			position: fixed;
			inset: 0;
			background: rgba(8, 9, 10, 0.85);
			display: flex;
			align-items: center;
			justify-content: center;
			z-index: 1001;
			backdrop-filter: blur(4px);
		}

		.dialog {
			background: var(--admin-bg-base);
			border: 1px solid var(--admin-border);
			padding: 2rem;
			max-width: 420px;
			width: 90%;
			animation: dialog-in 0.2s ease;
		}

		@keyframes dialog-in {
			from {
				opacity: 0;
				transform: scale(0.95);
			}
			to {
				opacity: 1;
				transform: scale(1);
			}
		}

		.dialog h4 {
			margin: 0 0 1rem 0;
			font-family: var(--font-mono);
			font-size: 0.7rem;
			font-weight: 600;
			color: var(--admin-accent-red);
			text-transform: uppercase;
			letter-spacing: 0.1em;
		}

		.dialog p {
			margin: 0 0 1.5rem 0;
			font-size: 0.9rem;
			color: var(--admin-text-secondary);
			line-height: 1.6;
		}

		.dialog-actions {
			display: flex;
			gap: 0.75rem;
			justify-content: flex-end;
		}

		/* Search input */
		.search-input {
			width: 100%;
			padding: 0.625rem 0.875rem;
			border: 1px solid var(--admin-border);
			background: var(--admin-bg-deep);
			color: var(--admin-text-primary);
			font-family: var(--font-mono);
			font-size: 0.8rem;
			margin-bottom: 1.25rem;
			transition: border-color 0.15s ease;
		}

		.search-input:focus {
			outline: none;
			border-color: var(--admin-accent-amber);
		}

		.search-input::placeholder {
			color: var(--admin-text-tertiary);
		}

		/* Tab loading */
		.tab-loading {
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 4rem 2rem;
			color: var(--admin-text-tertiary);
			font-family: var(--font-mono);
			font-size: 0.75rem;
			text-transform: uppercase;
			letter-spacing: 0.1em;
		}

		.spinner {
			width: 16px;
			height: 16px;
			border: 2px solid var(--admin-border);
			border-top-color: var(--admin-accent-amber);
			border-radius: 50%;
			animation: spin 0.6s linear infinite;
			margin-right: 0.75rem;
		}

		@keyframes spin {
			to {
				transform: rotate(360deg);
			}
		}

		/* Pagination - Data navigation */
		.pagination {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 0.25rem;
			padding: 1.25rem;
			border-top: 1px solid var(--admin-border);
			background: var(--admin-bg-elevated);
		}

		.page-btn {
			padding: 0.5rem 0.75rem;
			border: 1px solid var(--admin-border);
			background: var(--admin-bg-base);
			color: var(--admin-text-secondary);
			font-family: var(--font-mono);
			font-size: 0.65rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			cursor: pointer;
			transition: all 0.15s ease;
		}

		.page-btn:hover:not(:disabled) {
			background: var(--admin-bg-surface);
			border-color: var(--admin-text-tertiary);
			color: var(--admin-text-primary);
		}

		.page-btn:disabled {
			opacity: 0.3;
			cursor: not-allowed;
		}

		.page-btn.active {
			background: var(--admin-accent-amber-dim);
			border-color: transparent;
			color: var(--admin-accent-amber);
		}

		.page-info {
			font-family: var(--font-mono);
			font-size: 0.65rem;
			color: var(--admin-text-tertiary);
			margin: 0 1rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		/* Icon button in tables */
		.icon-btn-table {
			padding: 0.25rem;
			background: transparent;
			border: none;
			color: var(--admin-text-secondary);
			cursor: pointer;
			transition: all 0.15s ease;
		}

		.icon-btn-table:hover {
			color: var(--admin-text-primary);
		}

		.icon-btn-table.danger:hover {
			color: var(--admin-accent-red);
		}

		/* Action row */
		.action-row {
			display: flex;
			gap: 0.5rem;
		}

		/* Responsive */
		@media (max-width: 768px) {
			.stats-grid {
				grid-template-columns: repeat(2, 1fr);
			}

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
	@property({ attribute: false }) apiClient: ApiClient | null = null;

	@state() private currentTab: AdminTab = "overview";
	@state() private loading = false;
	@state() private tabLoading = false;
	@state() private error: string | null = null;

	@state() private quota: UsageQuota | null = null;
	@state() private orgUsage: OrgUsageSummary | null = null;

	// Usage trend data (last 14 days)
	private readonly usageTrend = [
		42000, 58000, 71000, 65000, 89000, 95000, 78000, 102000, 88000, 115000,
		98000, 125000, 110000, 145000,
	];
	private readonly sessionTrend = [
		18, 24, 31, 28, 35, 42, 38, 45, 41, 52, 48, 58, 54, 62,
	];
	@state() private members: OrgMember[] = [];
	@state() private roles: Role[] = [];
	@state() private alerts: Alert[] = [];
	@state() private modelApprovals: ModelApproval[] = [];
	@state() private directoryRules: DirectoryRule[] = [];
	@state() private orgSettings: OrganizationSettings | null = null;

	// UI states
	@state() private toast: Toast | null = null;
	@state() private confirmDialog: ConfirmDialog | null = null;
	@state() private userSearch = "";

	// Form states - initialized from defaults
	@state() private inviteEmail = "";
	@state() private inviteRoleId = "developer";
	@state() private newRulePattern = "";
	@state() private newRuleAccess: "allow" | "deny" = "allow";
	@state() private newRuleDescription = "";
	@state() private piiPatterns = "";
	@state() private auditRetention = 90;
	@state() private webhookUrls = "";

	private api: EnterpriseApiClient;
	private readonly auditTab: AdminAuditTab;
	private readonly policyTab: AdminPolicyTab;
	private alertRefreshInterval: ReturnType<typeof setInterval> | null = null;

	constructor() {
		super();
		this.api = getEnterpriseApi();
		this.auditTab = new AdminAuditTab(
			this,
			this.api,
			(message, type) => this.showToast(message, type),
			(value) => this.formatDate(value),
			(status) => this.getStatusBadgeClass(status),
			[],
		);
		this.policyTab = new AdminPolicyTab(
			this,
			() => this.apiClient,
			(message, type) => this.showToast(message, type),
		);
	}

	override async connectedCallback() {
		super.connectedCallback();
		if (this.api.isAuthenticated()) {
			void this.loadData();
			this.startAlertRefresh();
		}
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this.stopAlertRefresh();
	}

	private startAlertRefresh() {
		this.alertRefreshInterval = setInterval(() => {
			this.refreshAlerts();
		}, 30000);
	}

	private stopAlertRefresh() {
		if (this.alertRefreshInterval) {
			clearInterval(this.alertRefreshInterval);
			this.alertRefreshInterval = null;
		}
	}

	private async refreshAlerts() {
		try {
			const alertsRes = await this.api.getAlerts();
			this.alerts = alertsRes.alerts;
		} catch {
			// Silently fail on background refresh
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
		if (!this.api.isAuthenticated()) return;

		try {
			switch (tab) {
				case "users": {
					const [membersRes, rolesRes] = await Promise.all([
						this.api.getOrgMembers().catch(() => ({ members: [] })),
						this.api.getRoles().catch(() => ({ roles: [] })),
					]);
					this.members = membersRes.members;
					this.roles = rolesRes.roles;
					if (
						this.roles.length > 0 &&
						!this.roles.some((role) => role.id === this.inviteRoleId)
					) {
						this.inviteRoleId = this.roles[0]?.id ?? "";
					}
					break;
				}
				case "models": {
					const approvalsRes = await this.api
						.getModelApprovals()
						.catch(() => null);
					this.modelApprovals = approvalsRes?.approvals ?? [];
					break;
				}
				case "directories": {
					const rulesRes = await this.api.getDirectoryRules().catch(() => null);
					this.directoryRules = rulesRes?.rules ?? [];
					break;
				}
				case "security": {
					const settings = await this.api.getOrgSettings().catch(() => null);
					this.orgSettings = settings;
					this.piiPatterns = settings?.piiPatterns?.join("\n") || "";
					this.auditRetention = settings?.auditRetentionDays || 90;
					this.webhookUrls = settings?.alertWebhooks?.join("\n") || "";
					break;
				}
				case "audit": {
					const logsRes = await this.api
						.getAuditLogs({ limit: 500 })
						.catch(() => null);
					if (logsRes?.logs) {
						this.auditTab.setLogs(logsRes.logs);
					}
					break;
				}
			}
		} catch (e) {
			console.error("Failed to load admin tab data", { tab, error: e });
		}
	}

	private renderUnavailableState(message: string) {
		return html`<div class="empty-state">${message}</div>`;
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
				return "!!";
			case "high":
				return "!";
			case "medium":
				return "*";
			case "low":
				return "-";
			default:
				return "i";
		}
	}

	private getStatusBadgeClass(status: string): string {
		switch (status) {
			case "success":
			case "approved":
			case "auto_approved":
			case "info":
			case "low":
				return "success";
			case "failure":
			case "error":
			case "denied":
			case "critical":
			case "high":
				return "error";
			case "pending":
			case "medium":
				return "warning";
			default:
				return "";
		}
	}

	private showToast(message: string, type: Toast["type"] = "info") {
		this.toast = { message, type };
		setTimeout(() => {
			if (this.toast?.message === message) {
				this.toast = null;
			}
		}, 3500);
	}

	private showConfirm(options: ConfirmDialog) {
		this.confirmDialog = options;
	}

	private closeConfirm() {
		this.confirmDialog = null;
	}

	private async handleConfirm() {
		if (this.confirmDialog) {
			await this.confirmDialog.onConfirm();
			this.confirmDialog = null;
		}
	}

	// User management actions
	private async handleInviteUser() {
		const hasSelectedRole = this.roles.some(
			(role) => role.id === this.inviteRoleId,
		);

		if (!this.inviteEmail || !this.inviteRoleId || !hasSelectedRole) {
			this.showToast("Please enter email and select a role", "error");
			return;
		}

		try {
			await this.api.inviteUser(this.inviteEmail, this.inviteRoleId);
			this.showToast(`Invited ${this.inviteEmail}`, "success");
			this.inviteEmail = "";
			await this.loadTabData("users");
		} catch (e) {
			this.showToast(
				e instanceof Error ? e.message : "Failed to invite user",
				"error",
			);
		}
	}

	private confirmRemoveMember(member: OrgMember) {
		this.showConfirm({
			title: "Remove Team Member",
			message: `Are you sure you want to remove ${member.user.name || member.user.email} from the organization? This action cannot be undone.`,
			confirmText: "Remove",
			onConfirm: async () => {
				try {
					await this.api.removeMember(member.userId);
					this.showToast("Member removed", "success");
					await this.loadTabData("users");
				} catch (e) {
					this.showToast(
						e instanceof Error ? e.message : "Failed to remove member",
						"error",
					);
				}
			},
		});
	}

	// Model approval actions
	private async handleApproveModel(modelId: string) {
		try {
			await this.api.approveModel(modelId);
			this.showToast("Model approved", "success");
			await this.loadTabData("models");
		} catch (e) {
			this.showToast(
				e instanceof Error ? e.message : "Failed to approve model",
				"error",
			);
		}
	}

	private async handleDenyModel(modelId: string) {
		try {
			await this.api.denyModel(modelId);
			this.showToast("Model denied", "success");
			await this.loadTabData("models");
		} catch (e) {
			this.showToast(
				e instanceof Error ? e.message : "Failed to deny model",
				"error",
			);
		}
	}

	// Directory rule actions
	private async handleAddDirectoryRule() {
		if (!this.newRulePattern) {
			this.showToast("Please enter a pattern", "error");
			return;
		}

		try {
			await this.api.createDirectoryRule({
				pattern: this.newRulePattern,
				isAllowed: this.newRuleAccess === "allow",
				description: this.newRuleDescription || undefined,
			});
			this.showToast("Rule created", "success");
			this.newRulePattern = "";
			this.newRuleDescription = "";
			await this.loadTabData("directories");
		} catch (e) {
			this.showToast(
				e instanceof Error ? e.message : "Failed to create rule",
				"error",
			);
		}
	}

	private confirmDeleteRule(rule: DirectoryRule) {
		this.showConfirm({
			title: "Delete Directory Rule",
			message: `Are you sure you want to delete the rule for "${rule.pattern}"?`,
			confirmText: "Delete",
			onConfirm: async () => {
				try {
					await this.api.deleteDirectoryRule(rule.id);
					this.showToast("Rule deleted", "success");
					await this.loadTabData("directories");
				} catch (e) {
					this.showToast(
						e instanceof Error ? e.message : "Failed to delete rule",
						"error",
					);
				}
			},
		});
	}

	// Security settings actions
	private async handleSavePiiSettings() {
		try {
			const patterns = this.piiPatterns
				.split("\n")
				.map((p) => p.trim())
				.filter(Boolean);
			await this.api.updateOrgSettings({
				piiRedactionEnabled: true,
				piiPatterns: patterns,
			});
			this.showToast("PII settings saved", "success");
		} catch (e) {
			this.showToast(
				e instanceof Error ? e.message : "Failed to save settings",
				"error",
			);
		}
	}

	private async handleSaveRetention() {
		try {
			await this.api.updateOrgSettings({
				auditRetentionDays: this.auditRetention,
			});
			this.showToast("Retention settings saved", "success");
		} catch (e) {
			this.showToast(
				e instanceof Error ? e.message : "Failed to save settings",
				"error",
			);
		}
	}

	private async handleSaveWebhooks() {
		try {
			const webhooks = this.webhookUrls
				.split("\n")
				.map((u) => u.trim())
				.filter(Boolean);
			await this.api.updateOrgSettings({
				alertWebhooks: webhooks,
			});
			this.showToast("Webhooks saved", "success");
		} catch (e) {
			this.showToast(
				e instanceof Error ? e.message : "Failed to save webhooks",
				"error",
			);
		}
	}

	// Alert actions
	private async handleMarkAlertRead(alert: Alert) {
		try {
			await this.api.markAlertRead(alert.id);
			this.alerts = this.alerts.map((a) =>
				a.id === alert.id ? { ...a, isRead: true } : a,
			);
		} catch (e) {
			this.showToast("Failed to mark alert as read", "error");
		}
	}

	private async handleResolveAlert(alert: Alert) {
		try {
			await this.api.resolveAlert(alert.id);
			this.alerts = this.alerts.map((a) =>
				a.id === alert.id ? { ...a, resolvedAt: new Date().toISOString() } : a,
			);
			this.showToast("Alert resolved", "success");
		} catch (e) {
			this.showToast("Failed to resolve alert", "error");
		}
	}

	private get filteredMembers(): OrgMember[] {
		if (!this.userSearch) return this.members;
		const search = this.userSearch.toLowerCase();
		return this.members.filter(
			(member) =>
				member.user.name?.toLowerCase().includes(search) ||
				member.user.email?.toLowerCase().includes(search),
		);
	}

	private renderSparkline(
		data: number[],
		color = "var(--admin-accent)",
		width = 120,
		height = 32,
	) {
		if (data.length < 2) return "";
		const max = Math.max(...data);
		const min = Math.min(...data);
		const range = max - min || 1;
		const step = width / (data.length - 1);

		const points = data
			.map((v, i) => {
				const x = i * step;
				const y = height - ((v - min) / range) * (height - 4) - 2;
				return `${x},${y}`;
			})
			.join(" ");

		const lastY =
			height - ((data[data.length - 1]! - min) / range) * (height - 4) - 2;

		return html`
			<svg width="${width}" height="${height}" style="display: block;">
				<polyline
					points="${points}"
					fill="none"
					stroke="${color}"
					stroke-width="1.5"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
				<circle cx="${width}" cy="${lastY}" r="2.5" fill="${color}" />
			</svg>
		`;
	}

	// =========================================================================
	// RENDER METHODS
	// =========================================================================

	private renderOverviewTab() {
		if (!this.api.isAuthenticated()) {
			return this.renderUnavailableState(
				"Sign in with enterprise credentials to view admin settings.",
			);
		}

		const unreadAlerts = this.alerts.filter((a) => !a.isRead).length;

		return html`
			<div class="stats-grid">
				<div class="stat-card">
					<div style="display: flex; justify-content: space-between; align-items: flex-start;">
						<div>
							<div class="stat-value">${this.formatNumber(this.orgUsage?.totalTokens || 0)}</div>
							<div class="stat-label">Total Tokens</div>
						</div>
						<div style="opacity: 0.8;">${this.renderSparkline(this.usageTrend)}</div>
					</div>
				</div>
				<div class="stat-card">
					<div style="display: flex; justify-content: space-between; align-items: flex-start;">
						<div>
							<div class="stat-value">${this.orgUsage?.totalSessions || 0}</div>
							<div class="stat-label">Sessions</div>
						</div>
						<div style="opacity: 0.8;">${this.renderSparkline(this.sessionTrend, "var(--admin-accent-green)")}</div>
					</div>
				</div>
				<div class="stat-card">
					<div class="stat-value">${this.orgUsage?.totalUsers || 0}</div>
					<div class="stat-label">Active Users</div>
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
									<div class="alert-item" style="opacity: ${alert.isRead ? 0.7 : 1}">
										<span class="alert-icon">${this.getSeverityIcon(alert.severity)}</span>
										<div class="alert-content">
											<div class="alert-message">${alert.message}</div>
											<div class="alert-meta">
												<span class="badge ${this.getStatusBadgeClass(alert.severity)}">${alert.severity}</span>
												&nbsp;•&nbsp; ${this.formatDate(alert.createdAt)}
												${alert.resolvedAt ? html`&nbsp;•&nbsp; <span class="badge success">Resolved</span>` : ""}
											</div>
										</div>
										<div class="action-row">
											${!alert.isRead ? html`<button class="btn btn-sm" @click=${() => this.handleMarkAlertRead(alert)}>Mark Read</button>` : ""}
											${!alert.resolvedAt ? html`<button class="btn btn-sm" @click=${() => this.handleResolveAlert(alert)}>Resolve</button>` : ""}
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
				this.orgUsage?.modelBreakdown && this.orgUsage.modelBreakdown.length > 0
					? html`
					<div class="section">
						<div class="section-header">
							<h3>Usage by Model</h3>
						</div>
						<div class="section-content">
							${this.orgUsage.modelBreakdown.map((model) => {
								const total =
									this.orgUsage?.modelBreakdown.reduce(
										(sum, m) => sum + m.tokenUsed,
										0,
									) || 1;
								const pct = (model.tokenUsed / total) * 100;
								return html`
									<div style="margin-bottom: 1rem;">
										<div style="display: flex; justify-content: space-between; margin-bottom: 0.35rem; font-size: 0.8rem;">
											<span style="font-family: var(--font-mono);">${model.modelId}</span>
											<span style="color: var(--admin-text-secondary);">${this.formatNumber(model.tokenUsed)} (${pct.toFixed(1)}%)</span>
										</div>
										<div style="height: 6px; background: var(--admin-bg-surface); border-radius: 3px; overflow: hidden;">
											<div style="height: 100%; width: ${pct}%; background: var(--admin-accent); border-radius: 3px;"></div>
										</div>
									</div>
								`;
							})}
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
		if (!this.api.isAuthenticated()) {
			return this.renderUnavailableState(
				"Sign in with enterprise credentials to manage users and roles.",
			);
		}

		if (this.tabLoading) {
			return html`<div class="tab-loading"><span class="spinner"></span>Loading users...</div>`;
		}

		const filteredMembers = this.filteredMembers;
		const canInvite = this.roles.length > 0;

		return html`
			<div class="section">
				<div class="section-header">
					<h3>Invite New User</h3>
				</div>
				<div class="section-content">
					<div style="display: flex; gap: 0.75rem; align-items: flex-end;">
						<div class="form-group" style="flex: 1; margin-bottom: 0;">
							<label class="form-label">Email Address</label>
							<input
								type="email"
								class="form-input"
								placeholder="user@example.com"
								.value=${this.inviteEmail}
								@input=${(e: Event) => {
									this.inviteEmail = (e.target as HTMLInputElement).value;
								}}
							/>
						</div>
						<div class="form-group" style="width: 180px; margin-bottom: 0;">
							<label class="form-label">Role</label>
							<select
								class="form-input"
								?disabled=${!canInvite}
								.value=${this.inviteRoleId}
								@change=${(e: Event) => {
									this.inviteRoleId = (e.target as HTMLSelectElement).value;
								}}
							>
								${this.roles.map((role) => html`<option value=${role.id}>${role.name}</option>`)}
							</select>
						</div>
						<button class="btn btn-primary" ?disabled=${!canInvite} @click=${this.handleInviteUser}>Invite</button>
					</div>
					${
						canInvite
							? ""
							: html`<div class="empty-state" style="padding: 1rem 0 0;">No roles available. Please wait for roles to load before inviting users.</div>`
					}
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Team Members (${this.members.length})</h3>
				</div>
				<div class="section-content">
					<input
						type="text"
						class="search-input"
						placeholder="Search by name or email..."
						.value=${this.userSearch}
						@input=${(e: Event) => {
							this.userSearch = (e.target as HTMLInputElement).value;
						}}
					/>
					${
						filteredMembers.length > 0
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
									${filteredMembers.map(
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
													<div class="action-row">
														<button class="btn btn-sm btn-danger" @click=${() => this.confirmRemoveMember(member)}>Remove</button>
													</div>
												</td>
											</tr>
										`,
									)}
								</tbody>
							</table>
						`
							: html`<div class="empty-state">${this.userSearch ? "No matching members found" : "No team members found"}</div>`
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
		if (!this.api.isAuthenticated()) {
			return this.renderUnavailableState(
				"Sign in with enterprise credentials to review model approvals.",
			);
		}

		if (this.tabLoading) {
			return html`<div class="tab-loading"><span class="spinner"></span>Loading models...</div>`;
		}

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
															<div class="action-row">
																<button class="btn btn-sm btn-primary" @click=${() => this.handleApproveModel(approval.modelId)}>Approve</button>
																<button class="btn btn-sm btn-danger" @click=${() => this.handleDenyModel(approval.modelId)}>Deny</button>
															</div>
														`
															: html`<span class="badge ${this.getStatusBadgeClass(approval.status)}">${approval.status}</span>`
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
		if (!this.api.isAuthenticated()) {
			return this.renderUnavailableState(
				"Sign in with enterprise credentials to manage directory rules.",
			);
		}

		if (this.tabLoading) {
			return html`<div class="tab-loading"><span class="spinner"></span>Loading directory rules...</div>`;
		}

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
								@input=${(e: Event) => {
									this.newRulePattern = (e.target as HTMLInputElement).value;
								}}
							/>
						</div>
						<div class="form-group" style="margin-bottom: 0;">
							<label class="form-label">Access</label>
							<select
								class="form-input"
								.value=${this.newRuleAccess}
								@change=${(e: Event) => {
									this.newRuleAccess = (e.target as HTMLSelectElement).value as
										| "allow"
										| "deny";
								}}
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
								@input=${(e: Event) => {
									this.newRuleDescription = (
										e.target as HTMLInputElement
									).value;
								}}
							/>
						</div>
						<button class="btn btn-primary" @click=${this.handleAddDirectoryRule}>Add Rule</button>
					</div>
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Directory Access Rules (${this.directoryRules.length})</h3>
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

	private renderSecurityTab() {
		if (!this.api.isAuthenticated()) {
			return this.renderUnavailableState(
				"Sign in with enterprise credentials to configure security settings.",
			);
		}

		if (this.tabLoading) {
			return html`<div class="tab-loading"><span class="spinner"></span>Loading security settings...</div>`;
		}

		return html`
			<div class="section">
				<div class="section-header">
					<h3>PII Detection Settings</h3>
				</div>
				<div class="section-content">
					<div class="form-group">
						<label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
							<input type="checkbox" ?checked=${this.orgSettings?.piiRedactionEnabled ?? true} />
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
							.value=${this.piiPatterns}
							@input=${(e: Event) => {
								this.piiPatterns = (e.target as HTMLTextAreaElement).value;
							}}
						></textarea>
					</div>
					<button class="btn btn-primary" @click=${this.handleSavePiiSettings}>Save Settings</button>
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Audit Retention</h3>
				</div>
				<div class="section-content">
					<div class="form-group">
						<label class="form-label">Retention Period (days)</label>
						<input
							type="number"
							class="form-input"
							min="30"
							max="365"
							.value=${String(this.auditRetention)}
							@input=${(e: Event) => {
								this.auditRetention =
									Number.parseInt((e.target as HTMLInputElement).value, 10) ||
									90;
							}}
						/>
					</div>
					<button class="btn btn-primary" @click=${this.handleSaveRetention}>Update</button>
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
							.value=${this.webhookUrls}
							@input=${(e: Event) => {
								this.webhookUrls = (e.target as HTMLTextAreaElement).value;
							}}
						></textarea>
					</div>
					<button class="btn btn-primary" @click=${this.handleSaveWebhooks}>Save Webhooks</button>
				</div>
			</div>
		`;
	}

	private renderAuditTab() {
		if (!this.api.isAuthenticated()) {
			return this.renderUnavailableState(
				"Sign in with enterprise credentials to inspect audit logs.",
			);
		}

		return this.auditTab.render(this.tabLoading);
	}

	private renderPolicyTab() {
		if (!this.api.isAuthenticated()) {
			return this.renderUnavailableState(
				"Sign in with enterprise credentials to manage enterprise policy.",
			);
		}

		return this.policyTab.render();
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
			case "policy":
				return this.renderPolicyTab();
			case "audit":
				return this.renderAuditTab();
			default:
				return this.renderOverviewTab();
		}
	}

	override render() {
		return html`
			<div class="admin-header">
				<h2>Admin Settings</h2>
				<button class="close-btn" @click=${this.close}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M18 6L6 18M6 6l12 12"/>
						</svg>
					</button>
			</div>

			${this.error ? html`<div class="error-message">${this.error}</div>` : ""}

			<div class="admin-layout">
				<nav class="sidebar">
					<div
						class="nav-item ${this.currentTab === "overview" ? "active" : ""}"
						@click=${() => this.selectTab("overview")}
					>
						<span>Overview</span>
					</div>
					<div
						class="nav-item ${this.currentTab === "users" ? "active" : ""}"
						@click=${() => this.selectTab("users")}
					>
						<span>Users & Roles</span>
					</div>
					<div
						class="nav-item ${this.currentTab === "models" ? "active" : ""}"
						@click=${() => this.selectTab("models")}
					>
						<span>Model Approvals</span>
					</div>
					<div
						class="nav-item ${this.currentTab === "directories" ? "active" : ""}"
						@click=${() => this.selectTab("directories")}
					>
						<span>Directories</span>
					</div>
					<div
						class="nav-item ${this.currentTab === "security" ? "active" : ""}"
						@click=${() => this.selectTab("security")}
					>
						<span>Security & PII</span>
					</div>
					<div
						class="nav-item ${this.currentTab === "policy" ? "active" : ""}"
						@click=${() => this.selectTab("policy")}
					>
						<span>Enterprise Policy</span>
					</div>
					<div
						class="nav-item ${this.currentTab === "audit" ? "active" : ""}"
						@click=${() => this.selectTab("audit")}
					>
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

			${
				this.toast
					? html`<div class="toast ${this.toast.type}">${this.toast.message}</div>`
					: ""
			}

			${
				this.confirmDialog
					? html`
					<div class="dialog-overlay" @click=${this.closeConfirm}>
						<div class="dialog" @click=${(e: Event) => e.stopPropagation()}>
							<h4>${this.confirmDialog.title}</h4>
							<p>${this.confirmDialog.message}</p>
							<div class="dialog-actions">
								<button class="btn" @click=${this.closeConfirm}>Cancel</button>
								<button class="btn btn-danger" @click=${this.handleConfirm}>${this.confirmDialog.confirmText}</button>
							</div>
						</div>
					</div>
				`
					: ""
			}
		`;
	}
}
