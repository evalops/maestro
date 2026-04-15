import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { PATHS } from "../config/constants.js";
import { readJsonFile, writeJsonFile } from "../utils/fs.js";

export interface ProjectOnboardingStep {
	key: "workspace" | "instructions";
	text: string;
	isComplete: boolean;
	isEnabled: boolean;
}

export interface ProjectOnboardingState {
	shouldShow: boolean;
	completed: boolean;
	seenCount: number;
	steps: ProjectOnboardingStep[];
}

interface StoredProjectOnboardingEntry {
	seenCount: number;
	completed: boolean;
	updatedAt: string;
}

interface StoredProjectOnboardingStore {
	version: 1;
	projects: Record<string, StoredProjectOnboardingEntry>;
}

const EMPTY_PROJECT_ONBOARDING_STORE: StoredProjectOnboardingStore = {
	version: 1,
	projects: {},
};

const MAX_PROJECT_ONBOARDING_IMPRESSIONS = 4;
const IGNORED_EMPTY_WORKSPACE_ENTRIES = new Set([
	".DS_Store",
	".git",
	".gitignore",
	".maestro",
	"Thumbs.db",
	...PATHS.AGENT_CONTEXT_FILES,
]);

const seenProjectsInProcess = new Set<string>();

function normalizeProjectOnboardingStore(
	raw: unknown,
): StoredProjectOnboardingStore {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return EMPTY_PROJECT_ONBOARDING_STORE;
	}

	const candidate = raw as {
		version?: unknown;
		projects?: unknown;
	};
	if (candidate.version !== 1) {
		return EMPTY_PROJECT_ONBOARDING_STORE;
	}

	const projects =
		candidate.projects && typeof candidate.projects === "object"
			? candidate.projects
			: {};
	const normalizedProjects: StoredProjectOnboardingStore["projects"] = {};

	for (const [projectRoot, entry] of Object.entries(projects)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			continue;
		}
		const candidateEntry = entry as {
			seenCount?: unknown;
			completed?: unknown;
			updatedAt?: unknown;
		};
		if (
			typeof candidateEntry.seenCount !== "number" ||
			!Number.isFinite(candidateEntry.seenCount) ||
			typeof candidateEntry.completed !== "boolean" ||
			typeof candidateEntry.updatedAt !== "string"
		) {
			continue;
		}
		normalizedProjects[projectRoot] = {
			seenCount: Math.max(0, Math.trunc(candidateEntry.seenCount)),
			completed: candidateEntry.completed,
			updatedAt: candidateEntry.updatedAt,
		};
	}

	return {
		version: 1,
		projects: normalizedProjects,
	};
}

function readProjectOnboardingStore(): StoredProjectOnboardingStore {
	return normalizeProjectOnboardingStore(
		readJsonFile<unknown>(PATHS.PROJECT_ONBOARDING_FILE, {
			fallback: EMPTY_PROJECT_ONBOARDING_STORE,
		}),
	);
}

function writeProjectOnboardingStore(
	store: StoredProjectOnboardingStore,
): void {
	writeJsonFile(PATHS.PROJECT_ONBOARDING_FILE, store);
}

function getProjectKey(projectRoot: string): string {
	return resolve(projectRoot);
}

function hasProjectInstructions(projectRoot: string): boolean {
	return PATHS.AGENT_CONTEXT_FILES.some((fileName) =>
		existsSync(join(projectRoot, fileName)),
	);
}

function isWorkspaceEffectivelyEmpty(projectRoot: string): boolean {
	try {
		const entries = readdirSync(projectRoot, { withFileTypes: true });
		return !entries.some(
			(entry) => !IGNORED_EMPTY_WORKSPACE_ENTRIES.has(entry.name),
		);
	} catch {
		return false;
	}
}

function computeProjectOnboardingSteps(
	projectRoot: string,
): ProjectOnboardingStep[] {
	const workspaceEmpty = isWorkspaceEffectivelyEmpty(projectRoot);
	const hasInstructions = hasProjectInstructions(projectRoot);

	return [
		{
			key: "workspace",
			text: "Ask Maestro to create a new app or clone a repository.",
			isComplete: !workspaceEmpty,
			isEnabled: workspaceEmpty,
		},
		{
			key: "instructions",
			text: "Run /init to scaffold AGENTS.md instructions for this project.",
			isComplete: hasInstructions,
			isEnabled: !workspaceEmpty,
		},
	];
}

function persistProjectOnboardingEntry(
	projectKey: string,
	entry: StoredProjectOnboardingEntry,
): void {
	const store = readProjectOnboardingStore();
	store.projects[projectKey] = entry;
	writeProjectOnboardingStore(store);
}

export function getProjectOnboardingState(
	projectRoot = process.cwd(),
): ProjectOnboardingState {
	const projectKey = getProjectKey(projectRoot);
	const store = readProjectOnboardingStore();
	const stored = store.projects[projectKey];
	const steps = computeProjectOnboardingSteps(projectRoot);
	const enabledSteps = steps.filter((step) => step.isEnabled);
	const computedCompleted =
		enabledSteps.length > 0 && enabledSteps.every((step) => step.isComplete);
	const completed = stored?.completed === true || computedCompleted;

	if (computedCompleted && stored?.completed !== true) {
		persistProjectOnboardingEntry(projectKey, {
			seenCount: stored?.seenCount ?? 0,
			completed: true,
			updatedAt: new Date().toISOString(),
		});
	}

	const seenCount = stored?.seenCount ?? 0;
	const shouldShow =
		!completed &&
		seenCount < MAX_PROJECT_ONBOARDING_IMPRESSIONS &&
		enabledSteps.some((step) => !step.isComplete);

	return {
		shouldShow,
		completed,
		seenCount,
		steps,
	};
}

export function markProjectOnboardingSeen(projectRoot = process.cwd()): void {
	const projectKey = getProjectKey(projectRoot);
	if (seenProjectsInProcess.has(projectKey)) {
		return;
	}

	const state = getProjectOnboardingState(projectRoot);
	if (!state.shouldShow) {
		return;
	}

	const store = readProjectOnboardingStore();
	const stored = store.projects[projectKey];
	store.projects[projectKey] = {
		seenCount: Math.min(
			MAX_PROJECT_ONBOARDING_IMPRESSIONS,
			(stored?.seenCount ?? 0) + 1,
		),
		completed: stored?.completed ?? state.completed,
		updatedAt: new Date().toISOString(),
	};
	writeProjectOnboardingStore(store);
	seenProjectsInProcess.add(projectKey);
}
