import { type LitElement, html } from "lit";
import type {
	AuditLog,
	EnterpriseApiClient,
} from "../services/enterprise-api.js";

type ToastType = "success" | "error" | "info";

export class AdminAuditTab {
	private auditLogs: AuditLog[];

	private auditSearch = "";

	private auditPage = 1;

	private readonly auditPageSize = 20;

	constructor(
		private readonly host: Pick<LitElement, "requestUpdate">,
		private readonly api: Pick<EnterpriseApiClient, "exportAuditLogs">,
		private readonly showToast: (message: string, type: ToastType) => void,
		private readonly formatDate: (dateStr: string) => string,
		private readonly getStatusBadgeClass: (status: string) => string,
		initialLogs: AuditLog[] = [],
	) {
		this.auditLogs = [...initialLogs];
	}

	setLogs(logs: AuditLog[]) {
		this.auditLogs = [...logs];
		this.auditPage = 1;
		this.host.requestUpdate();
	}

	render(tabLoading: boolean) {
		if (tabLoading) {
			return html`<div class="tab-loading"><span class="spinner"></span>Loading audit logs...</div>`;
		}

		const filteredLogs = this.filteredAuditLogs;
		const paginatedLogs = this.paginatedAuditLogs;
		const totalPages = this.totalAuditPages;

		return html`
			<div class="section">
				<div class="section-header">
					<h3>Audit Logs (${filteredLogs.length})</h3>
					<button class="btn btn-sm" @click=${this.handleExportAuditLogs}>Export CSV</button>
				</div>
				<div class="section-content">
					<input
						type="text"
						class="search-input"
						placeholder="Search by action, user ID, or resource type..."
						.value=${this.auditSearch}
						@input=${this.handleSearchInput}
					/>
					${
						paginatedLogs.length > 0
							? html`
								<table class="data-table">
									<thead>
										<tr>
											<th>Timestamp</th>
											<th>Action</th>
											<th>User</th>
											<th>Status</th>
											<th>Duration</th>
											<th>Details</th>
										</tr>
									</thead>
									<tbody>
										${paginatedLogs.map(
											(log) => html`
												<tr>
													<td style="white-space: nowrap; font-size: 0.75rem;">
														${this.formatDate(log.createdAt)}
													</td>
													<td><code style="font-size: 0.75rem;">${log.action}</code></td>
													<td>
														<code style="font-size: 0.7rem;" title=${log.userId || ""}>${log.userId?.slice(0, 8) || "-"}...</code>
													</td>
													<td>
														<span class="badge ${this.getStatusBadgeClass(log.status)}">
															${log.status}
														</span>
													</td>
													<td style="font-size: 0.75rem;">
														${log.durationMs !== undefined ? `${log.durationMs}ms` : "-"}
													</td>
													<td style="font-size: 0.75rem; max-width: 200px; overflow: hidden; text-overflow: ellipsis;">
														${this.formatMetadata(log)}
													</td>
												</tr>
											`,
										)}
									</tbody>
								</table>
								${
									totalPages > 1
										? html`
											<div class="pagination">
												<button
													class="page-btn"
													?disabled=${this.auditPage === 1}
													@click=${this.goToFirstPage}
												>First</button>
												<button
													class="page-btn"
													?disabled=${this.auditPage === 1}
													@click=${this.goToPreviousPage}
												>Prev</button>
												<span class="page-info">Page ${this.auditPage} of ${totalPages}</span>
												<button
													class="page-btn"
													?disabled=${this.auditPage === totalPages}
													@click=${this.goToNextPage}
												>Next</button>
												<button
													class="page-btn"
													?disabled=${this.auditPage === totalPages}
													@click=${this.goToLastPage}
												>Last</button>
											</div>
										`
										: ""
								}
							`
							: html`<div class="empty-state">${this.auditSearch ? "No matching logs found" : "No audit logs available"}</div>`
					}
				</div>
			</div>
		`;
	}

	private get filteredAuditLogs(): AuditLog[] {
		if (!this.auditSearch) return this.auditLogs;
		const search = this.auditSearch.toLowerCase();
		return this.auditLogs.filter(
			(log) =>
				log.action?.toLowerCase().includes(search) ||
				log.userId?.toLowerCase().includes(search) ||
				log.resourceType?.toLowerCase().includes(search),
		);
	}

	private get paginatedAuditLogs(): AuditLog[] {
		const filtered = this.filteredAuditLogs;
		const start = (this.auditPage - 1) * this.auditPageSize;
		return filtered.slice(start, start + this.auditPageSize);
	}

	private get totalAuditPages(): number {
		return Math.ceil(this.filteredAuditLogs.length / this.auditPageSize);
	}

	private readonly handleSearchInput = (event: Event) => {
		this.auditSearch = (event.target as HTMLInputElement).value;
		this.auditPage = 1;
		this.host.requestUpdate();
	};

	private readonly goToFirstPage = () => {
		this.auditPage = 1;
		this.host.requestUpdate();
	};

	private readonly goToPreviousPage = () => {
		this.auditPage = Math.max(1, this.auditPage - 1);
		this.host.requestUpdate();
	};

	private readonly goToNextPage = () => {
		this.auditPage = Math.min(this.totalAuditPages, this.auditPage + 1);
		this.host.requestUpdate();
	};

	private readonly goToLastPage = () => {
		this.auditPage = this.totalAuditPages;
		this.host.requestUpdate();
	};

	private readonly handleExportAuditLogs = async () => {
		try {
			const csv = await this.api.exportAuditLogs("csv");
			const blob = new Blob([csv], { type: "text/csv" });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `audit-logs-${new Date().toISOString().split("T")[0]}.csv`;
			anchor.click();
			URL.revokeObjectURL(url);
			this.showToast("Export started", "success");
		} catch (error) {
			this.showToast(
				error instanceof Error ? error.message : "Failed to export logs",
				"error",
			);
		}
	};

	private formatMetadata(log: AuditLog): string {
		return log.metadata ? JSON.stringify(log.metadata).slice(0, 50) : "-";
	}
}
