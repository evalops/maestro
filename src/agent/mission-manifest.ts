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
 * summary stats). No disk persistence, no worker dispatch, no
 * orchestrator loop — those ride in follow-up PRs that consume the
 * shape defined here.
 */

/** Lifecycle of one feature within a mission. */
export type MissionFeatureStatus =
	| "pending"
	| "in-progress"
	| "passed"
	| "failed"
	| "preempted";

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
	/** ISO 8601 timestamp the handoff was recorded. */
	handedOffAt: string;
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
