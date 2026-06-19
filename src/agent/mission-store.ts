import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../config/constants.js";
import { defaultRuntimeEnv } from "../runtime/env.js";
import { readJsonFile, writeJsonFile } from "../utils/fs.js";
import {
	MISSION_MANIFEST_VERSION,
	type MissionFeature,
	type MissionManifest,
	isMissionFeature,
} from "./mission-manifest.js";

export const MISSION_STORE_SCHEMA = "evalops.maestro.mission-store.v1";
const MISSION_STATE_LOCK_STALE_MS = 60_000;

export type MissionState =
	| "awaiting-input"
	| "ready"
	| "running"
	| "blocked"
	| "completed"
	| "failed";

export interface MissionWorkerState {
	startedAt: string;
	completedAt?: string;
	exitCode?: number;
}

export interface MissionTokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens?: number;
	cacheReadTokens?: number;
	thinkingTokens?: number;
	credits?: number;
}

export interface MissionProgressEntry {
	type:
		| "mission_created"
		| "mission_started"
		| "mission_blocked"
		| "mission_completed"
		| "worker_started"
		| "worker_completed"
		| "worker_failed"
		| "note";
	timestamp: string;
	message?: string;
	featureId?: string;
	workerSessionId?: string;
	exitCode?: number;
}

export interface MissionStoreSnapshot {
	schemaVersion: typeof MISSION_STORE_SCHEMA;
	missionId: string;
	sourceMissionId?: string;
	title?: string;
	state: MissionState;
	features: MissionFeature[];
	progressLog: MissionProgressEntry[];
	workerSessionIds: string[];
	workerStates: Record<string, MissionWorkerState>;
	tokenUsageBySessionId: Record<string, MissionTokenUsage>;
	tokenUsage?: MissionTokenUsage;
	createdAt: string;
	updatedAt: string;
}

export interface MissionStoreConfig {
	rootDir?: string;
	now?: () => string;
}

export function getMissionStoreRoot(rootDir?: string): string {
	return (
		rootDir ??
		defaultRuntimeEnv().missionStoreDir ??
		join(PATHS.MAESTRO_HOME, "missions")
	);
}

export function sanitizeMissionId(missionId: string): string {
	const trimmed = normalizeMissionIdInput(missionId);
	if (!trimmed) {
		throw new Error("missionId is required");
	}
	const safe = trimmed
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!safe || !/[A-Za-z0-9]/u.test(safe)) {
		throw new Error(
			"missionId must include at least one alphanumeric character",
		);
	}
	return safe;
}

function normalizeMissionIdInput(missionId: string): string {
	const trimmed = missionId.trim();
	if (!trimmed) {
		throw new Error("missionId is required");
	}
	return trimmed;
}

export function getMissionDir(missionId: string, rootDir?: string): string {
	return join(getMissionStoreRoot(rootDir), sanitizeMissionId(missionId));
}

export function getMissionStatePath(
	missionId: string,
	rootDir?: string,
): string {
	return join(getMissionDir(missionId, rootDir), "state.json");
}

export function createMissionStoreSnapshot(options: {
	missionId: string;
	title?: string;
	manifest?: MissionManifest;
	now?: string;
}): MissionStoreSnapshot {
	const now = options.now ?? new Date().toISOString();
	return {
		schemaVersion: MISSION_STORE_SCHEMA,
		missionId: sanitizeMissionId(options.missionId),
		sourceMissionId: normalizeMissionIdInput(options.missionId),
		title: options.title,
		state: "awaiting-input",
		features: options.manifest?.features ? [...options.manifest.features] : [],
		progressLog: [
			{
				type: "mission_created",
				timestamp: now,
				message: options.title,
			},
		],
		workerSessionIds: [],
		workerStates: {},
		tokenUsageBySessionId: {},
		createdAt: now,
		updatedAt: now,
	};
}

export function sumMissionTokenUsage(
	usages: Record<string, MissionTokenUsage>,
): MissionTokenUsage | undefined {
	const values = Object.values(usages);
	if (values.length === 0) return undefined;
	return values.reduce<MissionTokenUsage>(
		(total, usage) => ({
			inputTokens: total.inputTokens + usage.inputTokens,
			outputTokens: total.outputTokens + usage.outputTokens,
			cacheCreationTokens:
				(total.cacheCreationTokens ?? 0) + (usage.cacheCreationTokens ?? 0),
			cacheReadTokens:
				(total.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
			thinkingTokens: (total.thinkingTokens ?? 0) + (usage.thinkingTokens ?? 0),
			credits: (total.credits ?? 0) + (usage.credits ?? 0),
		}),
		{ inputTokens: 0, outputTokens: 0 },
	);
}

function deriveWorkerState(
	progressLog: readonly MissionProgressEntry[],
	previous: Record<string, MissionWorkerState>,
): Record<string, MissionWorkerState> {
	const next = { ...previous };
	for (const entry of progressLog) {
		if (!entry.workerSessionId) continue;
		const existing = next[entry.workerSessionId];
		if (!existing) {
			next[entry.workerSessionId] = { startedAt: entry.timestamp };
		}
		if (entry.type === "worker_completed" || entry.type === "worker_failed") {
			next[entry.workerSessionId] = {
				startedAt: next[entry.workerSessionId]?.startedAt ?? entry.timestamp,
				completedAt: entry.timestamp,
				exitCode: entry.exitCode,
			};
		}
	}
	return next;
}

function normalizeSnapshot(
	snapshot: MissionStoreSnapshot,
): MissionStoreSnapshot {
	const workerStates = deriveWorkerState(
		snapshot.progressLog ?? [],
		snapshot.workerStates ?? {},
	);
	const workerSessionIds = Array.from(
		new Set([
			...(snapshot.workerSessionIds ?? []),
			...Object.keys(workerStates),
			...(snapshot.features ?? []).flatMap((feature) =>
				feature.handoff?.workerId ? [feature.handoff.workerId] : [],
			),
		]),
	).sort();
	const tokenUsageBySessionId = snapshot.tokenUsageBySessionId ?? {};
	return {
		...snapshot,
		schemaVersion: MISSION_STORE_SCHEMA,
		missionId: sanitizeMissionId(snapshot.missionId),
		sourceMissionId:
			typeof snapshot.sourceMissionId === "string"
				? snapshot.sourceMissionId
				: undefined,
		features: snapshot.features ?? [],
		progressLog: snapshot.progressLog ?? [],
		workerSessionIds,
		workerStates,
		tokenUsageBySessionId,
		tokenUsage: sumMissionTokenUsage(tokenUsageBySessionId),
	};
}

export class MissionStore {
	private snapshot: MissionStoreSnapshot;
	private lastSavedSnapshot: MissionStoreSnapshot;
	private stateTouched = false;
	private readonly rootDir?: string;
	private readonly now: () => string;

	constructor(snapshot: MissionStoreSnapshot, config: MissionStoreConfig = {}) {
		this.snapshot = normalizeSnapshot(snapshot);
		this.lastSavedSnapshot = this.snapshot;
		this.rootDir = config.rootDir;
		this.now = config.now ?? (() => new Date().toISOString());
	}

	static create(options: {
		missionId: string;
		title?: string;
		manifest?: MissionManifest;
		config?: MissionStoreConfig;
	}): MissionStore {
		assertMissionCreateTargetAvailable(
			options.missionId,
			options.config?.rootDir,
		);
		return new MissionStore(
			createMissionStoreSnapshot({
				missionId: options.missionId,
				title: options.title,
				manifest: options.manifest,
				now: options.config?.now?.(),
			}),
			options.config,
		);
	}

	static load(
		missionId: string,
		config: MissionStoreConfig = {},
	): MissionStore {
		const path = getMissionStatePath(missionId, config.rootDir);
		if (!existsSync(path)) {
			throw new Error(`mission not found: ${sanitizeMissionId(missionId)}`);
		}
		const requestedId = normalizeMissionIdInput(missionId);
		const snapshot = readJsonFile<MissionStoreSnapshot>(path, {
			rotateOnParseFail: true,
		});
		if (
			snapshot.sourceMissionId?.trim() &&
			snapshot.sourceMissionId.trim() !== requestedId &&
			snapshot.missionId !== requestedId
		) {
			throw new Error(
				`missionId "${requestedId}" collides with existing mission "${snapshot.sourceMissionId.trim()}"`,
			);
		}
		return new MissionStore(
			applyArtifactFeaturesToSnapshot(snapshot, config.rootDir),
			config,
		);
	}

	getSnapshot(): MissionStoreSnapshot {
		return normalizeSnapshot(this.snapshot);
	}

	save(): MissionStoreSnapshot {
		const snapshot = this.getSnapshot();
		const path = getMissionStatePath(snapshot.missionId, this.rootDir);
		mkdirSync(getMissionDir(snapshot.missionId, this.rootDir), {
			recursive: true,
		});
		return withMissionStateLock(path, () => {
			assertNoMissionIdCollision(path, snapshot);
			const existing = existsSync(path)
				? normalizeSnapshot(readJsonFile<MissionStoreSnapshot>(path))
				: null;
			const merged = existing
				? mergeSnapshots(
						this.lastSavedSnapshot,
						snapshot,
						applyArtifactFeaturesToSnapshot(existing, this.rootDir),
						{ stateTouched: this.stateTouched },
					)
				: snapshot;
			try {
				writeJsonFile(path, merged);
				writeMissionManifest(merged, this.rootDir);
			} catch (error) {
				restoreMissionStateFile(path, existing);
				throw error;
			}
			this.snapshot = merged;
			this.lastSavedSnapshot = merged;
			this.stateTouched = false;
			return merged;
		});
	}

	setState(state: MissionState, message?: string): MissionStoreSnapshot {
		if (isTerminalMissionState(this.snapshot.state)) {
			if (this.snapshot.state !== state) {
				throw new Error(
					`mission ${this.snapshot.missionId} is already ${this.snapshot.state}`,
				);
			}
			return this.getSnapshot();
		}
		const timestamp = this.now();
		const progressType = stateToProgressType(state);
		const previousSnapshot = this.snapshot;
		const previousStateTouched = this.stateTouched;
		this.stateTouched = true;
		this.snapshot = {
			...this.snapshot,
			state,
			progressLog:
				progressType === "note" && !message?.trim()
					? this.snapshot.progressLog
					: [
							...this.snapshot.progressLog,
							{
								type: progressType,
								timestamp,
								message: message?.trim() || defaultStateProgressMessage(state),
							},
						],
			updatedAt: timestamp,
		};
		return this.saveOrRestore(previousSnapshot, previousStateTouched);
	}

	setFeatures(features: readonly MissionFeature[]): MissionStoreSnapshot {
		const previousSnapshot = this.snapshot;
		const previousStateTouched = this.stateTouched;
		this.snapshot = {
			...this.snapshot,
			features: [...features],
			updatedAt: this.now(),
		};
		return this.saveOrRestore(previousSnapshot, previousStateTouched);
	}

	appendProgress(
		entry: Omit<MissionProgressEntry, "timestamp"> & { timestamp?: string },
	): MissionStoreSnapshot {
		const timestamp = entry.timestamp ?? this.now();
		const previousSnapshot = this.snapshot;
		const previousStateTouched = this.stateTouched;
		this.snapshot = {
			...this.snapshot,
			progressLog: [...this.snapshot.progressLog, { ...entry, timestamp }],
			updatedAt: timestamp,
		};
		return this.saveOrRestore(previousSnapshot, previousStateTouched);
	}

	setSessionTokenUsage(
		sessionId: string,
		tokenUsage: MissionTokenUsage,
	): MissionStoreSnapshot {
		const previousSnapshot = this.snapshot;
		const previousStateTouched = this.stateTouched;
		this.snapshot = {
			...this.snapshot,
			tokenUsageBySessionId: {
				...this.snapshot.tokenUsageBySessionId,
				[sessionId]: tokenUsage,
			},
			updatedAt: this.now(),
		};
		return this.saveOrRestore(previousSnapshot, previousStateTouched);
	}

	private saveOrRestore(
		previousSnapshot: MissionStoreSnapshot,
		previousStateTouched: boolean,
	): MissionStoreSnapshot {
		try {
			return this.save();
		} catch (error) {
			this.snapshot = previousSnapshot;
			this.stateTouched = previousStateTouched;
			throw error;
		}
	}
}

function restoreMissionStateFile(
	path: string,
	previous: MissionStoreSnapshot | null,
): void {
	if (previous) {
		writeJsonFile(path, previous);
		return;
	}
	rmSync(path, { force: true });
}

function defaultStateProgressMessage(state: MissionState): string | undefined {
	switch (state) {
		case "running":
			return "Mission started";
		case "blocked":
			return "Mission is blocked";
		case "completed":
			return "Mission completed";
		default:
			return undefined;
	}
}

function withMissionStateLock<T>(path: string, operation: () => T): T {
	const lockPath = `${path}.lock`;
	const startedAt = Date.now();
	while (true) {
		try {
			mkdirSync(lockPath);
			writeMissionLockOwner(lockPath);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			if (recoverStaleMissionStateLock(lockPath)) continue;
			if (Date.now() - startedAt > 5000) {
				throw new Error(`timed out waiting for mission state lock: ${path}`);
			}
			sleepSync(25);
		}
	}
	try {
		return operation();
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

function writeMissionLockOwner(lockPath: string): void {
	try {
		writeJsonFile(join(lockPath, "owner.json"), {
			pid: process.pid,
			createdAt: new Date().toISOString(),
		});
	} catch {
		// Best-effort metadata: lock ownership should not make acquisition fail.
	}
}

function recoverStaleMissionStateLock(lockPath: string): boolean {
	try {
		const stats = statSync(lockPath);
		if (Date.now() - stats.mtimeMs <= MISSION_STATE_LOCK_STALE_MS) {
			return false;
		}
		const owner = readJsonFile<{ pid?: unknown } | null>(
			join(lockPath, "owner.json"),
			{ fallback: null },
		);
		if (typeof owner?.pid === "number" && isProcessAlive(owner.pid)) {
			return false;
		}
		rmSync(lockPath, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function sleepSync(ms: number): void {
	const buffer = new SharedArrayBuffer(4);
	Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function mergeSnapshots(
	base: MissionStoreSnapshot,
	intended: MissionStoreSnapshot,
	existing: MissionStoreSnapshot,
	options: { stateTouched?: boolean } = {},
): MissionStoreSnapshot {
	const state = mergeMissionState(
		base,
		intended,
		existing,
		options.stateTouched,
	);
	const progressLog = mergeProgressLog(
		existing.progressLog,
		base.progressLog,
		withoutRejectedStateTransitionProgress(
			base,
			intended,
			state,
			options.stateTouched,
		),
	);
	const tokenUsageBySessionId = { ...existing.tokenUsageBySessionId };
	for (const [sessionId, usage] of Object.entries(
		intended.tokenUsageBySessionId,
	)) {
		if (!jsonEqual(usage, base.tokenUsageBySessionId[sessionId])) {
			tokenUsageBySessionId[sessionId] = usage;
		}
	}
	return normalizeSnapshot({
		...existing,
		title: fieldChanged(intended.title, base.title)
			? intended.title
			: existing.title,
		state,
		features: mergeFeatures(
			base.features,
			intended.features,
			existing.features,
		),
		progressLog,
		tokenUsageBySessionId,
		updatedAt: maxIsoTimestamp(existing.updatedAt, intended.updatedAt),
	});
}

function withoutRejectedStateTransitionProgress(
	base: MissionStoreSnapshot,
	intended: MissionStoreSnapshot,
	mergedState: MissionState,
	stateTouched = false,
): readonly MissionProgressEntry[] {
	const intendedChanged =
		stateTouched || fieldChanged(intended.state, base.state);
	if (!intendedChanged || mergedState === intended.state) {
		return intended.progressLog;
	}
	const lastEntry = intended.progressLog.at(-1);
	if (!lastEntry) return intended.progressLog;
	const baseKeys = new Set(base.progressLog.map(progressEntryKey));
	if (
		baseKeys.has(progressEntryKey(lastEntry)) ||
		lastEntry.timestamp !== intended.updatedAt ||
		lastEntry.type !== stateToProgressType(intended.state)
	) {
		return intended.progressLog;
	}
	return intended.progressLog.slice(0, -1);
}

function mergeMissionState(
	base: MissionStoreSnapshot,
	intended: MissionStoreSnapshot,
	existing: MissionStoreSnapshot,
	stateTouched = false,
): MissionState {
	const intendedChanged =
		stateTouched || fieldChanged(intended.state, base.state);
	if (!intendedChanged) {
		return existing.state;
	}
	if (
		isTerminalMissionState(existing.state) &&
		existing.state !== intended.state
	) {
		return existing.state;
	}
	if (
		!fieldChanged(existing.state, base.state) ||
		jsonEqual(intended.state, existing.state)
	) {
		return intended.state;
	}
	return existing.state;
}

function isTerminalMissionState(state: MissionState): boolean {
	return state === "completed" || state === "failed";
}

function mergeFeatures(
	base: readonly MissionFeature[],
	intended: readonly MissionFeature[],
	existing: readonly MissionFeature[],
): MissionFeature[] {
	const baseById = new Map(
		base.map((feature) => [feature.id, feature] as const),
	);
	const intendedById = new Map(
		intended.map((feature) => [feature.id, feature] as const),
	);
	const existingById = new Map(
		existing.map((feature) => [feature.id, feature] as const),
	);
	const orderedIds = Array.from(
		new Set([
			...existing.map((feature) => feature.id),
			...intended.map((feature) => feature.id),
		]),
	);
	const merged: MissionFeature[] = [];
	for (const featureId of orderedIds) {
		const baseFeature = baseById.get(featureId);
		const intendedFeature = intendedById.get(featureId);
		const existingFeature = existingById.get(featureId);
		const intendedChanged = !jsonEqual(intendedFeature, baseFeature);
		const existingChanged = !jsonEqual(existingFeature, baseFeature);
		if (!intendedChanged) {
			if (existingFeature) merged.push(existingFeature);
			continue;
		}
		if (!existingChanged || jsonEqual(intendedFeature, existingFeature)) {
			if (intendedFeature) merged.push(intendedFeature);
			continue;
		}
		throw new Error(
			`mission feature ${featureId} changed concurrently; reload before saving`,
		);
	}
	return merged;
}

function mergeProgressLog(
	existing: readonly MissionProgressEntry[],
	base: readonly MissionProgressEntry[],
	intended: readonly MissionProgressEntry[],
): MissionProgressEntry[] {
	const baseKeys = new Set(base.map(progressEntryKey));
	const existingKeys = new Set(existing.map(progressEntryKey));
	const next = [...existing];
	for (const entry of intended) {
		const key = progressEntryKey(entry);
		if (baseKeys.has(key) || existingKeys.has(key)) continue;
		next.push(entry);
		existingKeys.add(key);
	}
	return next.sort((left, right) =>
		left.timestamp.localeCompare(right.timestamp),
	);
}

function progressEntryKey(entry: MissionProgressEntry): string {
	return JSON.stringify(entry);
}

function fieldChanged<T>(intended: T, base: T): boolean {
	return !jsonEqual(intended, base);
}

function jsonEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function maxIsoTimestamp(left: string, right: string): string {
	return left.localeCompare(right) >= 0 ? left : right;
}

function stateToProgressType(
	state: MissionState,
): MissionProgressEntry["type"] {
	switch (state) {
		case "running":
			return "mission_started";
		case "blocked":
			return "mission_blocked";
		case "completed":
			return "mission_completed";
		default:
			return "note";
	}
}

export function listMissionStoreSnapshots(
	rootDir?: string,
): MissionStoreSnapshot[] {
	const root = getMissionStoreRoot(rootDir);
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.flatMap((entry) => {
			try {
				const path = join(root, entry.name, "state.json");
				if (!existsSync(path)) return [];
				const snapshot = readJsonFile<MissionStoreSnapshot | null>(path, {
					fallback: null,
					rotateOnParseFail: true,
				});
				return snapshot
					? [normalizeSnapshot(applyArtifactFeaturesToSnapshot(snapshot, root))]
					: [];
			} catch {
				return [];
			}
		})
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function applyArtifactFeaturesToSnapshot(
	snapshot: MissionStoreSnapshot,
	rootDir?: string,
): MissionStoreSnapshot {
	const featuresPath = join(
		getMissionDir(snapshot.missionId, rootDir),
		"features.json",
	);
	if (!existsSync(featuresPath)) return snapshot;
	const manifest = readJsonFile<MissionManifest | null>(featuresPath, {
		fallback: null,
		rotateOnParseFail: true,
	});
	const features = getValidArtifactFeatures(manifest, snapshot);
	return features
		? {
				...snapshot,
				features,
				updatedAt:
					typeof (manifest as { updatedAt?: unknown }).updatedAt === "string"
						? (manifest as { updatedAt: string }).updatedAt
						: snapshot.updatedAt,
			}
		: snapshot;
}

function getValidArtifactFeatures(
	value: unknown,
	snapshot: MissionStoreSnapshot,
): MissionFeature[] | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (typeof record.version !== "number") return null;
	if (typeof record.missionId !== "string") return null;
	let missionId: string;
	try {
		missionId = sanitizeMissionId(record.missionId);
	} catch {
		return null;
	}
	if (missionId !== snapshot.missionId) return null;
	if (
		typeof record.updatedAt !== "string" ||
		Number.isNaN(Date.parse(record.updatedAt)) ||
		Date.parse(record.updatedAt) < Date.parse(snapshot.updatedAt)
	) {
		return null;
	}
	if (!Array.isArray(record.features)) return null;
	if (record.features.length === 0 && snapshot.features.length > 0) return null;
	const featureIds = new Set<string>();
	for (const feature of record.features) {
		if (!isMissionFeature(feature)) return null;
		if (featureIds.has(feature.id)) return null;
		featureIds.add(feature.id);
	}
	return record.features as MissionFeature[];
}

function assertNoMissionIdCollision(
	path: string,
	snapshot: MissionStoreSnapshot,
): void {
	if (!existsSync(path)) return;
	const existing = readJsonFile<MissionStoreSnapshot | null>(path, {
		fallback: null,
	});
	if (!existing?.sourceMissionId || !snapshot.sourceMissionId) return;
	if (existing.sourceMissionId !== snapshot.sourceMissionId) {
		throw new Error(
			`missionId collision: ${snapshot.sourceMissionId} maps to existing mission ${existing.sourceMissionId}`,
		);
	}
}

function assertMissionCreateTargetAvailable(
	missionId: string,
	rootDir?: string,
): void {
	const statePath = getMissionStatePath(missionId, rootDir);
	if (existsSync(statePath)) {
		const snapshot = readJsonFile<MissionStoreSnapshot>(statePath, {
			rotateOnParseFail: true,
		});
		const requestedId = normalizeMissionIdInput(missionId);
		if (
			snapshot.sourceMissionId?.trim() &&
			snapshot.sourceMissionId.trim() !== requestedId
		) {
			throw new Error(
				`missionId "${requestedId}" collides with existing mission "${snapshot.sourceMissionId.trim()}"`,
			);
		}
		throw new Error(`mission already exists: ${sanitizeMissionId(missionId)}`);
	}
	const missionDir = getMissionDir(missionId, rootDir);
	if (existsSync(missionDir) && readdirSync(missionDir).length > 0) {
		throw new Error(
			`mission already exists without durable state: ${sanitizeMissionId(missionId)}`,
		);
	}
}

function writeMissionManifest(
	snapshot: MissionStoreSnapshot,
	rootDir?: string,
): void {
	const path = join(
		getMissionDir(snapshot.missionId, rootDir),
		"features.json",
	);
	const existing = readJsonFile<MissionManifest | null>(path, {
		fallback: null,
		rotateOnParseFail: true,
	});
	if (isNewerMissionManifest(existing, snapshot)) return;
	writeJsonFile(path, {
		version:
			typeof existing?.version === "number"
				? existing.version
				: MISSION_MANIFEST_VERSION,
		missionId: snapshot.missionId,
		milestones: Array.isArray(existing?.milestones) ? existing.milestones : [],
		features: snapshot.features,
		createdAt:
			typeof existing?.createdAt === "string"
				? existing.createdAt
				: snapshot.createdAt,
		updatedAt: snapshot.updatedAt,
	});
}

function isNewerMissionManifest(
	manifest: MissionManifest | null,
	snapshot: MissionStoreSnapshot,
): boolean {
	return Boolean(
		getValidArtifactFeatures(manifest, snapshot) &&
			typeof manifest?.updatedAt === "string" &&
			Date.parse(manifest.updatedAt) > Date.parse(snapshot.updatedAt),
	);
}
