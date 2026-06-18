export const MAESTRO_OPERATING_LAYER_VERSION =
	"evalops.maestro.operating-layer.v1";

export type OperatingLayerCapabilityId =
	| "protocol-boundary"
	| "policy-resolution"
	| "sync-outbox"
	| "approval-evidence"
	| "extension-governance"
	| "run-readiness"
	| "run-effectiveness"
	| "release-canary";

export interface OperatingLayerCapability {
	id: OperatingLayerCapabilityId;
	name: string;
	description: string;
	evidenceKinds: string[];
}

export interface OperatingLayerManifest {
	version: typeof MAESTRO_OPERATING_LAYER_VERSION;
	capabilities: OperatingLayerCapability[];
}

export const OPERATING_LAYER_CAPABILITIES: OperatingLayerCapability[] = [
	{
		id: "protocol-boundary",
		name: "Protocol boundary",
		description:
			"Treats versioned protocols as the product integration surface.",
		evidenceKinds: ["protocol.version", "protocol.contract", "protocol.owner"],
	},
	{
		id: "policy-resolution",
		name: "Policy resolution",
		description:
			"Explains the source and override chain for resolved settings.",
		evidenceKinds: ["policy.subject", "policy.source", "policy.resolved_value"],
	},
	{
		id: "sync-outbox",
		name: "Sync outbox",
		description:
			"Classifies cloud/session sync outcomes into durable retry actions.",
		evidenceKinds: ["sync.item", "sync.outcome", "sync.next_action"],
	},
	{
		id: "approval-evidence",
		name: "Approval evidence",
		description:
			"Normalizes permission decisions across tool and product surfaces.",
		evidenceKinds: [
			"approval.request",
			"approval.decision",
			"approval.surface",
		],
	},
	{
		id: "extension-governance",
		name: "Extension governance",
		description:
			"Evaluates extensions against marketplace trust and scope policy.",
		evidenceKinds: [
			"extension.source",
			"extension.signature",
			"extension.scopes",
		],
	},
	{
		id: "run-readiness",
		name: "Run readiness",
		description: "Scores whether a run has enough evidence to proceed or ship.",
		evidenceKinds: ["readiness.signal", "readiness.score", "readiness.blocker"],
	},
	{
		id: "run-effectiveness",
		name: "Run effectiveness",
		description:
			"Scores completed work against outcome and confidence signals.",
		evidenceKinds: [
			"effectiveness.signal",
			"effectiveness.score",
			"effectiveness.evidence",
		],
	},
	{
		id: "release-canary",
		name: "Release canary",
		description:
			"Defines ordered gates for publish, smoke, replay, and notification.",
		evidenceKinds: ["release.stage", "release.gate", "release.evidence"],
	},
];

export interface ProtocolBoundaryInput {
	protocolId: string;
	version: string;
	owners?: string[];
	contracts?: string[];
	compatibility?: "experimental" | "stable" | "deprecated";
}

export interface ProtocolBoundaryDescriptor extends ProtocolBoundaryInput {
	compatibility: "experimental" | "stable" | "deprecated";
	reasons: string[];
}

export interface PolicyResolutionSource<T = unknown> {
	layer:
		| "default"
		| "runtime"
		| "user"
		| "workspace"
		| "project"
		| "organization"
		| "session";
	id: string;
	value: T;
	reason?: string;
}

export interface PolicyResolutionExplanation<T = unknown> {
	subject: string;
	resolvedValue: T | undefined;
	activeSource?: PolicyResolutionSource<T>;
	chain: Array<
		PolicyResolutionSource<T> & {
			overrides: string[];
		}
	>;
	reasons: string[];
}

export type SyncOutboxKind =
	| "session_create"
	| "session_update"
	| "message"
	| "settings"
	| "artifact"
	| "approval";

export interface SyncOutboxItem {
	id: string;
	kind: SyncOutboxKind;
	sessionId?: string;
	status: "pending" | "in_flight" | "succeeded" | "failed" | "blocked";
	attempt: number;
	maxAttempts: number;
}

export interface SyncOutcome {
	ok: boolean;
	statusCode?: number;
	errorCode?: string;
}

export interface SyncOutboxDecision {
	action: "complete" | "retry" | "self_heal_session" | "block";
	reason: string;
	nextAttempt: number;
}

export interface ApprovalDecisionInput {
	requestId: string;
	surface: "cli" | "tui" | "web" | "mcp" | "api";
	mode: "suggest" | "ask" | "auto" | "deny";
	decision: "approved" | "denied" | "expired";
	toolNames?: string[];
	policyRefs?: string[];
}

export interface ApprovalDecisionEvidence extends ApprovalDecisionInput {
	approvedTools: string[];
	blockedTools: string[];
	reasons: string[];
}

export interface ExtensionCandidate {
	id: string;
	source: "builtin" | "marketplace" | "local" | "git";
	publisher?: string;
	signed?: boolean;
	pinnedRef?: string;
	requestedScopes?: string[];
}

export interface ExtensionGovernancePolicy {
	allowedSources?: ExtensionCandidate["source"][];
	trustedPublishers?: string[];
	allowedScopes?: string[];
	requireSignature?: boolean;
	requirePinnedGitRef?: boolean;
}

export interface ExtensionGovernanceDecision {
	allowed: boolean;
	blockers: string[];
	reasons: string[];
}

export interface OperatingLayerSignal {
	id: string;
	label: string;
	status: "pass" | "warn" | "fail" | "unknown";
	weight?: number;
	evidence?: string[];
}

export interface OperatingLayerScoreReport {
	version: typeof MAESTRO_OPERATING_LAYER_VERSION;
	score: number;
	blockers: string[];
	warnings: string[];
	signals: OperatingLayerSignal[];
}

export interface ReleaseCanaryStage {
	id: string;
	name: string;
	requires: string[];
	evidenceKinds: string[];
}

export interface ReleaseCanaryPlan {
	version: typeof MAESTRO_OPERATING_LAYER_VERSION;
	stages: ReleaseCanaryStage[];
	blockers: string[];
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function normalizedList(values: string[] | undefined): string[] {
	return unique((values ?? []).map((value) => value.trim()).filter(Boolean));
}

export function buildOperatingLayerManifest(): OperatingLayerManifest {
	return {
		version: MAESTRO_OPERATING_LAYER_VERSION,
		capabilities: OPERATING_LAYER_CAPABILITIES,
	};
}

export function buildProtocolBoundaryDescriptor(
	input: ProtocolBoundaryInput,
): ProtocolBoundaryDescriptor {
	const owners = normalizedList(input.owners);
	const contracts = normalizedList(input.contracts);
	const reasons = [
		`protocol:${input.protocolId}`,
		`version:${input.version}`,
		...owners.map((owner) => `owner:${owner}`),
		...contracts.map((contract) => `contract:${contract}`),
	];

	return {
		...input,
		owners,
		contracts,
		compatibility: input.compatibility ?? "experimental",
		reasons,
	};
}

export function explainResolvedPolicy<T>(
	subject: string,
	sources: PolicyResolutionSource<T>[],
): PolicyResolutionExplanation<T> {
	const activeSource = sources.at(-1);
	return {
		subject,
		resolvedValue: activeSource?.value,
		...(activeSource ? { activeSource } : {}),
		chain: sources.map((source, index) => ({
			...source,
			overrides: sources.slice(0, index).map((prior) => prior.id),
		})),
		reasons: [
			`subject:${subject}`,
			...(activeSource ? [`active_source:${activeSource.id}`] : []),
			...sources.flatMap((source) =>
				source.reason ? [`reason:${source.id}:${source.reason}`] : [],
			),
		],
	};
}

export function classifySyncOutcome(
	item: SyncOutboxItem,
	outcome: SyncOutcome,
): SyncOutboxDecision {
	const nextAttempt = item.attempt + 1;
	if (outcome.ok) {
		return {
			action: "complete",
			reason: "sync_ok",
			nextAttempt,
		};
	}

	if (item.attempt >= item.maxAttempts) {
		return {
			action: "block",
			reason: outcome.errorCode ?? "max_attempts_exhausted",
			nextAttempt,
		};
	}

	if (
		item.kind !== "session_create" &&
		item.sessionId &&
		(outcome.statusCode === 404 || outcome.statusCode === 410)
	) {
		return {
			action: "self_heal_session",
			reason: "remote_session_missing",
			nextAttempt,
		};
	}

	return {
		action: "retry",
		reason: outcome.errorCode ?? `http_${outcome.statusCode ?? "unknown"}`,
		nextAttempt,
	};
}

export function buildApprovalDecisionEvidence(
	input: ApprovalDecisionInput,
): ApprovalDecisionEvidence {
	const toolNames = normalizedList(input.toolNames);
	const approved = input.decision === "approved";
	return {
		...input,
		toolNames,
		policyRefs: normalizedList(input.policyRefs),
		approvedTools: approved ? toolNames : [],
		blockedTools: approved ? [] : toolNames,
		reasons: [
			`surface:${input.surface}`,
			`mode:${input.mode}`,
			`decision:${input.decision}`,
		],
	};
}

export function evaluateExtensionGovernance(
	candidate: ExtensionCandidate,
	policy: ExtensionGovernancePolicy = {},
): ExtensionGovernanceDecision {
	const blockers: string[] = [];
	const reasons = [`source:${candidate.source}`];
	const allowedSources = new Set(policy.allowedSources ?? []);
	if (allowedSources.size > 0 && !allowedSources.has(candidate.source)) {
		blockers.push(`source_not_allowed:${candidate.source}`);
	}
	if (policy.requireSignature && !candidate.signed) {
		blockers.push("signature_required");
	}
	if (
		policy.requirePinnedGitRef &&
		candidate.source === "git" &&
		!candidate.pinnedRef
	) {
		blockers.push("pinned_git_ref_required");
	}

	const trustedPublishers = new Set(policy.trustedPublishers ?? []);
	if (
		candidate.source === "marketplace" &&
		trustedPublishers.size > 0 &&
		candidate.publisher &&
		trustedPublishers.has(candidate.publisher)
	) {
		reasons.push(`trusted_publisher:${candidate.publisher}`);
	} else if (trustedPublishers.size > 0 && candidate.source === "marketplace") {
		blockers.push(`publisher_not_trusted:${candidate.publisher ?? "unknown"}`);
	}

	const allowedScopes = new Set(policy.allowedScopes ?? []);
	const requestedScopes = normalizedList(candidate.requestedScopes);
	for (const scope of requestedScopes) {
		if (allowedScopes.size > 0 && !allowedScopes.has(scope)) {
			blockers.push(`scope_not_allowed:${scope}`);
		}
	}
	reasons.push(...requestedScopes.map((scope) => `scope:${scope}`));
	if (candidate.signed) {
		reasons.push("signed");
	}
	if (candidate.pinnedRef) {
		reasons.push(`pinned_ref:${candidate.pinnedRef}`);
	}

	return {
		allowed: blockers.length === 0,
		blockers: unique(blockers),
		reasons: unique(reasons),
	};
}

export function buildRunReadinessReport(
	signals: OperatingLayerSignal[],
): OperatingLayerScoreReport {
	return buildScoreReport(signals, "readiness");
}

export function buildRunEffectivenessReport(
	signals: OperatingLayerSignal[],
): OperatingLayerScoreReport {
	return buildScoreReport(signals, "effectiveness");
}

function buildScoreReport(
	signals: OperatingLayerSignal[],
	prefix: "readiness" | "effectiveness",
): OperatingLayerScoreReport {
	let earned = 0;
	let possible = 0;
	const blockers: string[] = [];
	const warnings: string[] = [];

	for (const signal of signals) {
		const weight = signal.weight ?? 1;
		if (signal.status !== "unknown") {
			possible += weight;
		}
		if (signal.status === "pass") {
			earned += weight;
		}
		if (signal.status === "warn") {
			earned += weight / 2;
			warnings.push(`${prefix}:${signal.id}`);
		}
		if (signal.status === "fail") {
			blockers.push(`${prefix}:${signal.id}`);
		}
	}

	return {
		version: MAESTRO_OPERATING_LAYER_VERSION,
		score: possible === 0 ? 0 : Math.round((earned / possible) * 100),
		blockers,
		warnings,
		signals,
	};
}

export const DEFAULT_RELEASE_CANARY_STAGES: ReleaseCanaryStage[] = [
	{
		id: "local_release_gate",
		name: "Local release gate",
		requires: [],
		evidenceKinds: ["lint", "test", "build", "release.check"],
	},
	{
		id: "publish_package",
		name: "Publish package",
		requires: ["local_release_gate"],
		evidenceKinds: ["npm.publish", "git.tag", "github.release"],
	},
	{
		id: "registry_install_smoke",
		name: "Registry install smoke",
		requires: ["publish_package"],
		evidenceKinds: ["npm.install", "cli.smoke"],
	},
	{
		id: "published_replay_evidence",
		name: "Published replay evidence",
		requires: ["registry_install_smoke"],
		evidenceKinds: ["replay.e2e", "evidence.verify"],
	},
	{
		id: "release_notification",
		name: "Release notification",
		requires: ["published_replay_evidence"],
		evidenceKinds: ["release.notes", "channel.notification"],
	},
];

export function buildReleaseCanaryPlan(
	stages: ReleaseCanaryStage[] = DEFAULT_RELEASE_CANARY_STAGES,
): ReleaseCanaryPlan {
	const stageIds = new Set(stages.map((stage) => stage.id));
	const stageIndexes = new Map(stages.map((stage, index) => [stage.id, index]));
	const blockers = [
		...detectDuplicateReleaseCanaryStages(stages),
		...stages.flatMap((stage) =>
			stage.requires
				.filter((required) => !stageIds.has(required))
				.map((required) => `missing_stage:${stage.id}:${required}`),
		),
		...stages.flatMap((stage, index) =>
			stage.requires
				.filter((required) => {
					const requiredIndex = stageIndexes.get(required);
					return requiredIndex !== undefined && requiredIndex > index;
				})
				.map((required) => `out_of_order_stage:${stage.id}:${required}`),
		),
		...detectReleaseCanaryCycles(stages),
	];

	return {
		version: MAESTRO_OPERATING_LAYER_VERSION,
		stages,
		blockers,
	};
}

function detectDuplicateReleaseCanaryStages(
	stages: ReleaseCanaryStage[],
): string[] {
	const seen = new Set<string>();
	const blockers: string[] = [];
	for (const stage of stages) {
		if (seen.has(stage.id)) {
			blockers.push(`duplicate_stage:${stage.id}`);
		}
		seen.add(stage.id);
	}
	return unique(blockers);
}

function detectReleaseCanaryCycles(stages: ReleaseCanaryStage[]): string[] {
	const requirementsById = new Map<string, Set<string>>();
	for (const stage of stages) {
		const requirements = requirementsById.get(stage.id) ?? new Set<string>();
		for (const required of stage.requires) {
			requirements.add(required);
		}
		requirementsById.set(stage.id, requirements);
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const blockers: string[] = [];

	function visit(stageId: string, path: string[]): void {
		if (visiting.has(stageId)) {
			const cycleStart = path.indexOf(stageId);
			const cycle = path.slice(cycleStart).join(">");
			blockers.push(`cycle:${cycle}`);
			return;
		}
		if (visited.has(stageId)) {
			return;
		}

		const requirements = requirementsById.get(stageId);
		if (!requirements) {
			return;
		}

		visiting.add(stageId);
		for (const required of requirements) {
			visit(required, [...path, required]);
		}
		visiting.delete(stageId);
		visited.add(stageId);
	}

	for (const stage of stages) {
		visit(stage.id, [stage.id]);
	}

	return unique(blockers);
}
