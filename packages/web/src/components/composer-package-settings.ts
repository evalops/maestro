import { formatMcpRegistryScopeLabel } from "@evalops/contracts";
import { LitElement, type PropertyValues, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
	ApiClient,
	PackageInspectResponse,
	PackageScope,
	PackageSearchResponse,
	PackageStatusResponse,
} from "../services/api-client.js";

@customElement("composer-package-settings")
export class ComposerPackageSettings extends LitElement {
	@property({ attribute: false }) apiClient!: ApiClient;

	@state() private packageStatus: PackageStatusResponse | null = null;
	@state() private packageSource = "";
	@state() private packageScope: PackageScope = "local";
	@state() private packageAction: "inspect" | "validate" | "add" | null = null;
	@state() private packageRemovingKey: string | null = null;
	@state() private packageRefreshingKey: string | null = null;
	@state() private packageRefreshingAll = false;
	@state() private packagePruning = false;
	@state() private packageError: string | null = null;
	@state() private packageNotice: string | null = null;
	@state() private packageSearchQuery = "";
	@state() private packageSearchLoading = false;
	@state() private packageSearchError: string | null = null;
	@state() private packageSearchResults: PackageSearchResponse["entries"] = [];
	@state() private packageSearchAddingSource: string | null = null;
	@state() private packagePreview: {
		kind: "inspect" | "validate";
		result: PackageInspectResponse;
	} | null = null;

	private packageDataRequestId = 0;
	private packageSearchRequestId = 0;

	protected override createRenderRoot() {
		return this;
	}

	protected override updated(changed: PropertyValues<this>) {
		if (changed.has("apiClient")) {
			void this.loadPackageData();
		}
	}

	private async loadPackageData() {
		const apiClient = this.apiClient;
		if (!apiClient) return;
		const dataRequestId = ++this.packageDataRequestId;
		const searchRequestId = ++this.packageSearchRequestId;
		this.packageSearchLoading = false;

		const [packageStatusResult, packageSearchResult] = await Promise.allSettled(
			[apiClient.getPackageStatus(), apiClient.searchPackages("")],
		);

		if (
			this.apiClient !== apiClient ||
			dataRequestId !== this.packageDataRequestId
		)
			return;

		if (packageStatusResult.status === "fulfilled") {
			this.packageStatus = packageStatusResult.value;
		} else {
			this.packageStatus = null;
		}

		if (searchRequestId !== this.packageSearchRequestId) return;

		if (packageSearchResult.status === "fulfilled") {
			this.packageSearchResults = packageSearchResult.value.entries ?? [];
			this.packageSearchError = null;
		} else {
			this.packageSearchResults = [];
			this.packageSearchError =
				packageSearchResult.reason instanceof Error
					? packageSearchResult.reason.message
					: "Failed to load package search results";
		}
	}

	private formatScopeLabel(
		scope: PackageScope | PackageStatusResponse["packages"][number]["scope"],
	): string {
		return formatMcpRegistryScopeLabel(scope);
	}

	private formatPackageFilters(
		filters: PackageStatusResponse["packages"][number]["filters"],
	): string | null {
		if (!filters) {
			return null;
		}

		const parts: string[] = [];
		for (const key of ["extensions", "skills", "prompts", "themes"] as const) {
			const values = filters[key];
			if (values && values.length > 0) {
				parts.push(`${key}=${values.join(",")}`);
			}
		}

		return parts.length > 0 ? parts.join(" ") : null;
	}

	private async refreshPackageStatus() {
		this.packageStatus = await this.apiClient.getPackageStatus();
	}

	private async runPackagePreview(kind: "inspect" | "validate") {
		const source = this.packageSource.trim();
		if (!source) {
			this.packageError = "Package source is required.";
			this.packageNotice = null;
			this.packagePreview = null;
			return;
		}

		this.packageAction = kind;
		this.packageError = null;
		this.packageNotice = null;
		this.packagePreview = null;
		try {
			const result =
				kind === "inspect"
					? await this.apiClient.inspectPackage(source)
					: await this.apiClient.validatePackage(source);
			this.packagePreview = { kind, result };
		} catch (error) {
			this.packageError =
				error instanceof Error ? error.message : "Failed to inspect package";
		} finally {
			if (this.packageAction === kind) {
				this.packageAction = null;
			}
		}
	}

	private async addPackage() {
		const source = this.packageSource.trim();
		if (!source) {
			this.packageError = "Package source is required.";
			this.packageNotice = null;
			return;
		}

		this.packageAction = "add";
		this.packageError = null;
		this.packageNotice = null;
		try {
			const result = await this.apiClient.addPackage({
				source,
				scope: this.packageScope,
			});
			await this.refreshPackageStatus();
			this.packageNotice = `Added configured package "${source}" to ${this.formatScopeLabel(result.scope)}.`;
			this.packageSource = "";
			this.packagePreview = null;
		} catch (error) {
			this.packageError =
				error instanceof Error ? error.message : "Failed to add package";
		} finally {
			if (this.packageAction === "add") {
				this.packageAction = null;
			}
		}
	}

	private async searchPackages(query: string) {
		const apiClient = this.apiClient;
		if (!apiClient) return;
		const requestId = ++this.packageSearchRequestId;
		this.packageSearchLoading = true;
		this.packageSearchError = null;
		try {
			const result = await apiClient.searchPackages(query);
			if (
				this.apiClient !== apiClient ||
				requestId !== this.packageSearchRequestId
			)
				return;
			this.packageSearchResults = result.entries ?? [];
		} catch (error) {
			if (
				this.apiClient !== apiClient ||
				requestId !== this.packageSearchRequestId
			)
				return;
			this.packageSearchResults = [];
			this.packageSearchError =
				error instanceof Error
					? error.message
					: "Failed to search package registry";
		} finally {
			if (
				this.apiClient === apiClient &&
				requestId === this.packageSearchRequestId
			) {
				this.packageSearchLoading = false;
			}
		}
	}

	private async addDiscoveredPackage(
		entry: PackageSearchResponse["entries"][number],
	) {
		this.packageSearchAddingSource = entry.installSource;
		this.packageError = null;
		this.packageNotice = null;
		try {
			const result = await this.apiClient.addPackage({
				source: entry.installSource,
				scope: this.packageScope,
			});
			await this.refreshPackageStatus();
			this.packageNotice = `Added configured package "${entry.installSource}" to ${this.formatScopeLabel(result.scope)}.`;
			this.packageSource = entry.installSource;
			this.packagePreview = null;
		} catch (error) {
			this.packageError =
				error instanceof Error ? error.message : "Failed to add package";
		} finally {
			if (this.packageSearchAddingSource === entry.installSource) {
				this.packageSearchAddingSource = null;
			}
		}
	}

	private async removePackage(
		entry: PackageStatusResponse["packages"][number],
	) {
		const key = `${entry.scope}:${entry.sourceSpec}`;
		this.packageRemovingKey = key;
		this.packageError = null;
		this.packageNotice = null;
		try {
			const result = await this.apiClient.removePackage({
				source: entry.sourceSpec,
				scope: entry.scope,
			});
			await this.refreshPackageStatus();
			this.packageNotice = result.fallback
				? `Removed configured package "${entry.sourceSpec}" from ${this.formatScopeLabel(result.scope)}. Still configured in ${this.formatScopeLabel(result.fallback.scope)}.`
				: `Removed configured package "${entry.sourceSpec}" from ${this.formatScopeLabel(result.scope)}.`;
		} catch (error) {
			this.packageError =
				error instanceof Error ? error.message : "Failed to remove package";
		} finally {
			if (this.packageRemovingKey === key) {
				this.packageRemovingKey = null;
			}
		}
	}

	private async refreshPackage(
		entry: PackageStatusResponse["packages"][number],
	) {
		const key = `${entry.scope}:${entry.sourceSpec}`;
		this.packageRefreshingKey = key;
		this.packageError = null;
		this.packageNotice = null;
		try {
			const result = await this.apiClient.refreshPackage(entry.sourceSpec);
			await this.refreshPackageStatus();
			this.packagePreview = { kind: "inspect", result };
			this.packageNotice = `Refreshed configured package "${entry.sourceSpec}" from ${this.formatScopeLabel(entry.scope)}.`;
		} catch (error) {
			this.packageError =
				error instanceof Error ? error.message : "Failed to refresh package";
		} finally {
			if (this.packageRefreshingKey === key) {
				this.packageRefreshingKey = null;
			}
		}
	}

	private async refreshAllPackages() {
		this.packageRefreshingAll = true;
		this.packageError = null;
		this.packageNotice = null;
		try {
			const result = await this.apiClient.refreshAllPackages();
			await this.refreshPackageStatus();
			this.packagePreview = null;
			const failureCount = result.refreshed.filter(
				(entry) => entry.error,
			).length;
			this.packageNotice =
				failureCount > 0
					? `Refreshed ${result.remoteCount - failureCount} configured remote packages. ${failureCount} failed.`
					: `Refreshed ${result.remoteCount} configured remote packages.`;
		} catch (error) {
			this.packageError =
				error instanceof Error
					? error.message
					: "Failed to refresh configured packages";
		} finally {
			this.packageRefreshingAll = false;
		}
	}

	private async prunePackageCache() {
		this.packagePruning = true;
		this.packageError = null;
		this.packageNotice = null;
		try {
			const result = await this.apiClient.prunePackageCache();
			await this.refreshPackageStatus();
			this.packagePreview = null;
			this.packageNotice =
				result.removedCount > 0
					? `Pruned ${result.removedCount} unconfigured remote package caches.`
					: "No unconfigured remote package caches found.";
		} catch (error) {
			this.packageError =
				error instanceof Error
					? error.message
					: "Failed to prune package cache";
		} finally {
			this.packagePruning = false;
		}
	}

	private canRefreshPackage(
		entry: PackageStatusResponse["packages"][number],
	): boolean {
		const sourceType = entry.inspection?.sourceType;
		return sourceType === "git" || sourceType === "npm";
	}

	override render() {
		const entries = this.packageStatus?.packages ?? [];
		const hasRefreshableEntries = entries.some((entry) =>
			this.canRefreshPackage(entry),
		);

		return html`
			<div class="section">
				<div class="section-header">
					<h3>Packages</h3>
				</div>
				<div class="section-content">
					<div class="control-row">
						<div>
							<div class="info-value">Configured Packages</div>
							<div class="info-label">Slash command: /package</div>
						</div>
						<button
							class="action-btn"
							@click=${() => void this.refreshPackageStatus()}
						>
							Refresh
						</button>
						<button
							class="action-btn"
							@click=${() => void this.prunePackageCache()}
							?disabled=${this.packagePruning}
						>
							${this.packagePruning ? "Pruning cache..." : "Prune cache"}
						</button>
						${
							hasRefreshableEntries
								? html`
									<button
										class="action-btn"
										@click=${() => void this.refreshAllPackages()}
										?disabled=${this.packageRefreshingAll}
									>
										${
											this.packageRefreshingAll
												? "Refreshing remotes..."
												: "Refresh remotes"
										}
									</button>
								`
								: ""
						}
					</div>
					${
						entries.length > 0
							? html`
								<div class="panel-grid" style="margin-bottom: 1rem;">
									${entries.map((entry) => {
										const entryKey = `${entry.scope}:${entry.sourceSpec}`;
										const filters = this.formatPackageFilters(entry.filters);
										const resourceSummary = entry.inspection?.resources
											? `${entry.inspection.resources.extensions.length} ext · ${entry.inspection.resources.skills.length} skills · ${entry.inspection.resources.prompts.length} prompts · ${entry.inspection.resources.themes.length} themes`
											: null;
										return html`
											<div class="panel-card">
												<div class="panel-card-header">
													<div>
														<div class="panel-card-title">
															${entry.inspection?.discovered?.name ?? entry.sourceSpec}
														</div>
														<div class="panel-card-copy">
															${this.formatScopeLabel(entry.scope)}
														</div>
													</div>
													<div
														style="display: flex; gap: 0.5rem; align-items: center;"
													>
														${
															this.canRefreshPackage(entry)
																? html`
																	<button
																		class="action-btn package-refresh-button"
																		@click=${() => void this.refreshPackage(entry)}
																		?disabled=${this.packageRefreshingKey === entryKey}
																	>
																		${
																			this.packageRefreshingKey === entryKey
																				? "Refreshing..."
																				: "Refresh"
																		}
																	</button>
																`
																: ""
														}
														<button
															class="action-btn"
															@click=${() => void this.removePackage(entry)}
															?disabled=${this.packageRemovingKey === entryKey}
														>
															${
																this.packageRemovingKey === entryKey
																	? "Removing..."
																	: "Remove"
															}
														</button>
													</div>
												</div>
												<div class="panel-card-copy">Source: ${entry.sourceSpec}</div>
												<div class="panel-card-copy">Config: ${entry.configPath}</div>
												${
													filters
														? html`<div class="panel-card-copy">Filters: ${filters}</div>`
														: ""
												}
												${
													entry.inspection
														? html`
															<div class="panel-card-copy">
																Resolved: ${entry.inspection.resolvedSource}
															</div>
															<div class="panel-card-copy">
																Path: ${entry.inspection.resolvedPath}
															</div>
															${
																resourceSummary
																	? html`<div class="panel-card-copy">
																			Resources: ${resourceSummary}
																		</div>`
																	: ""
															}
														`
														: ""
												}
												${
													entry.error
														? html`<div class="panel-feedback error">${entry.error}</div>`
														: ""
												}
												${
													(entry.issues?.length ?? 0) > 0
														? html`
															<div class="panel-feedback error">
																${entry.issues?.map(
																	(issue) => html`<div>${issue}</div>`,
																)}
															</div>
														`
														: ""
												}
											</div>
										`;
									})}
								</div>
							`
							: html`<div class="empty-state">No configured packages</div>`
					}
					<div class="section" style="margin: 1rem 0 0;">
						<div class="section-header">
							<h3>Browse Packages</h3>
						</div>
						<div class="section-content">
							<div class="panel-card-copy">
								Search npm for packages tagged with
								<code>maestro-package</code>.
							</div>
							<div class="control-row" style="margin-top: 0.75rem;">
								<input
									class="field-input"
									type="text"
									.placeholder=${"Search maestro packages"}
									.value=${this.packageSearchQuery}
									aria-label=${"Package search"}
									@input=${(event: Event) => {
										this.packageSearchQuery = (
											event.target as HTMLInputElement
										).value;
									}}
								/>
								<button
									class="action-btn package-search-button"
									@click=${() => void this.searchPackages(this.packageSearchQuery)}
									?disabled=${this.packageSearchLoading}
								>
									${this.packageSearchLoading ? "Searching..." : "Search"}
								</button>
							</div>
							${
								this.packageSearchError
									? html`<div class="panel-feedback error">
											${this.packageSearchError}
										</div>`
									: ""
							}
							${
								this.packageSearchResults.length > 0
									? html`
										<div class="panel-grid" style="margin-top: 0.75rem;">
											${this.packageSearchResults.map(
												(entry) => html`
													<div class="panel-card">
														<div class="panel-card-header">
															<div>
																<div class="panel-card-title">
																	${entry.name}
																</div>
																<div class="panel-card-copy">
																	${entry.version ?? "latest"}
																</div>
															</div>
															<div
																style="display: flex; gap: 0.5rem; align-items: center;"
															>
																<button
																	class="action-btn package-use-search-result-button"
																	@click=${() => {
																		this.packageSource = entry.installSource;
																	}}
																>
																	Use source
																</button>
																<button
																	class="action-btn package-add-search-result-button"
																	@click=${() => void this.addDiscoveredPackage(entry)}
																	?disabled=${this.packageSearchAddingSource === entry.installSource}
																>
																	${
																		this.packageSearchAddingSource ===
																		entry.installSource
																			? "Adding..."
																			: `Add to ${this.formatScopeLabel(this.packageScope)}`
																	}
																</button>
															</div>
														</div>
														${
															entry.description
																? html`<div class="panel-card-copy">
																		${entry.description}
																	</div>`
																: ""
														}
														<div class="panel-card-copy">
															Install source: ${entry.installSource}
														</div>
														${
															entry.keywords.length > 0
																? html`<div class="panel-card-copy">
																		Keywords: ${entry.keywords.join(", ")}
																	</div>`
																: ""
														}
													</div>
												`,
											)}
										</div>
									`
									: ""
							}
						</div>
					</div>
					<div class="section" style="margin: 1rem 0 0;">
						<div class="section-header">
							<h3>Add Package</h3>
						</div>
						<div class="section-content">
							<div class="panel-card-copy">
								Add a local path or git source to local, project, or user
								config.
							</div>
							<div class="control-row" style="margin-top: 0.75rem;">
								<input
									class="field-input"
									type="text"
									.placeholder=${"./packages/my-pack"}
									.value=${this.packageSource}
									aria-label=${"Package source"}
									@input=${(event: Event) => {
										this.packageSource = (
											event.target as HTMLInputElement
										).value;
									}}
								/>
								<select
									class="field-select"
									.value=${this.packageScope}
									aria-label=${"Package scope"}
									@change=${(event: Event) => {
										this.packageScope = (event.target as HTMLSelectElement)
											.value as PackageScope;
									}}
								>
									<option value="local">Local config</option>
									<option value="project">Project config</option>
									<option value="user">User config</option>
								</select>
							</div>
							<div class="control-row">
								<button
									class="action-btn package-inspect-button"
									@click=${() => void this.runPackagePreview("inspect")}
									?disabled=${this.packageAction !== null || this.packageSource.trim().length === 0}
								>
									${this.packageAction === "inspect" ? "Inspecting..." : "Inspect"}
								</button>
								<button
									class="action-btn package-validate-button"
									@click=${() => void this.runPackagePreview("validate")}
									?disabled=${this.packageAction !== null || this.packageSource.trim().length === 0}
								>
									${
										this.packageAction === "validate"
											? "Validating..."
											: "Validate"
									}
								</button>
								<button
									class="action-btn package-add-button"
									@click=${() => void this.addPackage()}
									?disabled=${this.packageAction !== null || this.packageSource.trim().length === 0}
								>
									${this.packageAction === "add" ? "Adding..." : "Add Package"}
								</button>
							</div>
							${
								this.packageError
									? html`<div class="panel-feedback error">${this.packageError}</div>`
									: ""
							}
							${
								this.packageNotice
									? html`<div class="panel-feedback success">${this.packageNotice}</div>`
									: ""
							}
							${
								this.packagePreview
									? html`
										<div class="panel-card" style="margin-top: 0.75rem;">
											<div class="panel-card-title">
												${
													this.packagePreview.kind === "inspect"
														? "Package Inspection"
														: "Package Validation"
												}
											</div>
											<div class="panel-card-copy">
												Source:
												${this.packagePreview.result.inspection.sourceSpec}
											</div>
											<div class="panel-card-copy">
												Resolved:
												${this.packagePreview.result.inspection.resolvedSource}
											</div>
											<div class="panel-card-copy">
												Path: ${this.packagePreview.result.inspection.resolvedPath}
											</div>
											${
												this.packagePreview.result.inspection.discovered
													? html`
														<div class="panel-card-copy">
															Name:
															${
																this.packagePreview.result.inspection.discovered
																	.name
															}
														</div>
														<div class="panel-card-copy">
															Maestro keyword:
															${
																this.packagePreview.result.inspection.discovered
																	.isMaestroPackage
																	? "yes"
																	: "no"
															}
														</div>
													`
													: html`<div class="panel-card-copy">
															No valid package.json found.
														</div>`
											}
											${
												this.packagePreview.result.issues.length > 0
													? html`
														<div class="panel-feedback error">
															${this.packagePreview.result.issues.map(
																(issue) => html`<div>${issue}</div>`,
															)}
														</div>
													`
													: this.packagePreview.kind === "validate"
														? html`<div class="panel-feedback success">
																Package validation passed.
															</div>`
														: ""
											}
										</div>
									`
									: ""
							}
						</div>
					</div>
				</div>
			</div>
		`;
	}
}
