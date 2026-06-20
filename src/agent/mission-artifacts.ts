import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import YAML from "yaml";
import { writeJsonFile, writeTextFileAtomic } from "../utils/fs.js";
import { isRecord } from "../utils/json.js";
import { isMissionFeature } from "./mission-manifest.js";
import {
	MISSION_STORE_SCHEMA,
	type MissionStoreSnapshot,
	getMissionDir,
	getMissionStoreRoot,
	sanitizeMissionId,
} from "./mission-store.js";

export const MISSION_ARTIFACT_VERSION = 1;

export type MissionSessionRole = "orchestrator" | "worker" | "validator";

export interface MissionArtifactLayout {
	missionDir: string;
	missionMarkdown: string;
	architectureMarkdown: string;
	validationContractMarkdown: string;
	validationStateJson: string;
	featuresJson: string;
	agentsMarkdown: string;
	servicesYaml: string;
	handoffsDir: string;
	libraryDir: string;
	skillsDir: string;
	stateJson: string;
	progressLogJsonl: string;
	modelSettingsJson: string;
}

export type MissionArtifactKind =
	| "mission"
	| "architecture"
	| "validation-contract"
	| "validation-state"
	| "features"
	| "agents"
	| "services"
	| "state"
	| "progress-log"
	| "model-settings"
	| "handoff"
	| "library"
	| "skill";

export interface MissionArtifactClassification {
	kind: MissionArtifactKind;
	path: string;
	missionDir: string;
}

const MISSION_ARTIFACT_ESCAPE_MESSAGE =
	"Mission artifact path resolves outside the mission store.";

export function getMissionArtifactLayout(
	missionId: string,
	rootDir?: string,
): MissionArtifactLayout {
	const missionDir = getMissionDir(missionId, rootDir);
	return {
		missionDir,
		missionMarkdown: join(missionDir, "mission.md"),
		architectureMarkdown: join(missionDir, "architecture.md"),
		validationContractMarkdown: join(missionDir, "validation-contract.md"),
		validationStateJson: join(missionDir, "validation-state.json"),
		featuresJson: join(missionDir, "features.json"),
		agentsMarkdown: join(missionDir, "AGENTS.md"),
		servicesYaml: join(missionDir, "services.yaml"),
		handoffsDir: join(missionDir, "handoffs"),
		libraryDir: join(missionDir, "library"),
		skillsDir: join(missionDir, "skills"),
		stateJson: join(missionDir, "state.json"),
		progressLogJsonl: join(missionDir, "progress_log.jsonl"),
		modelSettingsJson: join(missionDir, "model-settings.json"),
	};
}

export function initializeMissionArtifacts(options: {
	missionId: string;
	title?: string;
	rootDir?: string;
	now?: string;
}): MissionArtifactLayout {
	const now = options.now ?? new Date().toISOString();
	const missionId = sanitizeMissionId(options.missionId);
	const layout = getMissionArtifactLayout(missionId, options.rootDir);
	mkdirSync(layout.handoffsDir, { recursive: true });
	mkdirSync(layout.libraryDir, { recursive: true });
	mkdirSync(layout.skillsDir, { recursive: true });
	if (!existsSync(layout.missionMarkdown)) {
		writeTextFileAtomic(
			layout.missionMarkdown,
			`# ${options.title ?? missionId}\n\nCreated: ${now}\n\n## Objective\n\nTBD\n`,
		);
	}
	if (!existsSync(layout.architectureMarkdown)) {
		writeTextFileAtomic(
			layout.architectureMarkdown,
			"# Architecture\n\nDocument system boundaries, responsibilities, and invariants here.\n",
		);
	}
	if (!existsSync(layout.validationContractMarkdown)) {
		writeTextFileAtomic(
			layout.validationContractMarkdown,
			"# Validation Contract\n\nAdd durable behavioral assertions before decomposing features.\n",
		);
	}
	if (!existsSync(layout.validationStateJson)) {
		writeJsonFile(layout.validationStateJson, {
			version: MISSION_ARTIFACT_VERSION,
			assertions: {},
			updatedAt: now,
		});
	}
	if (!existsSync(layout.featuresJson)) {
		writeJsonFile(layout.featuresJson, {
			version: MISSION_ARTIFACT_VERSION,
			missionId,
			milestones: [],
			features: [],
			createdAt: now,
			updatedAt: now,
		});
	}
	if (!existsSync(layout.agentsMarkdown)) {
		writeTextFileAtomic(
			layout.agentsMarkdown,
			"# Mission Agent Guidance\n\nKeep worker guidance, known constraints, and validation notes here.\n",
		);
	}
	if (!existsSync(layout.servicesYaml)) {
		writeTextFileAtomic(
			layout.servicesYaml,
			"version: 1\ncommands: {}\nservices: {}\n",
		);
	}
	return layout;
}

export function classifyMissionArtifactPath(
	filePath: string,
	rootDir?: string,
): MissionArtifactClassification | null {
	const resolved = resolveMissionArtifactPath(filePath, rootDir);
	if (!resolved.isWithinMissionStore || resolved.escapesMissionStore) {
		return null;
	}
	const afterRoot = resolved.realArtifactPath.slice(
		resolved.realMissionStoreRoot.length + 1,
	);
	const missionId = afterRoot.split(sep)[0];
	if (!missionId) return null;
	const missionDir = join(resolved.realMissionStoreRoot, missionId);
	const rel = resolved.realArtifactPath.slice(missionDir.length + 1);
	const file = basename(resolved.realArtifactPath);
	const nestedKind = rel.startsWith(`handoffs${sep}`)
		? "handoff"
		: rel.startsWith(`library${sep}`)
			? "library"
			: rel.startsWith(`skills${sep}`)
				? "skill"
				: null;
	if (nestedKind) {
		return { kind: nestedKind, path: resolved.absolutePath, missionDir };
	}
	const kind =
		file === "mission.md"
			? "mission"
			: file === "architecture.md"
				? "architecture"
				: file === "validation-contract.md"
					? "validation-contract"
					: file === "validation-state.json"
						? "validation-state"
						: file === "features.json"
							? "features"
							: file === "AGENTS.md"
								? "agents"
								: file === "services.yaml" || file === "services.yml"
									? "services"
									: file === "state.json"
										? "state"
										: file === "progress_log.jsonl"
											? "progress-log"
											: file === "model-settings.json"
												? "model-settings"
												: null;
	return kind ? { kind, path: resolved.absolutePath, missionDir } : null;
}

export function validateMissionArtifactContent(
	filePath: string,
	content: string,
	rootDir?: string,
): { ok: true } | { ok: false; message: string } {
	const resolved = resolveMissionArtifactPath(filePath, rootDir);
	if (resolved.escapesMissionStore) {
		return { ok: false, message: MISSION_ARTIFACT_ESCAPE_MESSAGE };
	}
	const classified = classifyMissionArtifactPath(filePath, rootDir);
	if (!classified) return { ok: true };
	try {
		switch (classified.kind) {
			case "features":
				validateFeaturesJson(
					JSON.parse(content),
					basename(classified.missionDir),
				);
				return { ok: true };
			case "validation-state":
			case "model-settings":
			case "handoff":
				JSON.parse(content);
				return { ok: true };
			case "state":
				validateMissionStateJson(
					JSON.parse(content),
					basename(classified.missionDir),
				);
				return { ok: true };
			case "progress-log":
				for (const [index, line] of content.split(/\r?\n/u).entries()) {
					if (!line.trim()) continue;
					try {
						JSON.parse(line);
					} catch {
						return {
							ok: false,
							message: `Invalid JSONL at line ${index + 1}`,
						};
					}
				}
				return { ok: true };
			case "services":
				YAML.parse(content);
				return { ok: true };
			default:
				return { ok: true };
		}
	} catch (error) {
		return {
			ok: false,
			message:
				error instanceof Error
					? error.message
					: `Invalid mission artifact ${classified.kind}`,
		};
	}
}

export function validateMissionArtifactWrite(options: {
	filePath: string;
	content: string;
	role?: MissionSessionRole;
	rootDir?: string;
}): { ok: true } | { ok: false; message: string } {
	const resolved = resolveMissionArtifactPath(
		options.filePath,
		options.rootDir,
	);
	if (resolved.escapesMissionStore) {
		return { ok: false, message: MISSION_ARTIFACT_ESCAPE_MESSAGE };
	}
	const classified = classifyMissionArtifactPath(
		options.filePath,
		options.rootDir,
	);
	if (!classified) return { ok: true };
	if (
		classified.kind === "state" ||
		classified.kind === "progress-log" ||
		classified.kind === "model-settings"
	) {
		return {
			ok: false,
			message:
				"Cannot write mission system files directly; use MissionStore APIs.",
		};
	}
	if (
		(options.role === "worker" || options.role === "validator") &&
		classified.kind === "features"
	) {
		return {
			ok: false,
			message:
				"Mission workers and validators cannot write features.json; return a handoff to the orchestrator.",
		};
	}
	return validateMissionArtifactContent(
		options.filePath,
		options.content,
		options.rootDir,
	);
}

export function validateMissionArtifactDelete(options: {
	filePath: string;
	rootDir?: string;
}): { ok: true } | { ok: false; message: string } {
	const resolved = resolveMissionArtifactPath(
		options.filePath,
		options.rootDir,
	);
	if (resolved.escapesMissionStore) {
		return { ok: false, message: MISSION_ARTIFACT_ESCAPE_MESSAGE };
	}
	const classified = classifyMissionArtifactPath(
		options.filePath,
		options.rootDir,
	);
	if (!classified) return { ok: true };
	if (
		classified.kind === "handoff" ||
		classified.kind === "library" ||
		classified.kind === "skill"
	) {
		return { ok: true };
	}
	return {
		ok: false,
		message: `Cannot delete required mission artifact ${basename(classified.path)}.`,
	};
}

export function detectMissionSessionRole(
	env: NodeJS.ProcessEnv = process.env,
): MissionSessionRole | undefined {
	const raw = env.MAESTRO_MISSION_ROLE?.trim().toLowerCase();
	if (raw === "orchestrator" || raw === "worker" || raw === "validator") {
		return raw;
	}
	if (env.MAESTRO_MISSION_WORKER === "1") return "worker";
	if (env.MAESTRO_MISSION_VALIDATOR === "1") return "validator";
	return undefined;
}

export function summarizeMissionSnapshot(
	snapshot: MissionStoreSnapshot,
): string {
	const counts = snapshot.features.reduce(
		(acc, feature) => {
			acc.total += 1;
			acc[feature.status] = (acc[feature.status] ?? 0) + 1;
			return acc;
		},
		{ total: 0 } as { total: number } & Record<string, number>,
	);
	return [
		`${snapshot.title ?? snapshot.missionId} (${snapshot.state})`,
		`features: ${counts.total} total, ${counts.pending ?? 0} pending, ${counts["in-progress"] ?? 0} running, ${counts.passed ?? 0} passed, ${counts.failed ?? 0} failed`,
		`workers: ${snapshot.workerSessionIds.length}`,
	].join("\n");
}

function validateFeaturesJson(value: unknown, expectedMissionId: string): void {
	if (!value || typeof value !== "object") {
		throw new Error("features.json must be a JSON object");
	}
	const record = value as Record<string, unknown>;
	if (typeof record.version !== "number") {
		throw new Error("features.json requires numeric version");
	}
	if (typeof record.missionId !== "string" || !record.missionId.trim()) {
		throw new Error("features.json requires missionId");
	}
	if (sanitizeMissionId(record.missionId) !== expectedMissionId) {
		throw new Error(
			`features.json missionId ${record.missionId} does not match mission directory ${expectedMissionId}`,
		);
	}
	if (
		typeof record.updatedAt !== "string" ||
		Number.isNaN(Date.parse(record.updatedAt))
	) {
		throw new Error("features.json requires valid updatedAt");
	}
	if (!Array.isArray(record.features)) {
		throw new Error("features.json requires features array");
	}
	const featureIds = new Set<string>();
	for (const [index, feature] of record.features.entries()) {
		if (!feature || typeof feature !== "object") {
			throw new Error(`feature ${index} must be an object`);
		}
		if (!isMissionFeature(feature)) {
			throw new Error(`feature ${index} must match MissionFeature schema`);
		}
		const featureId = (feature as { id: string }).id;
		if (featureIds.has(featureId)) {
			throw new Error(
				`features.json contains duplicate feature id ${featureId}`,
			);
		}
		featureIds.add(featureId);
	}
}

function validateMissionStateJson(
	value: unknown,
	expectedMissionId: string,
): void {
	if (!value || typeof value !== "object") {
		throw new Error("state.json must be a JSON object");
	}
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== MISSION_STORE_SCHEMA) {
		throw new Error("state.json requires mission store schemaVersion");
	}
	if (typeof record.missionId !== "string" || !record.missionId.trim()) {
		throw new Error("state.json requires missionId");
	}
	if (sanitizeMissionId(record.missionId) !== expectedMissionId) {
		throw new Error(
			`state.json missionId ${record.missionId} does not match mission directory ${expectedMissionId}`,
		);
	}
	if (!isMissionState(record.state)) {
		throw new Error("state.json requires valid state");
	}
	if (
		!Array.isArray(record.features) ||
		!record.features.every(isMissionFeature)
	) {
		throw new Error("state.json requires valid features array");
	}
	const featureIds = new Set<string>();
	for (const feature of record.features) {
		const featureId = (feature as { id: string }).id;
		if (featureIds.has(featureId)) {
			throw new Error(`state.json contains duplicate feature id ${featureId}`);
		}
		featureIds.add(featureId);
	}
	if (!Array.isArray(record.progressLog)) {
		throw new Error("state.json requires progressLog array");
	}
	for (const [index, entry] of record.progressLog.entries()) {
		if (!isMissionProgressEntry(entry)) {
			throw new Error(`state.json progressLog ${index} must be valid`);
		}
	}
	if (!Array.isArray(record.workerSessionIds)) {
		throw new Error("state.json requires workerSessionIds array");
	}
	if (!isRecord(record.workerStates)) {
		throw new Error("state.json requires workerStates object");
	}
	if (!isRecord(record.tokenUsageBySessionId)) {
		throw new Error("state.json requires tokenUsageBySessionId object");
	}
	for (const [sessionId, usage] of Object.entries(
		record.tokenUsageBySessionId,
	)) {
		if (!isMissionTokenUsage(usage)) {
			throw new Error(
				`state.json tokenUsageBySessionId ${sessionId} must be valid`,
			);
		}
	}
	if (
		record.tokenUsage !== undefined &&
		!isMissionTokenUsage(record.tokenUsage)
	) {
		throw new Error("state.json tokenUsage must be valid");
	}
	if (
		typeof record.createdAt !== "string" ||
		Number.isNaN(Date.parse(record.createdAt)) ||
		typeof record.updatedAt !== "string" ||
		Number.isNaN(Date.parse(record.updatedAt))
	) {
		throw new Error("state.json requires valid timestamps");
	}
}

function isMissionState(value: unknown): boolean {
	return (
		value === "awaiting-input" ||
		value === "ready" ||
		value === "running" ||
		value === "blocked" ||
		value === "completed" ||
		value === "failed"
	);
}

function isMissionProgressEntry(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (
		value.type !== "mission_created" &&
		value.type !== "mission_started" &&
		value.type !== "mission_blocked" &&
		value.type !== "mission_completed" &&
		value.type !== "worker_started" &&
		value.type !== "worker_completed" &&
		value.type !== "worker_failed" &&
		value.type !== "note"
	) {
		return false;
	}
	if (
		typeof value.timestamp !== "string" ||
		Number.isNaN(Date.parse(value.timestamp))
	) {
		return false;
	}
	if (value.message !== undefined && typeof value.message !== "string") {
		return false;
	}
	if (value.featureId !== undefined && typeof value.featureId !== "string") {
		return false;
	}
	if (
		value.workerSessionId !== undefined &&
		typeof value.workerSessionId !== "string"
	) {
		return false;
	}
	if (value.exitCode !== undefined && typeof value.exitCode !== "number") {
		return false;
	}
	return true;
}

function isMissionTokenUsage(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (
		typeof value.inputTokens !== "number" ||
		typeof value.outputTokens !== "number"
	) {
		return false;
	}
	if (
		value.cacheCreationTokens !== undefined &&
		typeof value.cacheCreationTokens !== "number"
	) {
		return false;
	}
	if (
		value.cacheReadTokens !== undefined &&
		typeof value.cacheReadTokens !== "number"
	) {
		return false;
	}
	if (
		value.thinkingTokens !== undefined &&
		typeof value.thinkingTokens !== "number"
	) {
		return false;
	}
	if (value.credits !== undefined && typeof value.credits !== "number") {
		return false;
	}
	return true;
}

function resolveMissionArtifactPath(
	filePath: string,
	rootDir?: string,
): {
	absolutePath: string;
	missionStoreRoot: string;
	realMissionStoreRoot: string;
	realArtifactPath: string;
	isWithinMissionStore: boolean;
	escapesMissionStore: boolean;
} {
	const absolutePath = normalize(resolve(filePath));
	const missionStoreRoot = normalize(resolve(getMissionStoreRoot(rootDir)));
	const realMissionStoreRoot =
		resolveRealPathThroughExistingParents(missionStoreRoot) ?? missionStoreRoot;
	const realArtifactPath =
		resolveRealPathThroughExistingParents(absolutePath) ?? absolutePath;
	const isLexicallyWithinMissionStore = isPathInside(
		missionStoreRoot,
		absolutePath,
	);
	const isReallyWithinMissionStore = isPathInside(
		realMissionStoreRoot,
		realArtifactPath,
	);
	const isWithinMissionStore =
		isLexicallyWithinMissionStore || isReallyWithinMissionStore;
	return {
		absolutePath,
		missionStoreRoot,
		realMissionStoreRoot,
		realArtifactPath,
		isWithinMissionStore,
		escapesMissionStore:
			isLexicallyWithinMissionStore && !isReallyWithinMissionStore,
	};
}

function resolveRealPathThroughExistingParents(
	absolutePath: string,
): string | null {
	const suffix: string[] = [];
	let current = absolutePath;
	while (true) {
		if (existsSync(current)) {
			try {
				const realCurrent = realpathSync(current);
				return suffix.length === 0
					? realCurrent
					: join(realCurrent, ...suffix.reverse());
			} catch {
				return null;
			}
		}
		const parent = dirname(current);
		if (parent === current) {
			return null;
		}
		suffix.push(basename(current));
		current = parent;
	}
}

function isPathInside(root: string, target: string): boolean {
	return target === root || target.startsWith(`${root}${sep}`);
}
