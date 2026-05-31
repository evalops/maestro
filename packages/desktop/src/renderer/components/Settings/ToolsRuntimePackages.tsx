import { type FormEvent, useState } from "react";
import type {
	PackageInspectResponse,
	PackageScope,
	PackageSearchResponse,
	PackageStatusEntry,
} from "../../lib/api-client";
import {
	canRefreshPackage,
	formatPackageAddNotice,
	formatPackageFilters,
	formatPackagePreviewTitle,
	formatPackageRemoveNotice,
	formatPackageScopeLabel,
} from "./ToolsRuntimeSectionViewModel";
import type { ToolsRuntimeSectionProps } from "./ToolsRuntimeSectionViewModel";

type ToolsRuntimePackagesProps = Pick<
	ToolsRuntimeSectionProps,
	| "onRefreshPackageStatus"
	| "onInspectPackage"
	| "onPrunePackageCache"
	| "onRefreshAllPackages"
	| "onRefreshPackage"
	| "onSearchPackages"
	| "onValidatePackage"
	| "onAddPackage"
	| "onRemovePackage"
> & {
	packages: PackageStatusEntry[];
};

export function ToolsRuntimePackages({
	packages,
	onRefreshPackageStatus,
	onInspectPackage,
	onPrunePackageCache,
	onRefreshAllPackages,
	onRefreshPackage,
	onSearchPackages,
	onValidatePackage,
	onAddPackage,
	onRemovePackage,
}: ToolsRuntimePackagesProps) {
	const [packageSource, setPackageSource] = useState("");
	const [packageScope, setPackageScope] = useState<PackageScope>("local");
	const [packageAction, setPackageAction] = useState<
		"inspect" | "validate" | "add" | null
	>(null);
	const [removingPackageKey, setRemovingPackageKey] = useState<string | null>(
		null,
	);
	const [refreshingPackageKey, setRefreshingPackageKey] = useState<
		string | null
	>(null);
	const [refreshingAllPackages, setRefreshingAllPackages] = useState(false);
	const [pruningPackageCache, setPruningPackageCache] = useState(false);
	const [packageNotice, setPackageNotice] = useState<string | null>(null);
	const [packageError, setPackageError] = useState<string | null>(null);
	const [packageSearchQuery, setPackageSearchQuery] = useState("");
	const [packageSearchLoading, setPackageSearchLoading] = useState(false);
	const [packageSearchError, setPackageSearchError] = useState<string | null>(
		null,
	);
	const [packageSearchResults, setPackageSearchResults] = useState<
		PackageSearchResponse["entries"]
	>([]);
	const [packageSearchAddingSource, setPackageSearchAddingSource] = useState<
		string | null
	>(null);
	const [packagePreview, setPackagePreview] = useState<{
		kind: "inspect" | "validate";
		result: PackageInspectResponse;
	} | null>(null);

	const handlePackagePreview = async (kind: "inspect" | "validate") => {
		const source = packageSource.trim();
		if (!source) {
			setPackageError("Package source is required.");
			setPackageNotice(null);
			setPackagePreview(null);
			return;
		}

		setPackageAction(kind);
		setPackageError(null);
		setPackageNotice(null);
		setPackagePreview(null);
		try {
			const result =
				kind === "inspect"
					? await onInspectPackage(source)
					: await onValidatePackage(source);
			setPackagePreview({ kind, result });
		} catch (error) {
			setPackageError(
				error instanceof Error ? error.message : "Failed to inspect package",
			);
		} finally {
			setPackageAction((current) => (current === kind ? null : current));
		}
	};

	const handlePackageSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const source = packageSource.trim();
		if (!source) {
			setPackageError("Package source is required.");
			setPackageNotice(null);
			return;
		}

		setPackageAction("add");
		setPackageError(null);
		setPackageNotice(null);
		try {
			const result = await onAddPackage({ source, scope: packageScope });
			setPackageNotice(formatPackageAddNotice(result, source));
			setPackagePreview(null);
			setPackageSource("");
		} catch (error) {
			setPackageError(
				error instanceof Error ? error.message : "Failed to add package",
			);
		} finally {
			setPackageAction((current) => (current === "add" ? null : current));
		}
	};

	const handlePackageSearch = async () => {
		setPackageSearchLoading(true);
		setPackageSearchError(null);
		try {
			const result = await onSearchPackages(packageSearchQuery);
			setPackageSearchResults(result.entries ?? []);
		} catch (error) {
			setPackageSearchResults([]);
			setPackageSearchError(
				error instanceof Error
					? error.message
					: "Failed to search package registry",
			);
		} finally {
			setPackageSearchLoading(false);
		}
	};

	const handleAddDiscoveredPackage = async (
		entry: PackageSearchResponse["entries"][number],
	) => {
		setPackageSearchAddingSource(entry.installSource);
		setPackageError(null);
		setPackageNotice(null);
		try {
			const result = await onAddPackage({
				source: entry.installSource,
				scope: packageScope,
			});
			setPackageNotice(formatPackageAddNotice(result, entry.installSource));
			setPackagePreview(null);
			setPackageSource(entry.installSource);
		} catch (error) {
			setPackageError(
				error instanceof Error ? error.message : "Failed to add package",
			);
		} finally {
			setPackageSearchAddingSource((current) =>
				current === entry.installSource ? null : current,
			);
		}
	};

	const handleRemovePackage = async (entry: PackageStatusEntry) => {
		const key = `${entry.scope}:${entry.sourceSpec}`;
		setRemovingPackageKey(key);
		setPackageError(null);
		setPackageNotice(null);
		try {
			const result = await onRemovePackage({
				source: entry.sourceSpec,
				scope: entry.scope,
			});
			setPackageNotice(formatPackageRemoveNotice(result, entry.sourceSpec));
		} catch (error) {
			setPackageError(
				error instanceof Error ? error.message : "Failed to remove package",
			);
		} finally {
			setRemovingPackageKey((current) => (current === key ? null : current));
		}
	};

	const handleRefreshPackage = async (entry: PackageStatusEntry) => {
		const key = `${entry.scope}:${entry.sourceSpec}`;
		setRefreshingPackageKey(key);
		setPackageError(null);
		setPackageNotice(null);
		try {
			const result = await onRefreshPackage(entry.sourceSpec);
			setPackagePreview({ kind: "inspect", result });
			setPackageNotice(
				`Refreshed configured package "${entry.sourceSpec}" from ${formatPackageScopeLabel(entry.scope)}.`,
			);
		} catch (error) {
			setPackageError(
				error instanceof Error ? error.message : "Failed to refresh package",
			);
		} finally {
			setRefreshingPackageKey((current) => (current === key ? null : current));
		}
	};

	const handleRefreshAllPackages = async () => {
		setRefreshingAllPackages(true);
		setPackageError(null);
		setPackageNotice(null);
		try {
			const result = await onRefreshAllPackages();
			const failureCount = result.refreshed.filter(
				(entry) => entry.error,
			).length;
			setPackagePreview(null);
			setPackageNotice(
				failureCount > 0
					? `Refreshed ${result.remoteCount - failureCount} configured remote packages. ${failureCount} failed.`
					: `Refreshed ${result.remoteCount} configured remote packages.`,
			);
		} catch (error) {
			setPackageError(
				error instanceof Error
					? error.message
					: "Failed to refresh configured packages",
			);
		} finally {
			setRefreshingAllPackages(false);
		}
	};

	const handlePrunePackageCache = async () => {
		setPruningPackageCache(true);
		setPackageError(null);
		setPackageNotice(null);
		try {
			const result = await onPrunePackageCache();
			setPackagePreview(null);
			setPackageNotice(
				result.removedCount > 0
					? `Pruned ${result.removedCount} unconfigured remote package caches.`
					: "No unconfigured remote package caches found.",
			);
		} catch (error) {
			setPackageError(
				error instanceof Error
					? error.message
					: "Failed to prune package cache",
			);
		} finally {
			setPruningPackageCache(false);
		}
	};

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between gap-4">
				<div>
					<div className="text-text-primary font-medium">Packages</div>
					<div className="text-xs text-text-muted">Slash command: /package</div>
				</div>
				<div className="flex items-center gap-2">
					<button
						type="button"
						className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
						onClick={onRefreshPackageStatus}
					>
						Refresh
					</button>
					<button
						type="button"
						className="package-prune-cache-button px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-60"
						onClick={() => void handlePrunePackageCache()}
						disabled={pruningPackageCache}
					>
						{pruningPackageCache ? "Pruning cache..." : "Prune cache"}
					</button>
					{packages.some((entry) => canRefreshPackage(entry)) && (
						<button
							type="button"
							className="package-refresh-all-button px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-60"
							onClick={() => void handleRefreshAllPackages()}
							disabled={refreshingAllPackages}
						>
							{refreshingAllPackages
								? "Refreshing remotes..."
								: "Refresh remotes"}
						</button>
					)}
				</div>
			</div>
			{packages.length ? (
				<div className="grid grid-cols-1 gap-2">
					{packages.map((entry) => {
						const entryKey = `${entry.scope}:${entry.sourceSpec}`;
						const filters = formatPackageFilters(entry.filters);
						const resourceSummary = entry.inspection?.resources
							? `${entry.inspection.resources.extensions.length} ext · ${entry.inspection.resources.skills.length} skills · ${entry.inspection.resources.prompts.length} prompts · ${entry.inspection.resources.themes.length} themes`
							: null;
						return (
							<div
								key={entryKey}
								className="rounded-lg border border-line-subtle/60 bg-bg-tertiary/30 p-3 space-y-2 text-[11px] text-text-muted"
							>
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0 space-y-1">
										<div className="text-text-primary font-medium">
											{entry.inspection?.discovered?.name ?? entry.sourceSpec}
										</div>
										<div>{formatPackageScopeLabel(entry.scope)}</div>
									</div>
									<div className="flex items-center gap-2">
										{canRefreshPackage(entry) && (
											<button
												type="button"
												className="package-refresh-button px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-secondary/60 disabled:opacity-60"
												onClick={() => void handleRefreshPackage(entry)}
												disabled={refreshingPackageKey === entryKey}
											>
												{refreshingPackageKey === entryKey
													? "Refreshing..."
													: "Refresh"}
											</button>
										)}
										<button
											type="button"
											className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-secondary/60 disabled:opacity-60"
											onClick={() => void handleRemovePackage(entry)}
											disabled={removingPackageKey === entryKey}
										>
											{removingPackageKey === entryKey
												? "Removing..."
												: "Remove"}
										</button>
									</div>
								</div>
								<div className="break-all">Source: {entry.sourceSpec}</div>
								<div className="break-all">Config: {entry.configPath}</div>
								{filters && <div>Filters: {filters}</div>}
								{entry.inspection && (
									<>
										<div className="break-all">
											Resolved: {entry.inspection.resolvedSource}
										</div>
										<div className="break-all">
											Path: {entry.inspection.resolvedPath}
										</div>
										{resourceSummary && <div>Resources: {resourceSummary}</div>}
									</>
								)}
								{entry.error && (
									<div className="rounded-lg border border-error/40 bg-error/10 px-2.5 py-2 text-error">
										{entry.error}
									</div>
								)}
								{(entry.issues?.length ?? 0) > 0 && (
									<div className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-warning">
										{entry.issues?.map((issue) => (
											<div key={issue}>{issue}</div>
										))}
									</div>
								)}
							</div>
						);
					})}
				</div>
			) : (
				<div className="text-xs text-text-muted">No configured packages.</div>
			)}
			<div className="rounded-lg border border-line-subtle/60 bg-bg-secondary/30 p-3 space-y-3">
				<div>
					<div className="text-text-primary font-medium">Browse packages</div>
					<div className="text-xs text-text-muted">
						Search npm for packages tagged with maestro-package.
					</div>
				</div>
				<div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-2">
					<input
						type="text"
						value={packageSearchQuery}
						onChange={(event) => setPackageSearchQuery(event.target.value)}
						placeholder="Search maestro packages"
						aria-label="Package search"
						className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
					/>
					<button
						type="button"
						className="package-search-button px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-60"
						onClick={() => void handlePackageSearch()}
						disabled={packageSearchLoading}
					>
						{packageSearchLoading ? "Searching..." : "Search"}
					</button>
				</div>
				{packageSearchError && (
					<div className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">
						{packageSearchError}
					</div>
				)}
				{packageSearchResults.length > 0 && (
					<div className="grid grid-cols-1 gap-2">
						{packageSearchResults.map((entry) => (
							<div
								key={entry.installSource}
								className="rounded-lg border border-line-subtle/60 bg-bg-tertiary/30 p-3 space-y-2 text-[11px] text-text-muted"
							>
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0 space-y-1">
										<div className="text-text-primary font-medium">
											{entry.name}
										</div>
										<div>{entry.version ?? "latest"}</div>
									</div>
									<div className="flex items-center gap-2">
										<button
											type="button"
											className="package-use-search-result-button px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-secondary/60"
											onClick={() => setPackageSource(entry.installSource)}
										>
											Use source
										</button>
										<button
											type="button"
											className="package-add-search-result-button px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-secondary/60 disabled:opacity-60"
											onClick={() => void handleAddDiscoveredPackage(entry)}
											disabled={
												packageSearchAddingSource === entry.installSource
											}
										>
											{packageSearchAddingSource === entry.installSource
												? "Adding..."
												: `Add to ${formatPackageScopeLabel(packageScope)}`}
										</button>
									</div>
								</div>
								{entry.description && <div>{entry.description}</div>}
								<div className="break-all">
									Install source: {entry.installSource}
								</div>
								{entry.keywords.length > 0 && (
									<div>Keywords: {entry.keywords.join(", ")}</div>
								)}
							</div>
						))}
					</div>
				)}
			</div>
			<div className="rounded-lg border border-line-subtle/60 bg-bg-secondary/30 p-3 space-y-3">
				<div>
					<div className="text-text-primary font-medium">Add package</div>
					<div className="text-xs text-text-muted">
						Add a local path or git source to local, project, or user config.
					</div>
				</div>
				<form
					className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-2"
					onSubmit={(event) => void handlePackageSubmit(event)}
				>
					<input
						type="text"
						value={packageSource}
						onChange={(event) => setPackageSource(event.target.value)}
						placeholder="./packages/my-pack"
						aria-label="Package source"
						className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted"
					/>
					<select
						value={packageScope}
						onChange={(event) =>
							setPackageScope(event.target.value as PackageScope)
						}
						aria-label="Package scope"
						className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
					>
						<option value="local">Local config</option>
						<option value="project">Project config</option>
						<option value="user">User config</option>
					</select>
					<button
						type="button"
						className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-60"
						onClick={() => void handlePackagePreview("inspect")}
						disabled={
							packageAction !== null || packageSource.trim().length === 0
						}
					>
						{packageAction === "inspect" ? "Inspecting..." : "Inspect"}
					</button>
					<button
						type="button"
						className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-60"
						onClick={() => void handlePackagePreview("validate")}
						disabled={
							packageAction !== null || packageSource.trim().length === 0
						}
					>
						{packageAction === "validate" ? "Validating..." : "Validate"}
					</button>
					<button
						type="submit"
						className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-60"
						disabled={
							packageAction !== null || packageSource.trim().length === 0
						}
					>
						{packageAction === "add" ? "Adding..." : "Add package"}
					</button>
				</form>
				{packageError && (
					<div className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">
						{packageError}
					</div>
				)}
				{packageNotice && (
					<div className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
						{packageNotice}
					</div>
				)}
				{packagePreview && (
					<div className="rounded-lg border border-line-subtle/60 bg-bg-tertiary/30 p-3 space-y-2 text-[11px] text-text-muted">
						<div className="text-text-primary font-medium">
							{formatPackagePreviewTitle(packagePreview.kind)}
						</div>
						<div>Source: {packagePreview.result.inspection.sourceSpec}</div>
						<div>
							Resolved: {packagePreview.result.inspection.resolvedSource}
						</div>
						<div>Path: {packagePreview.result.inspection.resolvedPath}</div>
						{packagePreview.result.inspection.discovered ? (
							<>
								<div>
									Name: {packagePreview.result.inspection.discovered.name}
								</div>
								<div>
									Maestro keyword:{" "}
									{packagePreview.result.inspection.discovered.isMaestroPackage
										? "yes"
										: "no"}
								</div>
							</>
						) : (
							<div>No valid package.json found.</div>
						)}
						{packagePreview.result.issues.length > 0 ? (
							<div className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-warning">
								{packagePreview.result.issues.map((issue) => (
									<div key={issue}>{issue}</div>
								))}
							</div>
						) : packagePreview.kind === "validate" ? (
							<div className="rounded-lg border border-success/30 bg-success/10 px-2.5 py-2 text-success">
								Package validation passed.
							</div>
						) : null}
					</div>
				)}
			</div>
		</div>
	);
}
