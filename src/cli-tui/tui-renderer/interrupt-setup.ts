import type { FooterComponent } from "../footer.js";
import { InterruptController } from "../interrupt-controller.js";
import type { NotificationView } from "../notification-view.js";

export function createInterruptController(params: {
	footer: FooterComponent;
	notificationView: NotificationView;
	onInterrupt: (options?: { keepPartial?: boolean }) => void;
	restoreQueuedPrompts: (options: { keepPartial: boolean }) => void;
	hasQueuedSteering: () => boolean;
	getWorkingHint: () => string;
	isMinimalMode: () => boolean;
	isAgentRunning: () => boolean;
	refreshFooterHint: () => void;
}): InterruptController {
	const {
		footer,
		notificationView,
		onInterrupt,
		restoreQueuedPrompts,
		hasQueuedSteering,
		getWorkingHint,
		isMinimalMode,
		isAgentRunning,
		refreshFooterHint,
	} = params;

	return new InterruptController({
		footer,
		notificationView,
		callbacks: {
			onInterrupt,
			restoreQueuedPrompts,
			hasQueuedSteering,
			getWorkingHint,
			isMinimalMode,
			isAgentRunning,
			refreshFooterHint,
		},
	});
}
