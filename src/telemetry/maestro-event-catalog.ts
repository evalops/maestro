export enum MaestroBusEventType {
	SessionStarted = "maestro.sessions.session.started",
	SessionSuspended = "maestro.sessions.session.suspended",
	SessionResumed = "maestro.sessions.session.resumed",
	SessionClosed = "maestro.sessions.session.closed",
	ApprovalHit = "maestro.events.approval_hit",
	SandboxViolation = "maestro.events.sandbox_violation",
	FirewallBlock = "maestro.events.firewall_block",
	ToolCallAttempted = "maestro.events.tool_call.attempted",
	ToolCallCompleted = "maestro.events.tool_call.completed",
	PromptVariantSelected = "maestro.events.prompt_variant.selected",
	SkillInvoked = "maestro.events.skill.invoked",
	SkillSucceeded = "maestro.events.skill.succeeded",
	SkillFailed = "maestro.events.skill.failed",
	EvalScored = "maestro.events.eval.scored",
}

export type MaestroBusEventCategory =
	| "session"
	| "approval"
	| "safety"
	| "tool"
	| "prompt"
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
	[MaestroBusEventType.PromptVariantSelected]: entry(
		MaestroBusEventType.PromptVariantSelected,
		"prompt",
		"PromptVariantSelected",
		["prompts.maestro-prompt-variant-selected"],
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
	[MaestroBusEventType.EvalScored]: entry(
		MaestroBusEventType.EvalScored,
		"eval",
		"MaestroEvalScore",
		["fermata.maestro-eval-scored", "prompts.maestro-eval-scored"],
	),
} as const satisfies Record<MaestroBusEventType, MaestroBusEventCatalogEntry>;

export const MAESTRO_BUS_EVENT_TYPES = Object.values(MaestroBusEventType);

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
