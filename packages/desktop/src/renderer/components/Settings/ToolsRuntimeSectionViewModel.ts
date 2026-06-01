import {
	formatMcpArgsText,
	formatMcpConfigScopeLabel,
	formatMcpKeyValueText,
	formatMcpRegistryImportMessage,
	formatMcpRegistryScopeLabel,
	formatMcpServerAddMessage,
	formatMcpServerRemoveMessage,
	formatMcpServerUpdateMessage,
	formatMcpTimeoutText,
	formatMcpTransportLabel,
	formatMcpPromptOutput as formatSharedMcpPromptOutput,
	formatMcpResourceOutput as formatSharedMcpResourceOutput,
	getMcpRegistryEntryId,
	getMcpRegistryUrlOptions,
	getWritableMcpScope,
	parseMcpArgsText,
	parseMcpKeyValueText,
	parseMcpTimeoutText,
} from "@evalops/contracts";
import type {
	ComposerProfile,
	ComposerStatus,
	LspStatus,
	McpAuthPresetAddRequest,
	McpAuthPresetMutationResponse,
	McpAuthPresetRemoveRequest,
	McpAuthPresetRemoveResponse,
	McpAuthPresetStatus,
	McpAuthPresetUpdateRequest,
	McpOfficialRegistryEntry,
	McpProjectApprovalResponse,
	McpPromptDefinition,
	McpPromptResponse,
	McpRegistryImportRequest,
	McpRegistryImportResponse,
	McpRegistrySearchResponse,
	McpResourceReadResponse,
	McpServerAddRequest,
	McpServerMutationResponse,
	McpServerRemoveRequest,
	McpServerRemoveResponse,
	McpServerStatus,
	McpServerUpdateRequest,
	McpStatus,
	PackageAddResponse,
	PackageBulkRefreshResponse,
	PackageCachePruneResponse,
	PackageInspectResponse,
	PackageMutationRequest,
	PackageRemoveResponse,
	PackageScope,
	PackageSearchResponse,
	PackageStatusEntry,
	PackageStatusResponse,
} from "../../lib/api-client";

export type LspAction = "start" | "stop" | "restart";

export interface LspDetection {
	serverId: string;
	root: string;
}

export interface LspServerViewModel {
	id: string;
	summary: string;
}

export interface LspViewModel {
	enabledLabel: string;
	autostartLabel: string;
	serverCount: number;
	servers: LspServerViewModel[];
	detectionsLabel: string;
}

export interface McpServerViewModel {
	name: string;
	summary: string;
	isExpanded: boolean;
	connectionLabel: string;
	transport: McpServerStatus["transport"];
	writableScope: McpRegistryImportRequest["scope"] | null;
	sourceLabel: string | null;
	transportLabel: string | null;
	remoteTrustLabel: string | null;
	projectApproval: McpServerStatus["projectApproval"] | null;
	projectApprovalLabel: string | null;
	errorLabel: string | null;
	command: string | null;
	args: string[];
	cwd: string | null;
	envKeys: string[];
	remoteHost: string | null;
	remoteUrl: string | null;
	headerKeys: string[];
	headersHelper: string | null;
	authPreset: string | null;
	timeout: number | null;
	officialRegistryName: string | null;
	officialRegistryDirectoryUrl: string | null;
	officialRegistryDocumentationUrl: string | null;
	officialRegistryAuthor: string | null;
	officialRegistryPermissions: string | null;
	toolCount: number;
	tools: Array<{ name: string; description?: string }>;
	toolDetailsLabel: string | null;
	capabilitySummaryLabel: string | null;
	resources: string[];
	prompts: string[];
	promptDetails: McpPromptDefinition[];
}

export interface McpRegistryEntryViewModel {
	id: string;
	importQuery: string;
	title: string;
	description: string | null;
	summary: string | null;
	transportLabel: string | null;
	countsLabel: string | null;
	authorLabel: string | null;
	permissionsLabel: string | null;
	directoryUrl: string | null;
	documentationUrl: string | null;
	urlOptions: Array<{ url: string; label: string }>;
	defaultUrl: string | null;
}

export interface ComposerProfilesViewModel {
	options: ComposerProfile[];
	activeLabel: string;
	canActivate: boolean;
}

export interface ToolsRuntimeSectionProps {
	lspStatus: LspStatus | null;
	lspDetections: LspDetection[];
	onLspAction: (action: LspAction) => Promise<void> | void;
	onDetectLsp: () => Promise<void> | void;
	mcpStatus: McpStatus | null;
	packageStatus: PackageStatusResponse | null;
	expandedMcpServer: string | null;
	onToggleMcpServer: (name: string) => void;
	onRefreshMcpStatus: () => Promise<void> | void;
	onRefreshPackageStatus: () => Promise<void> | void;
	onSearchMcpRegistry: (query: string) => Promise<McpRegistrySearchResponse>;
	onImportMcpRegistry: (
		input: McpRegistryImportRequest,
	) => Promise<McpRegistryImportResponse>;
	onAddMcpServer: (
		input: McpServerAddRequest,
	) => Promise<McpServerMutationResponse>;
	onAddMcpAuthPreset: (
		input: McpAuthPresetAddRequest,
	) => Promise<McpAuthPresetMutationResponse>;
	onUpdateMcpServer: (
		input: McpServerUpdateRequest,
	) => Promise<McpServerMutationResponse>;
	onUpdateMcpAuthPreset: (
		input: McpAuthPresetUpdateRequest,
	) => Promise<McpAuthPresetMutationResponse>;
	onRemoveMcpServer: (
		input: McpServerRemoveRequest,
	) => Promise<McpServerRemoveResponse>;
	onSetMcpProjectApproval: (input: {
		name: string;
		decision: "approved" | "denied";
	}) => Promise<McpProjectApprovalResponse>;
	onRemoveMcpAuthPreset: (
		input: McpAuthPresetRemoveRequest,
	) => Promise<McpAuthPresetRemoveResponse>;
	onReadMcpResource: (
		server: string,
		uri: string,
	) => Promise<McpResourceReadResponse>;
	onGetMcpPrompt: (
		server: string,
		name: string,
		args?: Record<string, string>,
	) => Promise<McpPromptResponse>;
	onInspectPackage: (source: string) => Promise<PackageInspectResponse>;
	onPrunePackageCache: () => Promise<PackageCachePruneResponse>;
	onRefreshAllPackages: () => Promise<PackageBulkRefreshResponse>;
	onRefreshPackage: (source: string) => Promise<PackageInspectResponse>;
	onSearchPackages: (query: string) => Promise<PackageSearchResponse>;
	onValidatePackage: (source: string) => Promise<PackageInspectResponse>;
	onAddPackage: (input: PackageMutationRequest) => Promise<PackageAddResponse>;
	onRemovePackage: (
		input: PackageMutationRequest,
	) => Promise<PackageRemoveResponse>;
	composerStatus: ComposerStatus | null;
	selectedComposer: string;
	onSelectedComposerChange: (name: string) => void;
	onRefreshComposers: () => Promise<void> | void;
	onActivateComposer: () => Promise<void> | void;
	onDeactivateComposer: () => Promise<void> | void;
}

export function formatCountLabel(
	count: number,
	singular: string,
	plural: string,
): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

export function formatPackageFilters(
	filters: PackageStatusEntry["filters"],
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

export function formatPackageScopeLabel(scope: PackageScope): string {
	return formatMcpScopeLabel(scope) ?? scope;
}

export function formatMcpCapabilitySummaryLabel(
	summary: McpServerStatus["toolCapabilitySummary"],
): string | null {
	if (!summary) {
		return null;
	}
	const desktop = summary.byDomain?.desktop ?? 0;
	const file = summary.byDomain?.file ?? 0;
	const fileEdits = summary.byToolLane?.file_edit ?? 0;
	const desktopActions = summary.byToolLane?.desktop_action ?? 0;
	const highRisk = summary.byRiskClass?.high ?? 0;
	const receipts = summary.requiresReceipt ?? 0;
	const parts = [
		desktop > 0 ? `${desktop} desktop` : null,
		desktopActions > 0 ? `${desktopActions} desktop actions` : null,
		file > 0 ? `${file} file` : null,
		fileEdits > 0 ? `${fileEdits} file edits` : null,
		highRisk > 0 ? `${highRisk} high risk` : null,
		receipts > 0 ? `${receipts} receipt-backed` : null,
	].filter((part): part is string => Boolean(part));
	return parts.length > 0 ? `Capabilities: ${parts.join(" · ")}` : null;
}

export function formatPackagePreviewTitle(
	kind: "inspect" | "validate",
): string {
	return kind === "inspect" ? "Package inspection" : "Package validation";
}

export function formatPackageAddNotice(
	result: PackageAddResponse,
	source: string,
): string {
	return `Added configured package "${source}" to ${formatPackageScopeLabel(result.scope)}.`;
}

export function formatPackageRemoveNotice(
	result: PackageRemoveResponse,
	source: string,
): string {
	if (result.fallback) {
		return `Removed configured package "${source}" from ${formatPackageScopeLabel(result.scope)}. Still configured in ${formatPackageScopeLabel(result.fallback.scope)}.`;
	}
	return `Removed configured package "${source}" from ${formatPackageScopeLabel(result.scope)}.`;
}

export function canRefreshPackage(entry: PackageStatusEntry): boolean {
	return (
		entry.inspection?.sourceType === "git" ||
		entry.inspection?.sourceType === "npm"
	);
}

export function formatMcpErrorLabel(error: string | undefined): string | null {
	if (typeof error !== "string") {
		return null;
	}

	return error.trim() || "Connection failed.";
}

export function formatMcpTrustLabel(
	trust: McpServerStatus["remoteTrust"],
): string | null {
	switch (trust) {
		case "official":
			return "Official remote";
		case "custom":
			return "Custom remote";
		case "unknown":
			return "Unverified remote";
		default:
			return null;
	}
}

export function formatMcpProjectApprovalLabel(
	projectApproval: McpServerStatus["projectApproval"],
): string | null {
	switch (projectApproval) {
		case "pending":
			return "Pending approval";
		case "approved":
			return "Approved locally";
		case "denied":
			return "Denied locally";
		default:
			return null;
	}
}

export function formatMcpConnectionLabel(server: McpServerStatus): string {
	switch (server.projectApproval) {
		case "pending":
			return "Pending approval";
		case "denied":
			return "Denied";
		default:
			return server.connected ? "Connected" : "Offline";
	}
}

export function formatMcpResourceReadResult(
	result: McpResourceReadResponse,
): string {
	return formatSharedMcpResourceOutput(result);
}

export function formatMcpPromptResult(result: McpPromptResponse): string {
	return formatSharedMcpPromptOutput(result);
}

export function getMcpPromptArgumentValueKey(
	serverName: string,
	promptName: string,
	argumentName: string,
): string {
	return `${serverName}::${promptName}::${argumentName}`;
}

export {
	formatMcpArgsText,
	formatMcpKeyValueText,
	formatMcpRegistryImportMessage,
	formatMcpServerAddMessage,
	formatMcpServerRemoveMessage,
	formatMcpServerUpdateMessage,
	formatMcpTimeoutText,
	getMcpRegistryEntryId,
	parseMcpArgsText,
	parseMcpKeyValueText,
	parseMcpTimeoutText,
};

export const formatMcpScopeLabel = formatMcpConfigScopeLabel;

export function buildLspViewModel(
	status: LspStatus | null,
	detections: LspDetection[],
): LspViewModel {
	const servers = status?.servers ?? [];

	return {
		enabledLabel: status?.enabled ? "Yes" : "No",
		autostartLabel: status?.autostart ? "Yes" : "No",
		serverCount: servers.length,
		servers: servers.map((server) => ({
			id: server.id,
			summary: `${server.fileCount} files · ${server.diagnosticCount} diag`,
		})),
		detectionsLabel: detections
			.map((detection) => detection.serverId)
			.join(", "),
	};
}

export function buildMcpServerViewModel(
	server: McpServerStatus,
	expandedServer: string | null,
): McpServerViewModel {
	const tools = Array.isArray(server.tools) ? server.tools : [];
	const toolCount = Array.isArray(server.tools)
		? server.tools.length
		: (server.tools ?? 0);
	const resources = server.resources ?? [];
	const prompts = server.prompts ?? [];
	const sourceLabel = formatMcpScopeLabel(server.scope);
	const transportLabel = formatMcpTransportLabel(server.transport);
	const remoteTrustLabel = formatMcpTrustLabel(server.remoteTrust);
	const projectApprovalLabel = formatMcpProjectApprovalLabel(
		server.projectApproval,
	);
	const connectionLabel = formatMcpConnectionLabel(server);
	const summaryParts = [
		connectionLabel,
		sourceLabel,
		transportLabel ? `via ${transportLabel}` : null,
		formatCountLabel(toolCount, "tool", "tools"),
		formatCountLabel(resources.length, "resource", "resources"),
		formatCountLabel(prompts.length, "prompt", "prompts"),
	].filter((part): part is string => Boolean(part));

	return {
		name: server.name,
		summary: summaryParts.join(" · "),
		isExpanded: expandedServer === server.name,
		connectionLabel,
		transport: server.transport,
		writableScope: getWritableMcpScope(server.scope),
		sourceLabel,
		transportLabel,
		remoteTrustLabel,
		projectApproval: server.projectApproval ?? null,
		projectApprovalLabel,
		errorLabel:
			server.projectApproval === "pending" ||
			server.projectApproval === "denied"
				? null
				: formatMcpErrorLabel(server.error),
		command: server.command?.trim() || null,
		args: Array.isArray(server.args) ? server.args : [],
		cwd: server.cwd?.trim() || null,
		envKeys: Array.isArray(server.envKeys) ? server.envKeys : [],
		remoteHost: server.remoteHost?.trim() || null,
		remoteUrl: server.remoteUrl?.trim() || null,
		headerKeys: Array.isArray(server.headerKeys) ? server.headerKeys : [],
		headersHelper: server.headersHelper?.trim() || null,
		authPreset: server.authPreset?.trim() || null,
		timeout: typeof server.timeout === "number" ? server.timeout : null,
		officialRegistryName: server.officialRegistry?.displayName?.trim() || null,
		officialRegistryDirectoryUrl:
			server.officialRegistry?.directoryUrl?.trim() || null,
		officialRegistryDocumentationUrl:
			server.officialRegistry?.documentationUrl?.trim() || null,
		officialRegistryAuthor: server.officialRegistry?.authorName?.trim() || null,
		officialRegistryPermissions:
			server.officialRegistry?.permissions?.trim() || null,
		toolCount,
		tools,
		toolDetailsLabel:
			tools.length > 0
				? null
				: toolCount > 0
					? `${toolCount} tools reported (details unavailable).`
					: "No tools reported.",
		capabilitySummaryLabel: formatMcpCapabilitySummaryLabel(
			server.toolCapabilitySummary,
		),
		resources,
		prompts,
		promptDetails: server.promptDetails ?? [],
	};
}

export function buildMcpRegistryEntryViewModel(
	entry: McpOfficialRegistryEntry,
	fallbackIndex = 0,
): McpRegistryEntryViewModel {
	const transportLabel = formatMcpTransportLabel(entry.transport);
	const counts = [
		typeof entry.toolCount === "number"
			? formatCountLabel(entry.toolCount, "tool", "tools")
			: null,
		typeof entry.promptCount === "number"
			? formatCountLabel(entry.promptCount, "prompt", "prompts")
			: null,
	].filter((part): part is string => Boolean(part));
	const normalizedUrlOptions = getMcpRegistryUrlOptions(entry);
	const fallbackUrl = entry.url?.trim() || null;
	const importQuery =
		entry.slug?.trim() ||
		entry.serverName?.trim() ||
		entry.displayName?.trim() ||
		fallbackUrl ||
		`entry-${fallbackIndex}`;
	const title =
		entry.displayName?.trim() ||
		entry.serverName?.trim() ||
		entry.slug?.trim() ||
		fallbackUrl ||
		"Unnamed registry entry";
	const summaryParts = [
		transportLabel ? `via ${transportLabel}` : null,
		entry.authorName?.trim() ? `by ${entry.authorName.trim()}` : null,
		counts.length > 0 ? counts.join(" · ") : null,
	].filter((part): part is string => Boolean(part));

	return {
		id: getMcpRegistryEntryId(entry, fallbackIndex),
		importQuery,
		title,
		description: entry.oneLiner?.trim() || null,
		summary: summaryParts.length > 0 ? summaryParts.join(" · ") : null,
		transportLabel,
		countsLabel: counts.length > 0 ? counts.join(" · ") : null,
		authorLabel: entry.authorName?.trim() || null,
		permissionsLabel: entry.permissions?.trim() || null,
		directoryUrl: entry.directoryUrl?.trim() || null,
		documentationUrl: entry.documentationUrl?.trim() || null,
		urlOptions: normalizedUrlOptions,
		defaultUrl: normalizedUrlOptions[0]?.url ?? null,
	};
}

export function buildComposerProfilesViewModel(
	status: ComposerStatus | null,
	selectedComposer: string,
): ComposerProfilesViewModel {
	return {
		options: status?.composers ?? [],
		activeLabel: status?.active?.name ?? "none",
		canActivate: Boolean(selectedComposer),
	};
}

export function resolveComposerSelection(
	status: ComposerStatus | null,
	currentSelection: string,
): string {
	if (!status) {
		return currentSelection;
	}

	const activeName = status.active?.name;
	if (activeName) {
		return activeName;
	}

	if (!currentSelection && status.composers.length > 0) {
		return status.composers[0].name;
	}

	return currentSelection;
}
