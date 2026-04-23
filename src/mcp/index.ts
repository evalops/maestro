export {
	addMcpAuthPresetToConfig,
	addMcpServerToConfig,
	getConfigPaths,
	getWritableMcpConfigPath,
	inferRemoteMcpTransport,
	loadMcpConfig,
	removeMcpAuthPresetFromConfig,
	removeMcpServerFromConfig,
	updateMcpAuthPresetInConfig,
	updateMcpServerInConfig,
	type WritableMcpScope,
} from "./config.js";
export { mcpManager, McpClientManager } from "./manager.js";
export {
	createMcpToolWrapper,
	getAllMcpTools,
	getMcpToolMap,
} from "./tool-bridge.js";
export { buildMcpToolName, isMcpTool, parseMcpToolName } from "./names.js";
export {
	defaultEnvValidators,
	evaluateEnvValidators,
	type EnvValidator,
	type EnvValidatorResult,
} from "./env-limits.js";
export {
	getMcpRemoteHost,
	getOfficialMcpRegistryUrls,
	getOfficialMcpRegistryEntries,
	getOfficialMcpRegistryMatch,
	normalizeMcpRemoteUrl,
	officialMcpRegistryEntryMatchesUrl,
	prefetchOfficialMcpRegistry,
	resetOfficialMcpRegistryCacheForTesting,
	resolveOfficialMcpRegistryEntry,
	searchOfficialMcpRegistry,
	setOfficialMcpRegistryCacheForTesting,
	buildSuggestedMcpServerName,
} from "./official-registry.js";
export {
	buildProjectMcpServerFingerprint,
	getProjectMcpServerApprovalStatus,
	setProjectMcpServerApprovalDecision,
} from "./project-approvals.js";
export { getPlatformMcpPluginServers } from "./platform-plugin.js";
export type {
	McpAuthPresetConfig,
	McpAuthPresetStatus,
	McpConfig,
	McpOfficialRegistryEntry,
	McpOfficialRegistryInfo,
	McpOfficialRegistryUrlOption,
	McpProjectApprovalDecision,
	McpProjectApprovalStatus,
	McpServerConfig,
	McpServerStatus,
	McpManagerStatus,
	McpRemoteTrust,
	McpTransport,
	McpScope,
} from "./types.js";
export type { McpAuthPresetInput, McpServerInput } from "./schema.js";
