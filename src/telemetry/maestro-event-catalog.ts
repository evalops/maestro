export enum MaestroBusEventType {
	SessionStarted = "maestro.sessions.session.started",
	SessionSuspended = "maestro.sessions.session.suspended",
	SessionResumed = "maestro.sessions.session.resumed",
	SessionClosed = "maestro.sessions.session.closed",
	InstallCheckCompleted = "maestro.events.install_check.completed",
	ApprovalHit = "maestro.events.approval_hit",
	SandboxViolation = "maestro.events.sandbox_violation",
	FirewallBlock = "maestro.events.firewall_block",
	ToolCallAttempted = "maestro.events.tool_call.attempted",
	ToolCallCompleted = "maestro.events.tool_call.completed",
	ToolCallFailed = "maestro.events.tool_call.failed",
	ErrorCaptured = "maestro.events.error.captured",
	ArtifactCreated = "maestro.events.artifact.created",
	FinalStatusReported = "maestro.events.final_status.reported",
	PromptVariantSelected = "maestro.events.prompt_variant.selected",
	ContextLearned = "maestro.events.context.learned",
	SkillInvoked = "maestro.events.skill.invoked",
	SkillSucceeded = "maestro.events.skill.succeeded",
	SkillFailed = "maestro.events.skill.failed",
	SubagentDispatched = "maestro.events.subagent.dispatched",
	EvalScored = "maestro.events.eval.scored",
}

export type MaestroBusEventCategory =
	| "session"
	| "install"
	| "agent"
	| "approval"
	| "safety"
	| "tool"
	| "error"
	| "artifact"
	| "final-status"
	| "prompt"
	| "knowledge"
	| "skill"
	| "eval";

export interface MaestroBusEventCatalogEntry {
	category: MaestroBusEventCategory;
	dataSchema: string;
	platformConsumers: readonly string[];
	protoAnyType: string;
	subject: MaestroBusEventType;
	type: MaestroBusEventType;
}

const auditConsumer = "audit.maestro-events";

function entry(
	type: MaestroBusEventType,
	category: MaestroBusEventCategory,
	protoMessage: string,
	platformConsumers: readonly string[],
): MaestroBusEventCatalogEntry {
	return {
		category,
		dataSchema: `buf.build/evalops/proto/maestro.v1.${protoMessage}`,
		platformConsumers: [auditConsumer, ...platformConsumers].sort(),
		protoAnyType: `type.googleapis.com/maestro.v1.${protoMessage}`,
		subject: type,
		type,
	};
}

export const MAESTRO_BUS_EVENT_CATALOG = {
	[MaestroBusEventType.SessionStarted]: entry(
		MaestroBusEventType.SessionStarted,
		"session",
		"MaestroSession",
		[
			"fermata.maestro-session-replay-context",
			"meter.maestro-session-lifecycle",
		],
	),
	[MaestroBusEventType.SessionSuspended]: entry(
		MaestroBusEventType.SessionSuspended,
		"session",
		"MaestroSession",
		[
			"fermata.maestro-session-replay-context",
			"meter.maestro-session-lifecycle",
		],
	),
	[MaestroBusEventType.SessionResumed]: entry(
		MaestroBusEventType.SessionResumed,
		"session",
		"MaestroSession",
		[
			"fermata.maestro-session-replay-context",
			"meter.maestro-session-lifecycle",
		],
	),
	[MaestroBusEventType.SessionClosed]: entry(
		MaestroBusEventType.SessionClosed,
		"session",
		"MaestroSession",
		[
			"fermata.maestro-session-replay-context",
			"meter.maestro-session-lifecycle",
		],
	),
	[MaestroBusEventType.InstallCheckCompleted]: entry(
		MaestroBusEventType.InstallCheckCompleted,
		"install",
		"PackageInstallCheck",
		["meter.maestro-install-checks", "release.maestro-install-smoke"],
	),
	[MaestroBusEventType.ApprovalHit]: entry(
		MaestroBusEventType.ApprovalHit,
		"approval",
		"ApprovalHit",
		["governance.maestro-approval-hit"],
	),
	[MaestroBusEventType.SandboxViolation]: entry(
		MaestroBusEventType.SandboxViolation,
		"safety",
		"SandboxViolation",
		["governance.maestro-sandbox-violation"],
	),
	[MaestroBusEventType.FirewallBlock]: entry(
		MaestroBusEventType.FirewallBlock,
		"safety",
		"FirewallBlock",
		["governance.maestro-firewall-block"],
	),
	[MaestroBusEventType.ToolCallAttempted]: entry(
		MaestroBusEventType.ToolCallAttempted,
		"tool",
		"ToolCallAttempt",
		["meter.maestro-tool-call-events"],
	),
	[MaestroBusEventType.ToolCallCompleted]: entry(
		MaestroBusEventType.ToolCallCompleted,
		"tool",
		"ToolCallResult",
		["meter.maestro-tool-call-events", "skills.maestro-tool-call-completed"],
	),
	[MaestroBusEventType.ToolCallFailed]: entry(
		MaestroBusEventType.ToolCallFailed,
		"tool",
		"ToolCallResult",
		[
			"meter.maestro-tool-call-events",
			"release.maestro-tool-failure-gates",
			"skills.maestro-tool-call-failed",
		],
	),
	[MaestroBusEventType.ErrorCaptured]: entry(
		MaestroBusEventType.ErrorCaptured,
		"error",
		"MaestroError",
		["audit.maestro-errors", "meter.maestro-errors"],
	),
	[MaestroBusEventType.ArtifactCreated]: entry(
		MaestroBusEventType.ArtifactCreated,
		"artifact",
		"MaestroArtifact",
		["fermata.maestro-artifacts", "meter.maestro-artifacts"],
	),
	[MaestroBusEventType.FinalStatusReported]: entry(
		MaestroBusEventType.FinalStatusReported,
		"final-status",
		"MaestroFinalStatus",
		["fermata.maestro-final-status", "meter.maestro-final-status"],
	),
	[MaestroBusEventType.PromptVariantSelected]: entry(
		MaestroBusEventType.PromptVariantSelected,
		"prompt",
		"PromptVariantSelected",
		["prompts.maestro-prompt-variant-selected"],
	),
	[MaestroBusEventType.ContextLearned]: entry(
		MaestroBusEventType.ContextLearned,
		"knowledge",
		"MaestroLearnedContext",
		["cerebro.maestro-learned-context"],
	),
	[MaestroBusEventType.SkillInvoked]: entry(
		MaestroBusEventType.SkillInvoked,
		"skill",
		"SkillInvocation",
		["skills.maestro-skill-events"],
	),
	[MaestroBusEventType.SkillSucceeded]: entry(
		MaestroBusEventType.SkillSucceeded,
		"skill",
		"SkillOutcome",
		["skills.maestro-skill-events"],
	),
	[MaestroBusEventType.SkillFailed]: entry(
		MaestroBusEventType.SkillFailed,
		"skill",
		"SkillOutcome",
		["skills.maestro-skill-events"],
	),
	[MaestroBusEventType.SubagentDispatched]: entry(
		MaestroBusEventType.SubagentDispatched,
		"agent",
		"SubagentDispatch",
		["agents.maestro-subagent-dispatches", "meter.maestro-subagent-dispatches"],
	),
	[MaestroBusEventType.EvalScored]: entry(
		MaestroBusEventType.EvalScored,
		"eval",
		"MaestroEvalScore",
		["fermata.maestro-eval-scored", "prompts.maestro-eval-scored"],
	),
} as const satisfies Record<MaestroBusEventType, MaestroBusEventCatalogEntry>;

export const MAESTRO_BUS_EVENT_TYPES = Object.values(MaestroBusEventType);

export const MAESTRO_RELEASE_GATE_EVENT_CATEGORIES = [
	"install",
	"session",
	"tool",
	"approval",
	"error",
	"artifact",
	"final-status",
] as const satisfies readonly MaestroBusEventCategory[];

export type MaestroReleaseGateEventCategory =
	(typeof MAESTRO_RELEASE_GATE_EVENT_CATEGORIES)[number];

export function isMaestroBusEventType(
	value: string,
): value is MaestroBusEventType {
	return MAESTRO_BUS_EVENT_TYPES.includes(value as MaestroBusEventType);
}

export function getMaestroBusEventCatalogEntry(
	type: MaestroBusEventType,
): MaestroBusEventCatalogEntry {
	return MAESTRO_BUS_EVENT_CATALOG[type];
}

export function listMaestroBusEventCatalog(): readonly MaestroBusEventCatalogEntry[] {
	return MAESTRO_BUS_EVENT_TYPES.map(getMaestroBusEventCatalogEntry);
}

export function listMaestroBusEventCatalogByCategory(
	category: MaestroBusEventCategory,
): readonly MaestroBusEventCatalogEntry[] {
	return listMaestroBusEventCatalog().filter(
		(entry) => entry.category === category,
	);
}

export function getMissingMaestroReleaseGateEventCategories(
	catalog: readonly MaestroBusEventCatalogEntry[] = listMaestroBusEventCatalog(),
): readonly MaestroReleaseGateEventCategory[] {
	const coveredCategories = new Set(catalog.map((entry) => entry.category));
	return MAESTRO_RELEASE_GATE_EVENT_CATEGORIES.filter(
		(category) => !coveredCategories.has(category),
	);
}
