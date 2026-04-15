export interface ComposerProjectOnboardingStepLike {
	key: "workspace" | "instructions";
	text: string;
	isComplete: boolean;
	isEnabled: boolean;
}

export interface ComposerProjectOnboardingStateLike {
	shouldShow?: boolean;
	completed?: boolean;
	seenCount?: number;
	steps: ComposerProjectOnboardingStepLike[];
}

export interface ComposerProjectOnboardingAction {
	id: "create-app" | "clone-repo" | "init";
	label: string;
	description: string;
	value: string;
	kind: "prompt" | "command";
}

export interface ComposerSessionSummaryLike {
	id: string;
	messageCount: number;
	resumeSummary?: string;
}

export function normalizeComposerResumeSummary(
	summary: string | null | undefined,
): string | null {
	if (typeof summary !== "string") {
		return null;
	}
	const trimmed = summary.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function truncateComposerResumeSummary(
	summary: string,
	max = 140,
): string {
	if (summary.length <= max) {
		return summary;
	}
	return `${summary.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function getActiveComposerProjectOnboardingSteps(
	onboarding: ComposerProjectOnboardingStateLike | null | undefined,
): ComposerProjectOnboardingStepLike[] {
	return (
		onboarding?.steps.filter((step) => step.isEnabled && !step.isComplete) ?? []
	);
}

export function getComposerProjectOnboardingActions(
	onboarding: ComposerProjectOnboardingStateLike | null | undefined,
): ComposerProjectOnboardingAction[] {
	const steps = getActiveComposerProjectOnboardingSteps(onboarding);
	const actions: ComposerProjectOnboardingAction[] = [];

	for (const step of steps) {
		if (step.key === "workspace") {
			actions.push(
				{
					id: "create-app",
					label: "Create app",
					description: "Scaffold a fresh project in this folder.",
					value:
						"Create a new app in this folder. If the stack is unclear, ask one clarifying question first.",
					kind: "prompt",
				},
				{
					id: "clone-repo",
					label: "Clone repo",
					description: "Clone an existing repository into this workspace.",
					value:
						"Clone a repository into this folder. If I have not provided the repository URL yet, ask me for it first.",
					kind: "prompt",
				},
			);
			continue;
		}

		if (step.key === "instructions") {
			actions.push({
				id: "init",
				label: "Run /init",
				description: "Scaffold AGENTS.md instructions for this project.",
				value: "/init",
				kind: "command",
			});
		}
	}

	return actions;
}

export function getComposerResumableSessions<
	TSession extends ComposerSessionSummaryLike,
>(
	sessions: readonly TSession[],
	options: {
		excludeSessionId?: string | null;
		limit?: number;
	} = {},
): TSession[] {
	const filtered = sessions.filter((session) => {
		if (options.excludeSessionId && session.id === options.excludeSessionId) {
			return false;
		}
		return (
			session.messageCount > 0 ||
			normalizeComposerResumeSummary(session.resumeSummary) !== null
		);
	});

	return filtered.slice(0, options.limit ?? filtered.length);
}
