import { type Static, Type } from "@sinclair/typebox";
import { stringLiteralUnion } from "./typebox-utils.js";

export const maestroAppServerProtocolVersion = "maestro-app-server.v2" as const;
export const maestroAppServerSupportedProtocolVersions = [
	"maestro-app-server.v1",
	maestroAppServerProtocolVersion,
] as const;

export const maestroAppServerClientMethods = [
	"initialize",
	"model/list",
	"modelProvider/capabilities/read",
	"policy/read",
	"policy/check",
	"requirements/list",
	"network/fetch",
	"network/audit/list",
	"sandbox/probe",
	"sandbox/proof/run",
	"externalAgent/import",
	"pluginBundle/list",
	"pluginBundle/install",
	"pluginBundle/remove",
	"daemon/status",
	"remoteControl/status",
	"remoteControl/lease/read",
	"remoteControl/lease/heartbeat",
	"remoteControl/drain",
	"command/exec",
	"command/exec/write",
	"command/exec/terminate",
	"fs/readFile",
	"fs/writeFile",
	"fs/readDirectory",
	"fs/getMetadata",
	"fs/createDirectory",
	"fs/remove",
	"fs/copy",
	"fs/watch",
	"fs/unwatch",
	"thread/list",
	"thread/read",
	"thread/metadata/update",
	"thread/name/set",
	"thread/goal/get",
	"thread/goal/set",
	"thread/goal/clear",
	"thread/start",
	"thread/fork",
	"thread/archive",
	"thread/unarchive",
	"thread/delete",
	"thread/turns/list",
] as const;
export type MaestroAppServerClientMethod =
	(typeof maestroAppServerClientMethods)[number];

export const maestroAppServerServerMethods = ["fs/changed"] as const;
export type MaestroAppServerServerMethod =
	(typeof maestroAppServerServerMethods)[number];

export const maestroAppServerThreadStatuses = [
	"notLoaded",
	"loaded",
	"running",
	"interrupted",
	"completed",
	"archived",
] as const;
export type MaestroAppServerThreadStatus =
	(typeof maestroAppServerThreadStatuses)[number];

export const maestroAppServerTurnStatuses = [
	"completed",
	"running",
	"interrupted",
	"failed",
] as const;
export type MaestroAppServerTurnStatus =
	(typeof maestroAppServerTurnStatuses)[number];

export const MaestroAppServerJsonRpcIdSchema = Type.Union([
	Type.String(),
	Type.Number(),
]);
const MaestroAppServerJsonRpcResponseIdSchema = Type.Union([
	MaestroAppServerJsonRpcIdSchema,
	Type.Null(),
]);

export const MaestroAppServerClientRequestSchema = Type.Object({
	jsonrpc: Type.Literal("2.0"),
	id: MaestroAppServerJsonRpcIdSchema,
	method: Type.String(),
	params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type MaestroAppServerClientRequest = Static<
	typeof MaestroAppServerClientRequestSchema
>;

export const MaestroAppServerCapabilitiesSchema = Type.Object({
	sessions: Type.Boolean(),
	modelList: Type.Boolean(),
	modelProviderCapabilities: Type.Boolean(),
	managedPolicy: Type.Boolean(),
	requirements: Type.Boolean(),
	networkProxy: Type.Boolean(),
	networkAudit: Type.Boolean(),
	sandboxProbe: Type.Boolean(),
	sandboxProof: Type.Boolean(),
	externalAgentImport: Type.Boolean(),
	pluginBundles: Type.Boolean(),
	daemonStatus: Type.Boolean(),
	remoteControlStatus: Type.Boolean(),
	remoteControlLease: Type.Boolean(),
	remoteControlDrain: Type.Boolean(),
	commandExec: Type.Boolean(),
	commandProcessControl: Type.Boolean(),
	filesystem: Type.Boolean(),
	filesystemWatch: Type.Boolean(),
	threadList: Type.Boolean(),
	threadRead: Type.Boolean(),
	threadMetadataUpdate: Type.Boolean(),
	threadNameSet: Type.Boolean(),
	threadGoals: Type.Boolean(),
	threadStart: Type.Boolean(),
	threadFork: Type.Boolean(),
	threadArchive: Type.Boolean(),
	threadDelete: Type.Boolean(),
	turnsList: Type.Boolean(),
});
export type MaestroAppServerCapabilities = Static<
	typeof MaestroAppServerCapabilitiesSchema
>;

export const MaestroAppServerInitializeResultSchema = Type.Object({
	protocolVersion: Type.Literal(maestroAppServerProtocolVersion),
	supportedProtocolVersions: Type.Optional(
		Type.Array(stringLiteralUnion(maestroAppServerSupportedProtocolVersions)),
	),
	serverInfo: Type.Object({
		name: Type.String(),
		version: Type.Optional(Type.String()),
	}),
	capabilities: MaestroAppServerCapabilitiesSchema,
});
export type MaestroAppServerInitializeResult = Static<
	typeof MaestroAppServerInitializeResultSchema
>;

export const MaestroAppServerThreadStatusSchema = stringLiteralUnion(
	maestroAppServerThreadStatuses,
);
export const MaestroAppServerTurnStatusSchema = stringLiteralUnion(
	maestroAppServerTurnStatuses,
);

export const MaestroAppServerThreadSummarySchema = Type.Object({
	id: Type.String(),
	source: Type.Literal("session"),
	status: MaestroAppServerThreadStatusSchema,
	title: Type.Optional(Type.String()),
	summary: Type.Optional(Type.String()),
	resumeSummary: Type.Optional(Type.String()),
	memoryExtractionHash: Type.Optional(Type.String()),
	subject: Type.Optional(Type.String()),
	path: Type.Optional(Type.String()),
	createdAt: Type.String(),
	updatedAt: Type.String(),
	messageCount: Type.Number(),
	favorite: Type.Boolean(),
	tags: Type.Optional(Type.Array(Type.String())),
	archived: Type.Optional(Type.Boolean()),
	archivedAt: Type.Optional(Type.String()),
});
export type MaestroAppServerThreadSummary = Static<
	typeof MaestroAppServerThreadSummarySchema
>;

export const MaestroAppServerThreadGoalStatuses = [
	"active",
	"complete",
	"cancelled",
] as const;
export const MaestroAppServerThreadGoalStatusSchema = stringLiteralUnion(
	MaestroAppServerThreadGoalStatuses,
);
export const MaestroAppServerThreadGoalSchema = Type.Object({
	objective: Type.String(),
	status: MaestroAppServerThreadGoalStatusSchema,
	tokenBudget: Type.Optional(Type.Number()),
	createdAt: Type.String(),
	updatedAt: Type.String(),
});
export type MaestroAppServerThreadGoal = Static<
	typeof MaestroAppServerThreadGoalSchema
>;

export const MaestroAppServerThreadItemSchema = Type.Object({
	id: Type.String(),
	type: Type.String(),
	timestamp: Type.Optional(Type.String()),
	parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	role: Type.Optional(Type.String()),
	content: Type.Optional(Type.Unknown()),
	data: Type.Optional(Type.Unknown()),
});
export type MaestroAppServerThreadItem = Static<
	typeof MaestroAppServerThreadItemSchema
>;

export const MaestroAppServerCompactionSpanSchema = Type.Object({
	id: Type.String(),
	firstKeptEntryId: Type.String(),
	summary: Type.String(),
	tokensBefore: Type.Number(),
	sourceEntryIds: Type.Array(Type.String()),
});
export type MaestroAppServerCompactionSpan = Static<
	typeof MaestroAppServerCompactionSpanSchema
>;

export const MaestroAppServerThreadGraphSchema = Type.Object({
	branchId: Type.String(),
	leafEntryId: Type.Optional(Type.String()),
	activeEntryIds: Type.Array(Type.String()),
	compactionSpans: Type.Array(MaestroAppServerCompactionSpanSchema),
});
export type MaestroAppServerThreadGraph = Static<
	typeof MaestroAppServerThreadGraphSchema
>;

export const MaestroAppServerTurnSchema = Type.Object({
	id: Type.String(),
	parentTurnId: Type.Optional(Type.String()),
	status: MaestroAppServerTurnStatusSchema,
	startedAt: Type.Optional(Type.String()),
	completedAt: Type.Optional(Type.String()),
	sourceEntryIds: Type.Optional(Type.Array(Type.String())),
	toolCallIds: Type.Optional(Type.Array(Type.String())),
	items: Type.Array(MaestroAppServerThreadItemSchema),
});
export type MaestroAppServerTurn = Static<typeof MaestroAppServerTurnSchema>;

export const MaestroAppServerThreadSchema = Type.Intersect([
	MaestroAppServerThreadSummarySchema,
	Type.Object({
		messagesView: Type.Union([
			Type.Literal("full"),
			Type.Literal("summary"),
			Type.Literal("notLoaded"),
		]),
		turns: Type.Optional(Type.Array(MaestroAppServerTurnSchema)),
		graph: Type.Optional(MaestroAppServerThreadGraphSchema),
	}),
]);
export type MaestroAppServerThread = Static<
	typeof MaestroAppServerThreadSchema
>;

export const MaestroAppServerThreadListResultSchema = Type.Object({
	threads: Type.Array(MaestroAppServerThreadSummarySchema),
	nextCursor: Type.Union([Type.String(), Type.Null()]),
});
export type MaestroAppServerThreadListResult = Static<
	typeof MaestroAppServerThreadListResultSchema
>;

export const MaestroAppServerThreadReadResultSchema = Type.Object({
	thread: MaestroAppServerThreadSchema,
});
export type MaestroAppServerThreadReadResult = Static<
	typeof MaestroAppServerThreadReadResultSchema
>;

export const MaestroAppServerThreadMetadataUpdateResultSchema = Type.Object({
	thread: MaestroAppServerThreadSummarySchema,
});
export type MaestroAppServerThreadMetadataUpdateResult = Static<
	typeof MaestroAppServerThreadMetadataUpdateResultSchema
>;

export const MaestroAppServerThreadGoalResultSchema = Type.Object({
	threadId: Type.String(),
	goal: Type.Union([MaestroAppServerThreadGoalSchema, Type.Null()]),
});
export type MaestroAppServerThreadGoalResult = Static<
	typeof MaestroAppServerThreadGoalResultSchema
>;

export const MaestroAppServerTurnsListResultSchema = Type.Object({
	threadId: Type.String(),
	turns: Type.Array(MaestroAppServerTurnSchema),
	nextCursor: Type.Union([Type.String(), Type.Null()]),
	graph: Type.Optional(MaestroAppServerThreadGraphSchema),
});
export type MaestroAppServerTurnsListResult = Static<
	typeof MaestroAppServerTurnsListResultSchema
>;

export const MaestroAppServerAllowedBlockedPolicySchema = Type.Object({
	allowed: Type.Optional(Type.Array(Type.String())),
	blocked: Type.Optional(Type.Array(Type.String())),
});
export type MaestroAppServerAllowedBlockedPolicy = Static<
	typeof MaestroAppServerAllowedBlockedPolicySchema
>;

export const MaestroAppServerPolicySkillsSchema = Type.Object({
	required: Type.Optional(Type.Array(Type.String())),
});
export type MaestroAppServerPolicySkills = Static<
	typeof MaestroAppServerPolicySkillsSchema
>;

export const MaestroAppServerPolicyNetworkSchema = Type.Object({
	allowedHosts: Type.Optional(Type.Array(Type.String())),
	blockedHosts: Type.Optional(Type.Array(Type.String())),
	blockLocalhost: Type.Optional(Type.Boolean()),
	blockPrivateIPs: Type.Optional(Type.Boolean()),
});
export type MaestroAppServerPolicyNetwork = Static<
	typeof MaestroAppServerPolicyNetworkSchema
>;

export const MaestroAppServerPolicyLimitsSchema = Type.Object({
	maxTokensPerSession: Type.Optional(Type.Number()),
	maxSessionDurationMinutes: Type.Optional(Type.Number()),
	maxConcurrentSessions: Type.Optional(Type.Number()),
});
export type MaestroAppServerPolicyLimits = Static<
	typeof MaestroAppServerPolicyLimitsSchema
>;

export const MaestroAppServerPolicySchema = Type.Object({
	orgId: Type.Optional(Type.String()),
	tools: Type.Optional(MaestroAppServerAllowedBlockedPolicySchema),
	dependencies: Type.Optional(MaestroAppServerAllowedBlockedPolicySchema),
	models: Type.Optional(MaestroAppServerAllowedBlockedPolicySchema),
	skills: Type.Optional(MaestroAppServerPolicySkillsSchema),
	paths: Type.Optional(MaestroAppServerAllowedBlockedPolicySchema),
	network: Type.Optional(MaestroAppServerPolicyNetworkSchema),
	limits: Type.Optional(MaestroAppServerPolicyLimitsSchema),
});
export type MaestroAppServerPolicy = Static<
	typeof MaestroAppServerPolicySchema
>;

export const MaestroAppServerPolicyReadResultSchema = Type.Object({
	loaded: Type.Boolean(),
	policy: Type.Union([MaestroAppServerPolicySchema, Type.Null()]),
});
export type MaestroAppServerPolicyReadResult = Static<
	typeof MaestroAppServerPolicyReadResultSchema
>;

export const maestroAppServerPolicyCheckKinds = [
	"action",
	"model",
	"session",
] as const;
export const MaestroAppServerPolicyCheckKindSchema = stringLiteralUnion(
	maestroAppServerPolicyCheckKinds,
);
export type MaestroAppServerPolicyCheckKind =
	(typeof maestroAppServerPolicyCheckKinds)[number];

export const MaestroAppServerPolicyCheckItemSchema = Type.Object({
	kind: MaestroAppServerPolicyCheckKindSchema,
	allowed: Type.Boolean(),
	reason: Type.Optional(Type.String()),
});
export type MaestroAppServerPolicyCheckItem = Static<
	typeof MaestroAppServerPolicyCheckItemSchema
>;

export const MaestroAppServerPolicyCheckResultSchema = Type.Object({
	allowed: Type.Boolean(),
	reason: Type.Optional(Type.String()),
	checks: Type.Array(MaestroAppServerPolicyCheckItemSchema),
});
export type MaestroAppServerPolicyCheckResult = Static<
	typeof MaestroAppServerPolicyCheckResultSchema
>;

export const MaestroAppServerRequirementSchema = Type.Object({
	kind: Type.Literal("skill"),
	id: Type.String(),
	required: Type.Boolean(),
});
export type MaestroAppServerRequirement = Static<
	typeof MaestroAppServerRequirementSchema
>;

export const MaestroAppServerRequirementsListResultSchema = Type.Object({
	requirements: Type.Array(MaestroAppServerRequirementSchema),
	requiredSkills: Type.Array(Type.String()),
});
export type MaestroAppServerRequirementsListResult = Static<
	typeof MaestroAppServerRequirementsListResultSchema
>;

export const maestroAppServerNetworkGovernanceStatuses = [
	"allowed",
	"blocked",
	"failed",
] as const;
export const MaestroAppServerNetworkGovernanceStatusSchema = stringLiteralUnion(
	maestroAppServerNetworkGovernanceStatuses,
);
export type MaestroAppServerNetworkGovernanceStatus =
	(typeof maestroAppServerNetworkGovernanceStatuses)[number];

export const MaestroAppServerNetworkAuditRecordSchema = Type.Object({
	id: Type.String(),
	method: Type.String(),
	url: Type.String(),
	host: Type.String(),
	allowed: Type.Boolean(),
	status: MaestroAppServerNetworkGovernanceStatusSchema,
	reason: Type.Optional(Type.String()),
	statusCode: Type.Optional(Type.Number()),
	startedAt: Type.String(),
	completedAt: Type.String(),
});
export type MaestroAppServerNetworkAuditRecord = Static<
	typeof MaestroAppServerNetworkAuditRecordSchema
>;

export const MaestroAppServerNetworkFetchResultSchema = Type.Object({
	allowed: Type.Boolean(),
	status: MaestroAppServerNetworkGovernanceStatusSchema,
	reason: Type.Optional(Type.String()),
	statusCode: Type.Optional(Type.Number()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	bodyBase64: Type.Optional(Type.String()),
	audit: MaestroAppServerNetworkAuditRecordSchema,
});
export type MaestroAppServerNetworkFetchResult = Static<
	typeof MaestroAppServerNetworkFetchResultSchema
>;

export const MaestroAppServerNetworkAuditListResultSchema = Type.Object({
	audit: Type.Array(MaestroAppServerNetworkAuditRecordSchema),
	nextCursor: Type.Union([Type.String(), Type.Null()]),
});
export type MaestroAppServerNetworkAuditListResult = Static<
	typeof MaestroAppServerNetworkAuditListResultSchema
>;

export const maestroAppServerSandboxTypes = [
	"seatbelt",
	"landlock",
	"none",
] as const;
export const MaestroAppServerSandboxTypeSchema = stringLiteralUnion(
	maestroAppServerSandboxTypes,
);
export type MaestroAppServerSandboxType =
	(typeof maestroAppServerSandboxTypes)[number];

export const maestroAppServerSandboxProofModes = [
	"read-only",
	"workspace-write",
] as const;
export const MaestroAppServerSandboxProofModeSchema = stringLiteralUnion(
	maestroAppServerSandboxProofModes,
);
export type MaestroAppServerSandboxProofMode =
	(typeof maestroAppServerSandboxProofModes)[number];

export const MaestroAppServerSandboxProbeResultSchema = Type.Object({
	available: Type.Boolean(),
	type: MaestroAppServerSandboxTypeSchema,
	platform: Type.String(),
	supportedModes: Type.Array(MaestroAppServerSandboxProofModeSchema),
	proofAvailable: Type.Boolean(),
});
export type MaestroAppServerSandboxProbeResult = Static<
	typeof MaestroAppServerSandboxProbeResultSchema
>;

export const MaestroAppServerSandboxProofCheckSchema = Type.Object({
	name: Type.String(),
	passed: Type.Boolean(),
	detail: Type.String(),
});
export type MaestroAppServerSandboxProofCheck = Static<
	typeof MaestroAppServerSandboxProofCheckSchema
>;

export const MaestroAppServerSandboxProofResultSchema = Type.Object({
	mode: MaestroAppServerSandboxProofModeSchema,
	available: Type.Boolean(),
	type: MaestroAppServerSandboxTypeSchema,
	passed: Type.Boolean(),
	skippedReason: Type.Optional(Type.String()),
	checks: Type.Array(MaestroAppServerSandboxProofCheckSchema),
});
export type MaestroAppServerSandboxProofResult = Static<
	typeof MaestroAppServerSandboxProofResultSchema
>;

export const maestroAppServerExternalAgentArtifactKinds = [
	"session",
	"config",
	"hooks",
	"mcp",
	"skill",
] as const;
export const MaestroAppServerExternalAgentArtifactKindSchema =
	stringLiteralUnion(maestroAppServerExternalAgentArtifactKinds);
export type MaestroAppServerExternalAgentArtifactKind =
	(typeof maestroAppServerExternalAgentArtifactKinds)[number];

export const maestroAppServerExternalAgentImportStatuses = [
	"planned",
	"imported",
	"skipped",
] as const;
export const MaestroAppServerExternalAgentImportStatusSchema =
	stringLiteralUnion(maestroAppServerExternalAgentImportStatuses);
export type MaestroAppServerExternalAgentImportStatus =
	(typeof maestroAppServerExternalAgentImportStatuses)[number];

export const maestroAppServerExternalAgentImportScopes = [
	"project",
	"local",
	"user",
] as const;
export const MaestroAppServerExternalAgentImportScopeSchema =
	stringLiteralUnion(maestroAppServerExternalAgentImportScopes);
export type MaestroAppServerExternalAgentImportScope =
	(typeof maestroAppServerExternalAgentImportScopes)[number];

export const MaestroAppServerExternalAgentImportedArtifactSchema = Type.Object({
	kind: MaestroAppServerExternalAgentArtifactKindSchema,
	status: MaestroAppServerExternalAgentImportStatusSchema,
	scope: Type.Optional(MaestroAppServerExternalAgentImportScopeSchema),
	id: Type.Optional(Type.String()),
	path: Type.Optional(Type.String()),
	message: Type.Optional(Type.String()),
});
export type MaestroAppServerExternalAgentImportedArtifact = Static<
	typeof MaestroAppServerExternalAgentImportedArtifactSchema
>;

export const MaestroAppServerExternalAgentImportResultSchema = Type.Object({
	source: Type.Object({
		name: Type.String(),
		type: Type.Optional(Type.String()),
	}),
	dryRun: Type.Boolean(),
	imported: Type.Array(MaestroAppServerExternalAgentImportedArtifactSchema),
	warnings: Type.Array(Type.String()),
});
export type MaestroAppServerExternalAgentImportResult = Static<
	typeof MaestroAppServerExternalAgentImportResultSchema
>;

export const maestroAppServerPluginBundleScopes = [
	"project",
	"local",
	"user",
] as const;
export const MaestroAppServerPluginBundleScopeSchema = stringLiteralUnion(
	maestroAppServerPluginBundleScopes,
);
export type MaestroAppServerPluginBundleScope =
	(typeof maestroAppServerPluginBundleScopes)[number];

export const MaestroAppServerPluginBundleSchema = Type.Object({
	source: Type.String(),
	scope: MaestroAppServerPluginBundleScopeSchema,
	configPath: Type.String(),
});
export type MaestroAppServerPluginBundle = Static<
	typeof MaestroAppServerPluginBundleSchema
>;

export const MaestroAppServerPluginBundleResourcesSchema = Type.Object({
	extensions: Type.Object({
		user: Type.Array(Type.String()),
		project: Type.Array(Type.String()),
	}),
	skills: Type.Object({
		user: Type.Array(Type.String()),
		project: Type.Array(Type.String()),
	}),
	prompts: Type.Object({
		user: Type.Array(Type.String()),
		project: Type.Array(Type.String()),
	}),
	themes: Type.Object({
		user: Type.Array(Type.String()),
		project: Type.Array(Type.String()),
	}),
});
export type MaestroAppServerPluginBundleResources = Static<
	typeof MaestroAppServerPluginBundleResourcesSchema
>;

export const MaestroAppServerPluginBundleListResultSchema = Type.Object({
	bundles: Type.Array(MaestroAppServerPluginBundleSchema),
	resources: MaestroAppServerPluginBundleResourcesSchema,
	errors: Type.Array(Type.String()),
});
export type MaestroAppServerPluginBundleListResult = Static<
	typeof MaestroAppServerPluginBundleListResultSchema
>;

export const MaestroAppServerPluginBundleMutationResultSchema = Type.Object({
	source: Type.String(),
	scope: MaestroAppServerPluginBundleScopeSchema,
	configPath: Type.String(),
	changed: Type.Boolean(),
	message: Type.String(),
});
export type MaestroAppServerPluginBundleMutationResult = Static<
	typeof MaestroAppServerPluginBundleMutationResultSchema
>;

export const maestroAppServerRemoteControlStatuses = [
	"unavailable",
	"ready",
	"draining",
] as const;
export const MaestroAppServerRemoteControlStatusSchema = stringLiteralUnion(
	maestroAppServerRemoteControlStatuses,
);
export type MaestroAppServerRemoteControlStatus =
	(typeof maestroAppServerRemoteControlStatuses)[number];

export const maestroAppServerRemoteControlLeaseStates = [
	"unbound",
	"bound",
	"draining",
] as const;
export const MaestroAppServerRemoteControlLeaseStateSchema = stringLiteralUnion(
	maestroAppServerRemoteControlLeaseStates,
);
export type MaestroAppServerRemoteControlLeaseState =
	(typeof maestroAppServerRemoteControlLeaseStates)[number];

export const MaestroAppServerRemoteControlLeaseSchema = Type.Object({
	protocolVersion: Type.String(),
	runnerSessionId: Type.String(),
	ownerInstanceId: Type.Optional(Type.String()),
	workspaceId: Type.Optional(Type.String()),
	agentId: Type.Optional(Type.String()),
	agentRunId: Type.Optional(Type.String()),
	maestroSessionId: Type.Optional(Type.String()),
	configuredMaestroSessionId: Type.Optional(Type.String()),
	state: MaestroAppServerRemoteControlLeaseStateSchema,
	generation: Type.Number(),
	heartbeatAt: Type.String(),
	updatedAt: Type.String(),
	leaseTokenPresent: Type.Boolean(),
});
export type MaestroAppServerRemoteControlLease = Static<
	typeof MaestroAppServerRemoteControlLeaseSchema
>;

export const MaestroAppServerRemoteControlLastDrainSchema = Type.Object({
	status: Type.String(),
	manifestPath: Type.String(),
	drainedAt: Type.String(),
	reason: Type.Optional(Type.String()),
	requestedBy: Type.Optional(Type.String()),
});
export type MaestroAppServerRemoteControlLastDrain = Static<
	typeof MaestroAppServerRemoteControlLastDrainSchema
>;

export const MaestroAppServerRemoteControlStatusResultSchema = Type.Object({
	available: Type.Boolean(),
	status: MaestroAppServerRemoteControlStatusSchema,
	runnerSessionId: Type.Optional(Type.String()),
	ownerInstanceId: Type.Optional(Type.String()),
	workspaceRoot: Type.Optional(Type.String()),
	snapshotRoot: Type.Optional(Type.String()),
	workspaceId: Type.Optional(Type.String()),
	agentId: Type.Optional(Type.String()),
	agentRunId: Type.Optional(Type.String()),
	a2aMessageId: Type.Optional(Type.String()),
	a2aTaskId: Type.Optional(Type.String()),
	agentRuntimeWorkerQueue: Type.Optional(Type.String()),
	agentRuntimeCorrelationPath: Type.Optional(Type.String()),
	maestroSessionId: Type.Optional(Type.String()),
	lastDrain: Type.Optional(MaestroAppServerRemoteControlLastDrainSchema),
	lease: Type.Union([MaestroAppServerRemoteControlLeaseSchema, Type.Null()]),
	error: Type.Optional(Type.String()),
});
export type MaestroAppServerRemoteControlStatusResult = Static<
	typeof MaestroAppServerRemoteControlStatusResultSchema
>;

export const MaestroAppServerDaemonProcessSchema = Type.Object({
	pid: Type.Number(),
	ppid: Type.Number(),
	platform: Type.String(),
	arch: Type.String(),
	nodeVersion: Type.String(),
	cwd: Type.String(),
	uptimeMs: Type.Number(),
});
export type MaestroAppServerDaemonProcess = Static<
	typeof MaestroAppServerDaemonProcessSchema
>;

export const MaestroAppServerDaemonStatusResultSchema = Type.Object({
	daemon: MaestroAppServerDaemonProcessSchema,
	remoteControl: MaestroAppServerRemoteControlStatusResultSchema,
});
export type MaestroAppServerDaemonStatusResult = Static<
	typeof MaestroAppServerDaemonStatusResultSchema
>;

export const MaestroAppServerRemoteControlLeaseResultSchema = Type.Object({
	available: Type.Boolean(),
	lease: Type.Union([MaestroAppServerRemoteControlLeaseSchema, Type.Null()]),
});
export type MaestroAppServerRemoteControlLeaseResult = Static<
	typeof MaestroAppServerRemoteControlLeaseResultSchema
>;

export const MaestroAppServerRemoteControlDrainResultSchema = Type.Object({
	drained: Type.Boolean(),
	status: Type.String(),
	runnerSessionId: Type.String(),
	reason: Type.Optional(Type.String()),
	requestedBy: Type.Optional(Type.String()),
	manifestPath: Type.String(),
	manifest: Type.Unknown(),
	remoteControl: MaestroAppServerRemoteControlStatusResultSchema,
});
export type MaestroAppServerRemoteControlDrainResult = Static<
	typeof MaestroAppServerRemoteControlDrainResultSchema
>;

export const MaestroAppServerEmptyResultSchema = Type.Object(
	{},
	{ additionalProperties: false },
);
export type MaestroAppServerEmptyResult = Static<
	typeof MaestroAppServerEmptyResultSchema
>;

export const MaestroAppServerCommandExecResultSchema = Type.Object({
	stdout: Type.String(),
	stderr: Type.String(),
	exitCode: Type.Number(),
});
export type MaestroAppServerCommandExecResult = Static<
	typeof MaestroAppServerCommandExecResultSchema
>;

export const MaestroAppServerCommandProcessResultSchema = Type.Object({
	processId: Type.String(),
});
export type MaestroAppServerCommandProcessResult = Static<
	typeof MaestroAppServerCommandProcessResultSchema
>;

export const MaestroAppServerFsReadFileResultSchema = Type.Object({
	dataBase64: Type.String(),
});
export type MaestroAppServerFsReadFileResult = Static<
	typeof MaestroAppServerFsReadFileResultSchema
>;

export const MaestroAppServerFsReadDirectoryEntrySchema = Type.Object({
	fileName: Type.String(),
	isDirectory: Type.Boolean(),
	isFile: Type.Boolean(),
});
export type MaestroAppServerFsReadDirectoryEntry = Static<
	typeof MaestroAppServerFsReadDirectoryEntrySchema
>;

export const MaestroAppServerFsReadDirectoryResultSchema = Type.Object({
	entries: Type.Array(MaestroAppServerFsReadDirectoryEntrySchema),
});
export type MaestroAppServerFsReadDirectoryResult = Static<
	typeof MaestroAppServerFsReadDirectoryResultSchema
>;

export const MaestroAppServerFsMetadataResultSchema = Type.Object({
	createdAtMs: Type.Number(),
	modifiedAtMs: Type.Number(),
	isDirectory: Type.Boolean(),
	isFile: Type.Boolean(),
	isSymlink: Type.Boolean(),
});
export type MaestroAppServerFsMetadataResult = Static<
	typeof MaestroAppServerFsMetadataResultSchema
>;

export const MaestroAppServerFsWatchResultSchema = Type.Object({
	watchId: Type.String(),
	path: Type.String(),
});
export type MaestroAppServerFsWatchResult = Static<
	typeof MaestroAppServerFsWatchResultSchema
>;

export const MaestroAppServerFsChangedNotificationParamsSchema = Type.Object({
	watchId: Type.String(),
	changedPaths: Type.Array(Type.String()),
});
export type MaestroAppServerFsChangedNotificationParams = Static<
	typeof MaestroAppServerFsChangedNotificationParamsSchema
>;

export const MaestroAppServerThreadStartResultSchema = Type.Object({
	thread: MaestroAppServerThreadSummarySchema,
});
export type MaestroAppServerThreadStartResult = Static<
	typeof MaestroAppServerThreadStartResultSchema
>;

export const MaestroAppServerThreadForkResultSchema = Type.Object({
	thread: MaestroAppServerThreadSummarySchema,
	parentThreadId: Type.String(),
	forkedFromEntryId: Type.String(),
});
export type MaestroAppServerThreadForkResult = Static<
	typeof MaestroAppServerThreadForkResultSchema
>;

export const MaestroAppServerThreadArchiveResultSchema = Type.Object({
	thread: MaestroAppServerThreadSummarySchema,
	archived: Type.Boolean(),
});
export type MaestroAppServerThreadArchiveResult = Static<
	typeof MaestroAppServerThreadArchiveResultSchema
>;

export const MaestroAppServerThreadDeleteResultSchema = Type.Object({
	threadId: Type.String(),
	deleted: Type.Boolean(),
});
export type MaestroAppServerThreadDeleteResult = Static<
	typeof MaestroAppServerThreadDeleteResultSchema
>;

export const MaestroAppServerModelCapabilitiesSchema = Type.Object({
	streaming: Type.Boolean(),
	tools: Type.Boolean(),
	vision: Type.Boolean(),
	reasoning: Type.Boolean(),
	responsesApi: Type.Boolean(),
	codexBackend: Type.Boolean(),
	local: Type.Boolean(),
});
export const MaestroAppServerReasoningEffortSchema = Type.Union([
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("ultra"),
]);
export const MaestroAppServerModelSchema = Type.Object({
	id: Type.String(),
	provider: Type.String(),
	name: Type.String(),
	api: Type.String(),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	cost: Type.Optional(Type.Record(Type.String(), Type.Number())),
	source: Type.Optional(
		Type.Union([Type.Literal("builtin"), Type.Literal("custom")]),
	),
	supportedReasoningEfforts: Type.Optional(
		Type.Array(MaestroAppServerReasoningEffortSchema),
	),
	defaultReasoningEffort: Type.Optional(MaestroAppServerReasoningEffortSchema),
	capabilities: MaestroAppServerModelCapabilitiesSchema,
});
export type MaestroAppServerModel = Static<typeof MaestroAppServerModelSchema>;

export const MaestroAppServerModelListResultSchema = Type.Object({
	models: Type.Array(MaestroAppServerModelSchema),
});
export type MaestroAppServerModelListResult = Static<
	typeof MaestroAppServerModelListResultSchema
>;

export const MaestroAppServerModelProviderCapabilitiesSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	apis: Type.Array(Type.String()),
	modelCount: Type.Number(),
	capabilities: MaestroAppServerModelCapabilitiesSchema,
});
export type MaestroAppServerModelProviderCapabilities = Static<
	typeof MaestroAppServerModelProviderCapabilitiesSchema
>;

export const MaestroAppServerModelProviderCapabilitiesReadResultSchema =
	Type.Object({
		providers: Type.Array(MaestroAppServerModelProviderCapabilitiesSchema),
	});
export type MaestroAppServerModelProviderCapabilitiesReadResult = Static<
	typeof MaestroAppServerModelProviderCapabilitiesReadResultSchema
>;

export const MaestroAppServerResponseSchema = Type.Object({
	jsonrpc: Type.Literal("2.0"),
	id: MaestroAppServerJsonRpcResponseIdSchema,
	result: Type.Optional(
		Type.Union([
			MaestroAppServerInitializeResultSchema,
			MaestroAppServerModelListResultSchema,
			MaestroAppServerModelProviderCapabilitiesReadResultSchema,
			MaestroAppServerPolicyReadResultSchema,
			MaestroAppServerPolicyCheckResultSchema,
			MaestroAppServerRequirementsListResultSchema,
			MaestroAppServerNetworkFetchResultSchema,
			MaestroAppServerNetworkAuditListResultSchema,
			MaestroAppServerSandboxProbeResultSchema,
			MaestroAppServerSandboxProofResultSchema,
			MaestroAppServerExternalAgentImportResultSchema,
			MaestroAppServerPluginBundleListResultSchema,
			MaestroAppServerPluginBundleMutationResultSchema,
			MaestroAppServerDaemonStatusResultSchema,
			MaestroAppServerRemoteControlStatusResultSchema,
			MaestroAppServerRemoteControlLeaseResultSchema,
			MaestroAppServerRemoteControlDrainResultSchema,
			MaestroAppServerCommandExecResultSchema,
			MaestroAppServerCommandProcessResultSchema,
			MaestroAppServerFsReadFileResultSchema,
			MaestroAppServerFsReadDirectoryResultSchema,
			MaestroAppServerFsMetadataResultSchema,
			MaestroAppServerFsWatchResultSchema,
			MaestroAppServerEmptyResultSchema,
			MaestroAppServerThreadListResultSchema,
			MaestroAppServerThreadReadResultSchema,
			MaestroAppServerThreadMetadataUpdateResultSchema,
			MaestroAppServerThreadGoalResultSchema,
			MaestroAppServerTurnsListResultSchema,
			MaestroAppServerThreadStartResultSchema,
			MaestroAppServerThreadForkResultSchema,
			MaestroAppServerThreadArchiveResultSchema,
			MaestroAppServerThreadDeleteResultSchema,
		]),
	),
	error: Type.Optional(
		Type.Object({
			code: Type.Number(),
			message: Type.String(),
		}),
	),
});
export type MaestroAppServerResponse = Static<
	typeof MaestroAppServerResponseSchema
>;

export const MaestroAppServerServerNotificationSchema = Type.Object({
	jsonrpc: Type.Literal("2.0"),
	method: stringLiteralUnion(maestroAppServerServerMethods),
	params: Type.Optional(MaestroAppServerFsChangedNotificationParamsSchema),
});
export type MaestroAppServerServerNotification = Static<
	typeof MaestroAppServerServerNotificationSchema
>;
