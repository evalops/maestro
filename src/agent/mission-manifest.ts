/**
 * Mission Feature Manifest
 *
 * A Mission decomposes a feature-shaped goal into a list of leaf features
 * the orchestrator can hand to worker agents. Each feature claims a
 * subset of the validation contract's assertion ids in its `fulfills`
 * field; pre-execution, the coverage gate refuses to start work until
 * every assertion is claimed by exactly one feature and no feature
 * references an unknown assertion.
 *
 * ## Feature lifecycle
 *
 *   pending     — created but not yet picked up by a worker
 *   in-progress — claimed by a worker, work is happening
 *   passed      — worker completed and the validation step ran clean
 *   failed      — worker completed but validation reported a failure
 *   preempted   — a higher-priority feature was inserted ahead of this
 *                 one mid-run; the runner reverts this feature to
 *                 pending and re-runs it later with a fresh worker
 *
 * ## Worker handoff shape
 *
 * When a worker finishes a feature, it returns a structured handoff so
 * the orchestrator can record what changed and where validation
 * evidence lives. Repo edits include a `commitId` + `repoPath` so the
 * verification pass can `git checkout` the worker's work and replay
 * the test suite from there.
 *
 * ## What this module is and isn't
 *
 * Pure types + helpers (manifest construction, coverage gate against
 * validation contract assertion ids, preemption, feature lookup,
 * handoff follow-up promotion, handoff continuity gates, summary
 * stats). No disk persistence, no worker dispatch, no orchestrator
 * loop — those ride in follow-up PRs that consume the shape defined
 * here.
 */

/** Lifecycle of one feature within a mission. */
export type MissionFeatureStatus =
	| "pending"
	| "in-progress"
	| "passed"
	| "failed"
	| "preempted";

export const MISSION_FEATURE_STATUSES = [
	"pending",
	"in-progress",
	"passed",
	"failed",
	"preempted",
] as const satisfies readonly MissionFeatureStatus[];

export function isMissionFeatureStatus(
	value: unknown,
): value is MissionFeatureStatus {
	return (
		typeof value === "string" &&
		MISSION_FEATURE_STATUSES.includes(value as MissionFeatureStatus)
	);
}

/** Optional milestone grouping for UI / reporting. */
export interface MissionMilestone {
	id: string;
	name: string;
}

/** Structured handoff returned by a worker after completing a feature. */
export interface MissionWorkerHandoff {
	/** Worker that produced the handoff. */
	workerId: string;
	/** Did the worker's own validation step succeed? */
	success: boolean;
	/** Repo path the worker checked out + edited. */
	repoPath?: string;
	/** Commit id the worker landed (head of its branch). */
	commitId?: string;
	/** Free-form summary the worker produced for the orchestrator. */
	summary?: string;
	/** Concrete description of what was built or changed. */
	whatWasImplemented?: string;
	/** Work that remains incomplete; empty or "none" means no known remainder. */
	whatWasLeftUndone?: string;
	/** Issues discovered while doing the work. Blocking issues should become follow-ups. */
	discoveredIssues?: MissionDiscoveredIssue[];
	/** Verification evidence the worker ran before handing off. */
	verification?: {
		commandsRun?: MissionVerificationCommand[];
	};
	/** ISO 8601 timestamp the handoff was recorded. */
	handedOffAt: string;
}

/** Issue surfaced by a worker handoff. */
export interface MissionDiscoveredIssue {
	severity: "blocking" | "non_blocking";
	description: string;
	suggestedFix?: string;
}

/** Command-level verification evidence from a worker handoff. */
export interface MissionVerificationCommand {
	command: string;
	exitCode?: number;
	observation?: string;
}

export type MissionHandoffItemKind = "unfinished_work" | "discovered_issue";

/** Explicit decision not to act on a handoff item. */
export interface MissionHandoffDismissal {
	kind: MissionHandoffItemKind;
	key: string;
	justification: string;
	dismissedAt: string;
}

/** Explicit decision to handle a handoff item inside an existing feature. */
export interface MissionTrackedHandoffItem {
	sourceFeatureId: string;
	kind: MissionHandoffItemKind;
	key: string;
	trackedAt: string;
	note?: string;
}

/** One leaf feature in the manifest. */
export interface MissionFeature {
	/** Stable feature id (orchestrator-assigned). */
	id: string;
	/** Short human-readable description. */
	description: string;
	/** Lifecycle status. */
	status: MissionFeatureStatus;
	/** Optional milestone the feature belongs to. */
	milestone?: string;
	/** Worker skill the runner dispatches for this feature. */
	skillName?: string;
	/**
	 * Validation contract assertion ids this feature commits to
	 * satisfying. The coverage gate requires every contract assertion
	 * to be claimed by exactly one feature.
	 */
	fulfills: string[];
	/** Worker handoff, present after the worker completes. */
	handoff?: MissionWorkerHandoff;
	/** Handoff items the orchestrator explicitly chose not to act on. */
	handoffDismissals?: MissionHandoffDismissal[];
	/** Handoff items this feature is responsible for resolving. */
	trackedHandoffItems?: MissionTrackedHandoffItem[];
	/** Source feature that caused this follow-up, when derived from a handoff. */
	handoffSourceFeatureId?: string;
	/** Why this follow-up exists, when derived from a handoff. */
	handoffFollowUpKind?: MissionHandoffItemKind;
	/** Stable key of the source handoff item this follow-up tracks. */
	handoffItemKey?: string;
}

export function isMissionFeature(value: unknown): value is MissionFeature {
	if (!value || typeof value !== "object") return false;
	const feature = value as Record<string, unknown>;
	return (
		typeof feature.id === "string" &&
		feature.id.trim().length > 0 &&
		typeof feature.description === "string" &&
		feature.description.trim().length > 0 &&
		isMissionFeatureStatus(feature.status) &&
		(typeof feature.milestone === "undefined" ||
			typeof feature.milestone === "string") &&
		(typeof feature.skillName === "undefined" ||
			typeof feature.skillName === "string") &&
		Array.isArray(feature.fulfills) &&
		feature.fulfills.every((assertion) => typeof assertion === "string") &&
		(typeof feature.handoff === "undefined" ||
			isMissionWorkerHandoff(feature.handoff)) &&
		(typeof feature.handoffDismissals === "undefined" ||
			(Array.isArray(feature.handoffDismissals) &&
				feature.handoffDismissals.every(isMissionHandoffDismissal))) &&
		(typeof feature.trackedHandoffItems === "undefined" ||
			(Array.isArray(feature.trackedHandoffItems) &&
				feature.trackedHandoffItems.every(isMissionTrackedHandoffItem))) &&
		(typeof feature.handoffSourceFeatureId === "undefined" ||
			typeof feature.handoffSourceFeatureId === "string") &&
		(typeof feature.handoffFollowUpKind === "undefined" ||
			isMissionHandoffItemKind(feature.handoffFollowUpKind)) &&
		(typeof feature.handoffItemKey === "undefined" ||
			typeof feature.handoffItemKey === "string")
	);
}

function isMissionWorkerHandoff(value: unknown): value is MissionWorkerHandoff {
	if (!value || typeof value !== "object") return false;
	const handoff = value as Record<string, unknown>;
	return (
		typeof handoff.workerId === "string" &&
		handoff.workerId.trim().length > 0 &&
		typeof handoff.success === "boolean" &&
		(typeof handoff.repoPath === "undefined" ||
			typeof handoff.repoPath === "string") &&
		(typeof handoff.commitId === "undefined" ||
			typeof handoff.commitId === "string") &&
		(typeof handoff.summary === "undefined" ||
			typeof handoff.summary === "string") &&
		(typeof handoff.whatWasImplemented === "undefined" ||
			typeof handoff.whatWasImplemented === "string") &&
		(typeof handoff.whatWasLeftUndone === "undefined" ||
			typeof handoff.whatWasLeftUndone === "string") &&
		(typeof handoff.discoveredIssues === "undefined" ||
			(Array.isArray(handoff.discoveredIssues) &&
				handoff.discoveredIssues.every(isMissionDiscoveredIssue))) &&
		(typeof handoff.verification === "undefined" ||
			isMissionVerification(handoff.verification)) &&
		typeof handoff.handedOffAt === "string" &&
		!Number.isNaN(Date.parse(handoff.handedOffAt))
	);
}

function isMissionDiscoveredIssue(
	value: unknown,
): value is MissionDiscoveredIssue {
	if (!value || typeof value !== "object") return false;
	const issue = value as Record<string, unknown>;
	return (
		(issue.severity === "blocking" || issue.severity === "non_blocking") &&
		typeof issue.description === "string" &&
		issue.description.trim().length > 0 &&
		(typeof issue.suggestedFix === "undefined" ||
			typeof issue.suggestedFix === "string")
	);
}

function isMissionVerification(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const verification = value as Record<string, unknown>;
	return (
		typeof verification.commandsRun === "undefined" ||
		(Array.isArray(verification.commandsRun) &&
			verification.commandsRun.every(isMissionVerificationCommand))
	);
}

function isMissionVerificationCommand(
	value: unknown,
): value is MissionVerificationCommand {
	if (!value || typeof value !== "object") return false;
	const command = value as Record<string, unknown>;
	return (
		typeof command.command === "string" &&
		command.command.trim().length > 0 &&
		(typeof command.exitCode === "undefined" ||
			typeof command.exitCode === "number") &&
		(typeof command.observation === "undefined" ||
			typeof command.observation === "string")
	);
}

function isMissionHandoffDismissal(
	value: unknown,
): value is MissionHandoffDismissal {
	if (!value || typeof value !== "object") return false;
	const dismissal = value as Record<string, unknown>;
	return (
		isMissionHandoffItemKind(dismissal.kind) &&
		typeof dismissal.key === "string" &&
		dismissal.key.trim().length > 0 &&
		typeof dismissal.justification === "string" &&
		dismissal.justification.trim().length > 0 &&
		typeof dismissal.dismissedAt === "string" &&
		!Number.isNaN(Date.parse(dismissal.dismissedAt))
	);
}

function isMissionTrackedHandoffItem(
	value: unknown,
): value is MissionTrackedHandoffItem {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return (
		typeof item.sourceFeatureId === "string" &&
		item.sourceFeatureId.trim().length > 0 &&
		isMissionHandoffItemKind(item.kind) &&
		typeof item.key === "string" &&
		item.key.trim().length > 0 &&
		typeof item.trackedAt === "string" &&
		!Number.isNaN(Date.parse(item.trackedAt)) &&
		(typeof item.note === "undefined" || typeof item.note === "string")
	);
}

function isMissionHandoffItemKind(
	value: unknown,
): value is MissionHandoffItemKind {
	return value === "unfinished_work" || value === "discovered_issue";
}

/** Top-level mission feature manifest (features.json on disk). */
export interface MissionManifest {
	/** Schema version. */
	version: number;
	/** Mission identifier. */
	missionId: string;
	/** Optional milestones referenced by individual features. */
	milestones: MissionMilestone[];
	/** Leaf features, in append order. */
	features: MissionFeature[];
	/** ISO 8601 creation timestamp. */
	createdAt: string;
	/** ISO 8601 timestamp of the most recent state change. */
	updatedAt: string;
}

export const MISSION_MANIFEST_VERSION = 1;

/** Coverage gate report shape (matches validation-contract's shape). */
export interface MissionCoverageReport {
	/** True when every contract assertion is claimed by exactly one feature. */
	ok: boolean;
	/** Assertion ids not claimed by any feature. */
	orphans: string[];
	/** Assertion ids duplicated in the contract or claimed more than once. */
	duplicates: string[];
	/** Assertion ids referenced by features but absent from the contract. */
	unknownAssertions: string[];
}

export interface MissionContinuityItem {
	sourceFeatureId: string;
	kind: MissionHandoffItemKind;
	key: string;
	severity?: MissionDiscoveredIssue["severity"];
	description: string;
	status: "tracked" | "dismissed" | "untracked";
	followUpFeatureId?: string;
	trackingFeatureId?: string;
	trackingNote?: string;
	dismissalJustification?: string;
}

export interface MissionOpenHandoffFollowUp {
	id: string;
	status: MissionFeatureStatus;
	sourceFeatureId: string;
	kind: MissionHandoffItemKind;
	description: string;
}

export interface MissionOpenHandoffTracking {
	id: string;
	status: MissionFeatureStatus;
	sourceFeatureId: string;
	kind: MissionHandoffItemKind;
	key: string;
	description: string;
	note?: string;
}

export interface MissionContinuityReport {
	ok: boolean;
	unresolved: MissionContinuityItem[];
	tracked: MissionContinuityItem[];
	dismissed: MissionContinuityItem[];
	openFollowUps: MissionOpenHandoffFollowUp[];
	openTrackedItems: MissionOpenHandoffTracking[];
}

export interface MissionCompletionReport {
	ok: boolean;
	coverage: MissionCoverageReport;
	continuity: MissionContinuityReport;
	incompleteFeatures: Array<{
		id: string;
		status: MissionFeatureStatus;
		description: string;
	}>;
}

/**
 * Construct a fresh, empty manifest. Features and milestones are added
 * later via `appendFeature` / `addMilestone`.
 */
export function createMissionManifest(options: {
	missionId: string;
	now?: string;
}): MissionManifest {
	const missionId = options.missionId.trim();
	if (!missionId) {
		throw new Error("missionId is required");
	}
	const now = options.now ?? new Date().toISOString();
	return {
		version: MISSION_MANIFEST_VERSION,
		missionId,
		milestones: [],
		features: [],
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * Append a feature to the manifest. Returns a new manifest.
 *
 * The input type excludes `handoff` — handoffs only exist after a
 * worker completes a feature, so a freshly appended feature cannot
 * carry one. We also strip any `handoff` key defensively in case a
 * caller bypasses the type with `as` to keep the lifecycle invariant.
 */
export function appendFeature(
	manifest: MissionManifest,
	feature: Omit<MissionFeature, "status" | "handoff">,
): MissionManifest {
	assertFeatureBasics(feature);
	if (manifest.features.some((f) => f.id === feature.id)) {
		throw new Error(`Duplicate feature id "${feature.id}"`);
	}
	const { handoff: _handoff, ...rest } = feature as MissionFeature;
	return {
		...manifest,
		features: [
			...manifest.features,
			{
				...rest,
				status: "pending",
			},
		],
		updatedAt: new Date().toISOString(),
	};
}

/** Add a milestone to the manifest. */
export function addMilestone(
	manifest: MissionManifest,
	milestone: MissionMilestone,
): MissionManifest {
	if (manifest.milestones.some((m) => m.id === milestone.id)) {
		throw new Error(`Duplicate milestone id "${milestone.id}"`);
	}
	return {
		...manifest,
		milestones: [...manifest.milestones, milestone],
		updatedAt: new Date().toISOString(),
	};
}

/**
 * Coverage gate. Returns `ok: true` only when every contract assertion
 * id is claimed by exactly one feature's `fulfills` array and no
 * feature references an assertion id absent from the contract.
 *
 * `allContractAssertionIds` comes from
 * `listAssertionIds(validationContract)` in `./validation-contract.ts`.
 * Kept as a plain string[] here so this module doesn't need to import
 * the validation contract module.
 */
export function checkMissionCoverage(
	manifest: MissionManifest,
	allContractAssertionIds: readonly string[],
): MissionCoverageReport {
	const contractIdCounts = new Map<string, number>();
	for (const id of allContractAssertionIds) {
		contractIdCounts.set(id, (contractIdCounts.get(id) ?? 0) + 1);
	}
	const contractIds = new Set(contractIdCounts.keys());
	const claimCounts = new Map<string, number>();
	const unknownSet = new Set<string>();

	for (const feature of manifest.features) {
		for (const assertionId of feature.fulfills) {
			claimCounts.set(assertionId, (claimCounts.get(assertionId) ?? 0) + 1);
			if (!contractIds.has(assertionId)) {
				unknownSet.add(assertionId);
			}
		}
	}

	const orphans: string[] = [];
	const duplicateSet = new Set<string>();
	for (const [id, contractCount] of contractIdCounts) {
		const count = claimCounts.get(id) ?? 0;
		if (count === 0) {
			orphans.push(id);
		}
		if (contractCount > 1 || count > 1) {
			duplicateSet.add(id);
		}
	}
	// Unknown assertion ids (not in the contract) that are claimed by
	// more than one feature also count as duplicates — the report
	// field is "ids claimed more than once," not "contract ids claimed
	// more than once." Without this the runner would silently see two
	// features racing on the same unknown id.
	for (const id of unknownSet) {
		if ((claimCounts.get(id) ?? 0) > 1) {
			duplicateSet.add(id);
		}
	}

	orphans.sort();
	const duplicates = Array.from(duplicateSet).sort();
	const unknownAssertions = Array.from(unknownSet).sort();

	return {
		ok:
			orphans.length === 0 &&
			duplicates.length === 0 &&
			unknownAssertions.length === 0,
		orphans,
		duplicates,
		unknownAssertions,
	};
}

/** Find a feature by id, or `undefined`. */
export function findFeature(
	manifest: MissionManifest,
	featureId: string,
): MissionFeature | undefined {
	return manifest.features.find((f) => f.id === featureId);
}

/**
 * Set a feature's lifecycle status. Returns a new manifest.
 *
 * Flipping to `pending` or `preempted` clears the feature's handoff so
 * the next worker starts fresh — matching `appendFeature` and
 * `preemptInsert`. Other transitions leave the handoff intact.
 */
export function setFeatureStatus(
	manifest: MissionManifest,
	featureId: string,
	status: MissionFeatureStatus,
): MissionManifest {
	let touched = false;
	const next = manifest.features.map((f) => {
		if (f.id !== featureId) return f;
		touched = true;
		if (status === "pending" || status === "preempted") {
			const { handoff: _handoff, ...rest } = f;
			return { ...rest, status };
		}
		return { ...f, status };
	});
	if (!touched) {
		throw new Error(`Feature id "${featureId}" not in manifest`);
	}
	return { ...manifest, features: next, updatedAt: new Date().toISOString() };
}

/** Record a worker handoff against a feature. */
export function recordHandoff(
	manifest: MissionManifest,
	featureId: string,
	handoff: MissionWorkerHandoff,
): MissionManifest {
	let touched = false;
	const next = manifest.features.map((f) => {
		if (f.id !== featureId) return f;
		touched = true;
		return {
			...f,
			handoff,
			status: handoff.success ? ("passed" as const) : ("failed" as const),
		};
	});
	if (!touched) {
		throw new Error(`Feature id "${featureId}" not in manifest`);
	}
	return { ...manifest, features: next, updatedAt: handoff.handedOffAt };
}

export interface HandoffFollowUpOptions {
	/** Include non-blocking discovered issues as follow-up features. */
	includeNonBlockingIssues?: boolean;
	/** Stable timestamp for tests or deterministic callers. */
	now?: string;
}

/** Promote unfinished handoff work and blocking discoveries into pending features. */
export function appendHandoffFollowUps(
	manifest: MissionManifest,
	featureId: string,
	options: HandoffFollowUpOptions = {},
): MissionManifest {
	const sourceIndex = manifest.features.findIndex((f) => f.id === featureId);
	if (sourceIndex === -1) {
		throw new Error(`Feature id "${featureId}" not in manifest`);
	}
	const source = manifest.features[sourceIndex];
	if (!source?.handoff) {
		return manifest;
	}

	const followUps = buildHandoffFollowUpFeatures(manifest, source, options);
	if (followUps.length === 0) {
		return manifest;
	}

	return {
		...manifest,
		features: [
			...manifest.features.slice(0, sourceIndex + 1),
			...followUps,
			...manifest.features.slice(sourceIndex + 1),
		],
		updatedAt: options.now ?? new Date().toISOString(),
	};
}

export interface DismissHandoffItemOptions {
	kind: MissionHandoffItemKind;
	key: string;
	justification: string;
	includeNonBlockingIssues?: boolean;
	now?: string;
}

/** Explicitly dismiss a handoff item so completion gates can distinguish intent from omission. */
export function dismissHandoffItem(
	manifest: MissionManifest,
	featureId: string,
	options: DismissHandoffItemOptions,
): MissionManifest {
	const justification = normalizeFollowUpText(options.justification);
	if (!justification) {
		throw new Error("dismissal justification is required");
	}
	const feature = findFeature(manifest, featureId);
	if (!feature) {
		throw new Error(`Feature id "${featureId}" not in manifest`);
	}
	const candidates = buildHandoffContinuityRecords(feature, {
		includeNonBlockingIssues: options.includeNonBlockingIssues,
	});
	if (
		!candidates.some(
			(item) => item.kind === options.kind && item.key === options.key,
		)
	) {
		throw new Error(
			`Handoff item "${options.key}" (${options.kind}) not found on feature "${featureId}"`,
		);
	}

	const dismissedAt = options.now ?? new Date().toISOString();
	return {
		...manifest,
		features: manifest.features.map((current) => {
			if (current.id !== featureId) return current;
			const existing = current.handoffDismissals ?? [];
			const nextDismissals = [
				...existing.filter(
					(item) => item.kind !== options.kind || item.key !== options.key,
				),
				{
					kind: options.kind,
					key: options.key,
					justification,
					dismissedAt,
				},
			];
			return { ...current, handoffDismissals: nextDismissals };
		}),
		updatedAt: dismissedAt,
	};
}

export interface TrackHandoffItemOptions {
	kind: MissionHandoffItemKind;
	key: string;
	note?: string;
	includeNonBlockingIssues?: boolean;
	/** Re-open the target feature to handle this item. Clears any stale target handoff. */
	requeueTarget?: boolean;
	/** Permit tracking on already-passed work without re-opening it. */
	allowPassedTarget?: boolean;
	now?: string;
}

/** Assign a handoff item to an existing feature instead of creating a duplicate follow-up. */
export function trackHandoffItemOnFeature(
	manifest: MissionManifest,
	sourceFeatureId: string,
	targetFeatureId: string,
	options: TrackHandoffItemOptions,
): MissionManifest {
	const source = findFeature(manifest, sourceFeatureId);
	if (!source) {
		throw new Error(`Feature id "${sourceFeatureId}" not in manifest`);
	}
	const target = findFeature(manifest, targetFeatureId);
	if (!target) {
		throw new Error(`Feature id "${targetFeatureId}" not in manifest`);
	}
	if (
		sourceFeatureId === targetFeatureId &&
		target.status === "passed" &&
		!options.requeueTarget
	) {
		throw new Error(
			`Cannot self-track handoff item on passed feature "${targetFeatureId}"; requeue it first`,
		);
	}
	if (target.status === "in-progress" && !options.requeueTarget) {
		throw new Error(
			`Cannot track handoff item on in-progress feature "${targetFeatureId}"; requeue it so the worker receives the obligation`,
		);
	}
	if (
		target.status === "passed" &&
		!options.allowPassedTarget &&
		!options.requeueTarget
	) {
		throw new Error(
			`Cannot track handoff item on passed feature "${targetFeatureId}"; requeue it or choose a pending feature`,
		);
	}
	const selectedRecord = buildHandoffContinuityRecords(source, {
		includeNonBlockingIssues: options.includeNonBlockingIssues,
	}).find((item) => item.kind === options.kind && item.key === options.key);
	if (!selectedRecord) {
		throw new Error(
			`Handoff item "${options.key}" (${options.kind}) not found on feature "${sourceFeatureId}"`,
		);
	}
	if (
		(source.handoffDismissals ?? []).some(
			(item) => item.kind === options.kind && item.key === options.key,
		)
	) {
		throw new Error(
			`Handoff item "${options.key}" (${options.kind}) was dismissed on feature "${sourceFeatureId}"`,
		);
	}
	const existingFollowUp = findTrackedHandoffFollowUp(
		manifest,
		source,
		selectedRecord,
	);
	if (existingFollowUp) {
		throw new Error(
			`Handoff item "${options.key}" (${options.kind}) is already tracked by follow-up feature "${existingFollowUp.id}"`,
		);
	}

	const trackedAt = options.now ?? new Date().toISOString();
	const note = normalizeFollowUpText(options.note);
	return {
		...manifest,
		features: manifest.features.map((current) => {
			const existing = current.trackedHandoffItems ?? [];
			const nextExisting = existing.filter(
				(item) =>
					item.sourceFeatureId !== sourceFeatureId ||
					item.kind !== options.kind ||
					item.key !== options.key,
			);
			if (current.id !== targetFeatureId) {
				if (nextExisting.length === existing.length) return current;
				if (nextExisting.length > 0) {
					return { ...current, trackedHandoffItems: nextExisting };
				}
				const { trackedHandoffItems: _trackedHandoffItems, ...rest } = current;
				return rest;
			}
			const nextTracked = [
				...nextExisting,
				{
					sourceFeatureId,
					kind: options.kind,
					key: options.key,
					trackedAt,
					...(note ? { note } : {}),
				},
			];
			if (options.requeueTarget) {
				const { handoff: _handoff, ...rest } = current;
				return {
					...rest,
					status: "pending",
					trackedHandoffItems: nextTracked,
				};
			}
			return { ...current, trackedHandoffItems: nextTracked };
		}),
		updatedAt: trackedAt,
	};
}

export interface MissionContinuityOptions {
	/** Include non-blocking discovered issues in the continuity gate. */
	includeNonBlockingIssues?: boolean;
}

/** Report whether handoff gaps are tracked, dismissed, or still dangling. */
export function summarizeMissionContinuity(
	manifest: MissionManifest,
	options: MissionContinuityOptions = {},
): MissionContinuityReport {
	const tracked: MissionContinuityItem[] = [];
	const dismissed: MissionContinuityItem[] = [];
	const unresolved: MissionContinuityItem[] = [];

	for (const feature of manifest.features) {
		const records = buildHandoffContinuityRecords(feature, options);
		const dismissalLookup = new Map(
			(feature.handoffDismissals ?? []).map((item) => [
				continuityLookupKey(feature.id, item.kind, item.key),
				item,
			]),
		);

		for (const record of records) {
			const lookupKey = continuityLookupKey(
				feature.id,
				record.kind,
				record.key,
			);
			const followUp = findTrackedHandoffFollowUp(manifest, feature, record);
			const trackingFeature = findExistingHandoffTracking(
				manifest,
				feature,
				record,
			);
			const dismissal = dismissalLookup.get(lookupKey);
			if (dismissal) {
				dismissed.push({
					sourceFeatureId: feature.id,
					kind: record.kind,
					key: record.key,
					severity: record.severity,
					description: record.description,
					status: "dismissed",
					dismissalJustification: dismissal.justification,
				});
				continue;
			}
			if (followUp) {
				tracked.push({
					sourceFeatureId: feature.id,
					kind: record.kind,
					key: record.key,
					severity: record.severity,
					description: record.description,
					status: "tracked",
					followUpFeatureId: followUp.id,
				});
				continue;
			}
			if (trackingFeature) {
				const trackedItem = trackingFeature.trackedHandoffItems?.find(
					(item) =>
						item.sourceFeatureId === feature.id &&
						item.kind === record.kind &&
						item.key === record.key,
				);
				tracked.push({
					sourceFeatureId: feature.id,
					kind: record.kind,
					key: record.key,
					severity: record.severity,
					description: record.description,
					status: "tracked",
					trackingFeatureId: trackingFeature.id,
					trackingNote: trackedItem?.note,
				});
				continue;
			}
			unresolved.push({
				sourceFeatureId: feature.id,
				kind: record.kind,
				key: record.key,
				severity: record.severity,
				description: record.description,
				status: "untracked",
			});
		}
	}

	const openFollowUps = manifest.features
		.filter(
			(feature) =>
				feature.handoffSourceFeatureId &&
				feature.handoffFollowUpKind &&
				feature.status !== "passed",
		)
		.map((feature) => ({
			id: feature.id,
			status: feature.status,
			sourceFeatureId: feature.handoffSourceFeatureId!,
			kind: feature.handoffFollowUpKind!,
			description: feature.description,
		}));
	const openTrackedItems = manifest.features
		.flatMap((feature) =>
			(feature.trackedHandoffItems ?? []).map((item) => ({
				feature,
				item,
			})),
		)
		.filter(
			({ feature, item }) =>
				feature.status !== "passed" &&
				isTrackedItemCurrent(manifest, feature, item, options),
		)
		.map(({ feature, item }) => ({
			id: feature.id,
			status: feature.status,
			sourceFeatureId: item.sourceFeatureId,
			kind: item.kind,
			key: item.key,
			description: feature.description,
			...(item.note ? { note: item.note } : {}),
		}));

	return {
		ok:
			unresolved.length === 0 &&
			openFollowUps.length === 0 &&
			openTrackedItems.length === 0,
		unresolved,
		tracked,
		dismissed,
		openFollowUps,
		openTrackedItems,
	};
}

/** Final mission gate: contract coverage, all features passed, and no dangling handoff work. */
export function canCompleteMission(
	manifest: MissionManifest,
	allContractAssertionIds: readonly string[],
	options: MissionContinuityOptions = {},
): MissionCompletionReport {
	const coverage = checkMissionCoverage(manifest, allContractAssertionIds);
	const continuity = summarizeMissionContinuity(manifest, options);
	const incompleteFeatures = manifest.features
		.filter((feature) => feature.status !== "passed")
		.map((feature) => ({
			id: feature.id,
			status: feature.status,
			description: feature.description,
		}));

	return {
		ok: coverage.ok && continuity.ok && incompleteFeatures.length === 0,
		coverage,
		continuity,
		incompleteFeatures,
	};
}

/**
 * Preempt the in-progress feature: insert a higher-priority feature at
 * the position before the active one, mark the active one as
 * `preempted` so the runner re-runs it later from scratch with a fresh
 * worker (its handoff is cleared).
 *
 * Throws when:
 *   - no feature is currently in-progress
 *   - more than one feature is in-progress (the runner invariant is
 *     one active feature at a time; refuse to silently leave the
 *     extras running)
 *   - the inserted feature's id collides with an existing one
 */
export function preemptInsert(
	manifest: MissionManifest,
	insertedFeature: Omit<MissionFeature, "status" | "handoff">,
): MissionManifest {
	assertFeatureBasics(insertedFeature);
	if (manifest.features.some((f) => f.id === insertedFeature.id)) {
		throw new Error(
			`Cannot preempt-insert duplicate feature id "${insertedFeature.id}"`,
		);
	}
	const inProgressIndices: number[] = [];
	for (let i = 0; i < manifest.features.length; i += 1) {
		if (manifest.features[i]?.status === "in-progress") {
			inProgressIndices.push(i);
		}
	}
	if (inProgressIndices.length === 0) {
		throw new Error(
			"Cannot preempt-insert: no feature is currently in-progress",
		);
	}
	if (inProgressIndices.length > 1) {
		const ids = inProgressIndices
			.map((idx) => manifest.features[idx]?.id ?? "?")
			.join(", ");
		throw new Error(
			`Cannot preempt-insert: more than one feature is in-progress (${ids}); the runner expects exactly one`,
		);
	}
	const activeIndex = inProgressIndices[0];
	if (activeIndex === undefined) {
		throw new Error("preempt-insert: lost track of the active feature");
	}
	const head = manifest.features.slice(0, activeIndex);
	const active = manifest.features[activeIndex];
	const tail = manifest.features.slice(activeIndex + 1);
	if (!active) {
		// Defensive: activeIndex is guarded above; the read can't be undefined.
		throw new Error("preempt-insert: lost track of the active feature");
	}
	const { handoff: _activeHandoff, ...activeRest } = active;
	const revertedActive: MissionFeature = {
		...activeRest,
		status: "preempted",
	};
	const { handoff: _insertedHandoff, ...insertedRest } =
		insertedFeature as MissionFeature;
	const inserted: MissionFeature = {
		...insertedRest,
		status: "pending",
	};
	return {
		...manifest,
		features: [...head, inserted, revertedActive, ...tail],
		updatedAt: new Date().toISOString(),
	};
}

function assertFeatureBasics(
	feature: Pick<MissionFeature, "id" | "description">,
): void {
	if (!feature.id.trim()) {
		throw new Error("feature.id is required");
	}
	if (!feature.description.trim()) {
		throw new Error("feature.description is required");
	}
}

function buildHandoffFollowUpFeatures(
	manifest: MissionManifest,
	source: MissionFeature,
	options: HandoffFollowUpOptions,
): MissionFeature[] {
	const followUps: MissionFeature[] = [];
	const existingIds = new Set(manifest.features.map((feature) => feature.id));
	const generatedFollowUpKeys = new Set<string>();
	const dismissedKeys = new Set(
		(source.handoffDismissals ?? []).map((dismissal) =>
			handoffFollowUpKey(dismissal.kind, dismissal.key),
		),
	);
	const reserveId = (seed: string) => {
		let id = seed;
		let suffix = 2;
		while (existingIds.has(id)) {
			id = `${seed}-${suffix}`;
			suffix += 1;
		}
		existingIds.add(id);
		return id;
	};

	for (const item of buildHandoffContinuityRecords(source, options)) {
		if (dismissedKeys.has(handoffFollowUpKey(item.kind, item.key))) {
			continue;
		}
		if (findTrackedHandoffFollowUp(manifest, source, item)) {
			continue;
		}
		if (findExistingHandoffTracking(manifest, source, item)) {
			continue;
		}
		const followUp = createHandoffFollowUpFeature({
			source,
			id: reserveId(item.idSeed),
			kind: item.kind,
			itemKey: item.key,
			description: item.followUpDescription,
		});
		if (!generatedFollowUpKeys.has(featureFollowUpKey(followUp))) {
			followUps.push(followUp);
			generatedFollowUpKeys.add(featureFollowUpKey(followUp));
		}
	}

	return followUps;
}

function createHandoffFollowUpFeature(input: {
	source: MissionFeature;
	id: string;
	kind: MissionHandoffItemKind;
	itemKey: string;
	description: string;
}): MissionFeature {
	return {
		id: input.id,
		description: input.description,
		status: "pending",
		milestone: input.source.milestone,
		skillName: input.source.skillName,
		fulfills: [],
		handoffSourceFeatureId: input.source.id,
		handoffFollowUpKind: input.kind,
		handoffItemKey: input.itemKey,
	};
}

interface HandoffContinuityRecord {
	kind: MissionHandoffItemKind;
	key: string;
	severity?: MissionDiscoveredIssue["severity"];
	description: string;
	followUpDescription: string;
	idSeed: string;
}

function buildHandoffContinuityRecords(
	source: MissionFeature,
	options: MissionContinuityOptions,
): HandoffContinuityRecord[] {
	const handoff = source.handoff;
	if (!handoff) {
		return [];
	}

	const records: HandoffContinuityRecord[] = [];
	const unfinished = normalizeFollowUpText(handoff.whatWasLeftUndone);
	if (unfinished) {
		records.push({
			kind: "unfinished_work",
			key: handoffItemKey("unfinished_work", unfinished),
			description: unfinished,
			followUpDescription: `Finish unfinished work from ${source.id}: ${unfinished}`,
			idSeed: `${source.id}-followup-unfinished`,
		});
	}

	for (const [index, issue] of (handoff.discoveredIssues ?? []).entries()) {
		if (
			issue.severity === "non_blocking" &&
			!options.includeNonBlockingIssues
		) {
			continue;
		}
		const description = normalizeFollowUpText(issue.description);
		if (!description) {
			continue;
		}
		const suggestedFix = normalizeFollowUpText(issue.suggestedFix);
		records.push({
			kind: "discovered_issue",
			key: handoffItemKey(
				"discovered_issue",
				`${issue.severity}:${description}:${suggestedFix ?? ""}`,
			),
			severity: issue.severity,
			description: suggestedFix
				? `${description} Suggested fix: ${suggestedFix}`
				: description,
			followUpDescription: suggestedFix
				? `Resolve ${issue.severity} issue from ${source.id}: ${trimTrailingSentencePunctuation(description)}. Suggested fix: ${suggestedFix}`
				: `Resolve ${issue.severity} issue from ${source.id}: ${description}`,
			idSeed: `${source.id}-followup-issue-${index + 1}`,
		});
	}

	return records;
}

function findTrackedHandoffFollowUp(
	manifest: MissionManifest,
	source: MissionFeature,
	record: HandoffContinuityRecord,
): MissionFeature | undefined {
	return manifest.features.find(
		(feature) =>
			feature.handoffSourceFeatureId === source.id &&
			feature.handoffFollowUpKind === record.kind &&
			(feature.handoffItemKey === record.key ||
				(!feature.handoffItemKey &&
					feature.description === record.followUpDescription)),
	);
}

function findExistingHandoffTracking(
	manifest: MissionManifest,
	source: MissionFeature,
	record: HandoffContinuityRecord,
): MissionFeature | undefined {
	return manifest.features.find((feature) =>
		(feature.trackedHandoffItems ?? []).some(
			(item) =>
				item.sourceFeatureId === source.id &&
				item.kind === record.kind &&
				item.key === record.key &&
				isTrackingFreshForSource(source, item),
		),
	);
}

function isTrackingFreshForSource(
	source: MissionFeature,
	item: MissionTrackedHandoffItem,
): boolean {
	if (!source.handoff) {
		return true;
	}
	return compareIsoInstants(item.trackedAt, source.handoff.handedOffAt) >= 0;
}

function isTrackedItemCurrent(
	manifest: MissionManifest,
	trackingFeature: MissionFeature,
	item: MissionTrackedHandoffItem,
	options: MissionContinuityOptions,
): boolean {
	const source = findFeature(manifest, item.sourceFeatureId);
	if (!source) {
		return false;
	}
	if (
		(source.handoffDismissals ?? []).some(
			(dismissal) => dismissal.kind === item.kind && dismissal.key === item.key,
		)
	) {
		return false;
	}
	if (!source.handoff) {
		return trackingFeature.id === source.id;
	}
	const record = buildHandoffContinuityRecords(source, options).find(
		(candidate) => candidate.kind === item.kind && candidate.key === item.key,
	);
	if (!record) {
		return false;
	}
	return isTrackingFreshForSource(source, item);
}

function compareIsoInstants(a: string, b: string): number {
	const aTime = Date.parse(a);
	const bTime = Date.parse(b);
	if (Number.isFinite(aTime) && Number.isFinite(bTime)) {
		return aTime - bTime;
	}
	return a.localeCompare(b);
}

function normalizeFollowUpText(value: string | undefined): string | null {
	if (value === undefined) {
		return null;
	}
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized || normalized.toLowerCase() === "none") {
		return null;
	}
	return normalized;
}

function featureFollowUpKey(feature: MissionFeature): string {
	return handoffFollowUpKey(
		feature.handoffFollowUpKind!,
		feature.handoffItemKey ?? feature.description,
	);
}

function handoffFollowUpKey(
	kind: MissionHandoffItemKind,
	description: string,
): string {
	return `${kind}:${description}`;
}

function handoffItemKey(kind: MissionHandoffItemKind, value: string): string {
	return `${kind}:${value.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

function continuityLookupKey(
	sourceFeatureId: string,
	kind: MissionHandoffItemKind,
	itemKey: string,
): string {
	return `${sourceFeatureId}:${kind}:${itemKey}`;
}

function trimTrailingSentencePunctuation(value: string): string {
	return value.replace(/[.!?]+$/g, "");
}

/** Quick summary stats for UI / reporting. */
export function summarizeManifest(manifest: MissionManifest): {
	total: number;
	byStatus: Record<MissionFeatureStatus, number>;
	assertionsClaimed: number;
} {
	const byStatus: Record<MissionFeatureStatus, number> = {
		pending: 0,
		"in-progress": 0,
		passed: 0,
		failed: 0,
		preempted: 0,
	};
	const claimed = new Set<string>();
	for (const f of manifest.features) {
		byStatus[f.status] += 1;
		for (const id of f.fulfills) {
			claimed.add(id);
		}
	}
	return {
		total: manifest.features.length,
		byStatus,
		assertionsClaimed: claimed.size,
	};
}
