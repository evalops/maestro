import { describe, expect, it, vi } from "vitest";
import { FooterHintsController } from "../../src/cli-tui/tui-renderer/footer-hints-controller.js";

function createController(options?: {
	isAgentRunning?: boolean;
	getRunningHint?: () => string | null;
}) {
	const setHints = vi.fn();
	const setRuntimeBadges = vi.fn();
	const controller = new FooterHintsController({
		deps: {
			isAgentRunning: () => options?.isAgentRunning ?? false,
			idleFooterHint: "Try /help",
			isReducedMotion: () => false,
			isMinimalMode: () => false,
			getSandboxMode: () => null,
			isSandboxActive: () => false,
			getApprovalMode: () => null,
			getQueueData: () => ({
				followUpMode: "all",
				queuedCount: 0,
				hasQueue: true,
				queueHint: null,
			}),
			getRunningHint: options?.getRunningHint ?? (() => null),
			getThinkingLevel: () => null,
			getUnseenAlertCount: () => 0,
			getHookStatusHints: () => [],
			getActiveToast: () => null,
			getBackgroundCounts: () => ({ running: 0, failed: 0 }),
			isCompacting: () => false,
			hasPendingPaste: () => false,
			isBashModeActive: () => false,
			setRuntimeBadges,
			setHints,
		},
		callbacks: {
			showToast: vi.fn(),
			setToast: vi.fn(),
		},
	});
	return { controller, setHints, setRuntimeBadges };
}

describe("FooterHintsController", () => {
	it("renders the running hint instead of idle hints while busy", () => {
		const { controller, setHints, setRuntimeBadges } = createController({
			isAgentRunning: true,
			getRunningHint: () =>
				"Working… press esc to interrupt • Tab queue follow-up",
		});

		controller.refresh();

		expect(setRuntimeBadges).toHaveBeenCalledOnce();
		expect(setHints).toHaveBeenCalledWith([
			{
				type: "custom",
				message: "Working… press esc to interrupt • Tab queue follow-up",
				priority: 150,
			},
		]);
	});

	it("uses maestro wording in the danger compaction toast", () => {
		const showToast = vi.fn();
		const controller = new FooterHintsController({
			deps: {
				isAgentRunning: () => false,
				idleFooterHint: "Try /help",
				isReducedMotion: () => false,
				isMinimalMode: () => false,
				getSandboxMode: () => null,
				isSandboxActive: () => false,
				getApprovalMode: () => null,
				getQueueData: () => ({
					followUpMode: "all",
					queuedCount: 0,
					hasQueue: true,
					queueHint: null,
				}),
				getRunningHint: () => null,
				getThinkingLevel: () => null,
				getUnseenAlertCount: () => 0,
				getHookStatusHints: () => [],
				getActiveToast: () => null,
				getBackgroundCounts: () => ({ running: 0, failed: 0 }),
				isCompacting: () => false,
				hasPendingPaste: () => false,
				isBashModeActive: () => false,
				setRuntimeBadges: vi.fn(),
				setHints: vi.fn(),
			},
			callbacks: {
				showToast,
				setToast: vi.fn(),
			},
		});

		controller.maybeShowContextWarning({
			contextWindow: 200000,
			contextTokens: 196000,
			contextPercent: 98,
		});

		expect(showToast).toHaveBeenCalledWith(
			"Context 98.0% used (196k/200k). Maestro will auto-compact soon.",
			"warn",
		);
	});
});
