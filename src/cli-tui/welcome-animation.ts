/**
 * WelcomeAnimation - plain startup copy for the interactive TUI.
 */

import {
	getActiveComposerProjectOnboardingSteps,
	getComposerProjectOnboardingActions,
} from "@evalops/contracts";
import { Container, Text, visibleWidth } from "@evalops/tui";
import type { ProjectOnboardingState } from "../onboarding/project-onboarding.js";
import { theme } from "../theme/theme.js";
import { getQueuedFollowUpEditBindingLabel } from "./queue/queued-follow-up-edit-binding.js";
import { PANEL_WIDTHS } from "./utils/layout.js";

const TITLE = "Maestro";
const CANVAS_WIDTH = PANEL_WIDTHS.welcome;

function getShortcuts() {
	return [
		{ key: "Enter", desc: "send/steer" },
		{ key: "Tab", desc: "send/queue" },
		{ key: getQueuedFollowUpEditBindingLabel(), desc: "edit queue" },
		{ key: "/help", desc: "commands" },
	] as const;
}

export class WelcomeAnimation extends Container {
	private intervalId: NodeJS.Timeout | null = null;
	private readonly textComponent: Text;
	private readonly onRenderRequest?: () => void;
	private modelName = "";
	private onboardingState: ProjectOnboardingState | null = null;
	private readonly animate: boolean;

	constructor(
		onRenderRequest?: () => void,
		options: { animate?: boolean } = {},
	) {
		super();
		this.onRenderRequest = onRenderRequest;
		this.animate = options.animate ?? true;
		this.textComponent = new Text("", 0, 0);
		this.addChild(this.textComponent);
		this.updateFrame();
		if (this.animate) {
			this.startAnimation();
		}
	}

	private startAnimation(): void {
		this.onRenderRequest?.();
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	setModelName(modelName: string): void {
		this.modelName = modelName;
	}

	setProjectOnboarding(state: ProjectOnboardingState | null): void {
		this.onboardingState = state;
		this.updateFrame();
	}

	private updateFrame(): void {
		const title = theme.fg("muted", TITLE);
		const modelStatus = this.modelName
			? theme.fg("dim", `model: ${this.modelName}`)
			: "";
		const shortcutsLine = this.buildShortcutsLine();
		const onboardingLines = this.buildOnboardingLines();

		const lines = [
			"",
			centerLine(title),
			modelStatus ? centerLine(modelStatus) : "",
			"",
			centerLine(shortcutsLine),
			...(onboardingLines.length > 0 ? ["", ...onboardingLines, ""] : [""]),
		].filter((line) => line !== undefined);

		this.textComponent.setText(lines.join("\n"));
	}

	private buildShortcutsLine(): string {
		const parts = getShortcuts().map(({ key, desc }) => {
			const keyPart = theme.fg("muted", key);
			const descPart = theme.fg("dim", desc);
			return `${keyPart}${theme.fg("borderMuted", ":")}${descPart}`;
		});
		return parts.join(theme.fg("borderMuted", "  │  "));
	}

	private buildOnboardingLines(): string[] {
		const steps = getActiveComposerProjectOnboardingSteps(this.onboardingState);
		const actions = getComposerProjectOnboardingActions(this.onboardingState);
		if (steps.length === 0) {
			return [];
		}

		return [
			centerLine(theme.fg("muted", "Get Started")),
			...steps
				.slice(0, 2)
				.map((step) => centerLine(theme.fg("dim", step.text))),
			...actions
				.slice(0, 2)
				.map((action) =>
					centerLine(
						theme.fg(
							action.kind === "command" ? "muted" : "dim",
							action.kind === "command"
								? `Run ${action.value}`
								: `Try ${action.label.toLowerCase()}`,
						),
					),
				),
		];
	}
}

function centerLine(text: string): string {
	const width = visibleWidth(text);
	const padding = Math.max(0, Math.floor((CANVAS_WIDTH - width) / 2));
	return `${" ".repeat(padding)}${text}`;
}
