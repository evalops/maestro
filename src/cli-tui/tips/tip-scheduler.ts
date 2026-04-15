import { PATHS } from "../../config/constants.js";
import { getProjectOnboardingState } from "../../onboarding/project-onboarding.js";
import { fileExists, readJsonFile, writeJsonFile } from "../../utils/fs.js";

export interface LoaderTipContext {
	projectRoot?: string;
}

export interface LoaderTipDefinition {
	id: string;
	content: string;
	cooldownSessions: number;
	isRelevant: (context: LoaderTipContext) => boolean;
}

interface TipHistoryStore {
	version: 1;
	launchCount: number;
	lastShownLaunchByTip: Record<string, number>;
}

const EMPTY_TIP_HISTORY_STORE: TipHistoryStore = {
	version: 1,
	launchCount: 0,
	lastShownLaunchByTip: {},
};

const loaderTips: LoaderTipDefinition[] = [
	{
		id: "project-workspace",
		content: "Ask Maestro to create a new app or clone a repository.",
		cooldownSessions: 3,
		isRelevant: (context) => {
			const workspaceStep = getProjectOnboardingState(
				context.projectRoot,
			).steps.find((step) => step.key === "workspace");
			return Boolean(workspaceStep?.isEnabled && !workspaceStep.isComplete);
		},
	},
	{
		id: "project-init",
		content: "Run /init to scaffold AGENTS.md instructions for this project.",
		cooldownSessions: 4,
		isRelevant: (context) => {
			const instructionsStep = getProjectOnboardingState(
				context.projectRoot,
			).steps.find((step) => step.key === "instructions");
			return Boolean(
				instructionsStep?.isEnabled && !instructionsStep.isComplete,
			);
		},
	},
	{
		id: "hotkeys-init",
		content: "Run /hotkeys init to create a starter keyboard shortcuts config.",
		cooldownSessions: 5,
		isRelevant: () => !fileExists(PATHS.TUI_KEYBINDINGS_FILE),
	},
	{
		id: "memory-command",
		content: "Use /memory to search and manage durable memory.",
		cooldownSessions: 6,
		isRelevant: () => true,
	},
	{
		id: "slash-commands",
		content: "Type / to browse commands, settings, and diagnostics.",
		cooldownSessions: 7,
		isRelevant: () => true,
	},
	{
		id: "queued-follow-up",
		content: "Press Tab while Maestro is working to queue a follow-up.",
		cooldownSessions: 8,
		isRelevant: () => true,
	},
];

let activeLaunchNumber: number | null = null;
const shownTipsThisLaunch = new Set<string>();

function normalizeTipHistoryStore(raw: unknown): TipHistoryStore {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return EMPTY_TIP_HISTORY_STORE;
	}
	const candidate = raw as {
		version?: unknown;
		launchCount?: unknown;
		lastShownLaunchByTip?: unknown;
	};
	if (
		candidate.version !== 1 ||
		typeof candidate.launchCount !== "number" ||
		!Number.isFinite(candidate.launchCount) ||
		!candidate.lastShownLaunchByTip ||
		typeof candidate.lastShownLaunchByTip !== "object" ||
		Array.isArray(candidate.lastShownLaunchByTip)
	) {
		return EMPTY_TIP_HISTORY_STORE;
	}

	const lastShownLaunchByTip: Record<string, number> = {};
	for (const [tipId, launch] of Object.entries(
		candidate.lastShownLaunchByTip,
	)) {
		if (typeof launch === "number" && Number.isFinite(launch)) {
			lastShownLaunchByTip[tipId] = Math.max(0, Math.trunc(launch));
		}
	}

	return {
		version: 1,
		launchCount: Math.max(0, Math.trunc(candidate.launchCount)),
		lastShownLaunchByTip,
	};
}

function readTipHistoryStore(): TipHistoryStore {
	return normalizeTipHistoryStore(
		readJsonFile<unknown>(PATHS.TUI_TIP_HISTORY_FILE, {
			fallback: EMPTY_TIP_HISTORY_STORE,
		}),
	);
}

function writeTipHistoryStore(store: TipHistoryStore): void {
	writeJsonFile(PATHS.TUI_TIP_HISTORY_FILE, store);
}

function ensureLaunchNumber(): {
	launchNumber: number;
	store: TipHistoryStore;
} {
	const store = readTipHistoryStore();
	if (activeLaunchNumber !== null) {
		return { launchNumber: activeLaunchNumber, store };
	}
	activeLaunchNumber = store.launchCount + 1;
	store.launchCount = activeLaunchNumber;
	writeTipHistoryStore(store);
	return { launchNumber: activeLaunchNumber, store };
}

function getSessionsSinceLastShown(
	tipId: string,
	store: TipHistoryStore,
	launchNumber: number,
): number {
	const lastShown = store.lastShownLaunchByTip[tipId];
	if (typeof lastShown !== "number") {
		return Number.POSITIVE_INFINITY;
	}
	return Math.max(0, launchNumber - lastShown);
}

export function selectTipWithLongestTimeSinceShown(
	availableTips: LoaderTipDefinition[],
	store: TipHistoryStore,
	launchNumber: number,
): LoaderTipDefinition | undefined {
	return availableTips
		.map((tip, index) => ({ tip, index }))
		.sort((left, right) => {
			const rightSessions = getSessionsSinceLastShown(
				right.tip.id,
				store,
				launchNumber,
			);
			const leftSessions = getSessionsSinceLastShown(
				left.tip.id,
				store,
				launchNumber,
			);
			return rightSessions - leftSessions || left.index - right.index;
		})
		.at(0)?.tip;
}

export function getLoaderTip(context: LoaderTipContext = {}): string | null {
	const { launchNumber, store } = ensureLaunchNumber();
	const projectRoot = context.projectRoot ?? process.cwd();
	const relevantTips = loaderTips.filter(
		(tip) =>
			!shownTipsThisLaunch.has(tip.id) &&
			tip.isRelevant({ projectRoot }) &&
			getSessionsSinceLastShown(tip.id, store, launchNumber) >=
				tip.cooldownSessions,
	);
	const selected = selectTipWithLongestTimeSinceShown(
		relevantTips,
		store,
		launchNumber,
	);
	if (!selected) {
		return null;
	}

	store.lastShownLaunchByTip[selected.id] = launchNumber;
	writeTipHistoryStore(store);
	shownTipsThisLaunch.add(selected.id);
	return selected.content;
}

export function resetLoaderTipSchedulerForTests(): void {
	activeLaunchNumber = null;
	shownTipsThisLaunch.clear();
}
