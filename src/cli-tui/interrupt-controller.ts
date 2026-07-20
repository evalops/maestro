import type { FooterComponent } from "./footer.js";
import type { NotificationView } from "./notification-view.js";

/**
 * Callbacks for the interrupt controller.
 */
export interface InterruptCallbacks {
	/** Called when interrupt is executed */
	onInterrupt?(options: { keepPartial: boolean }): void;
	/** Called after interrupt to restore queued prompts */
	restoreQueuedPrompts?(options: { keepPartial: boolean }): void;
	/** Whether queued steering will be applied immediately on interrupt */
	hasQueuedSteering?(): boolean;
	/** Get working footer hint text */
	getWorkingHint(): string;
	/** Check if we're in minimal mode */
	isMinimalMode(): boolean;
	/** Check if agent is currently running */
	isAgentRunning(): boolean;
	/** Refresh footer hint */
	refreshFooterHint(): void;
}

/**
 * Options for the interrupt controller.
 */
export interface InterruptControllerOptions {
	footer: FooterComponent;
	notificationView: NotificationView;
	callbacks: InterruptCallbacks;
}

/**
 * Controller for handling interrupt (Esc) behavior.
 *
 * Provides a two-stage interrupt mechanism:
 * 1. First press: Arms the interrupt (shows confirmation prompt)
 * 2. Second press (or 'K' key): Executes the interrupt
 *
 * The armed state times out after 5 seconds.
 */
export class InterruptController {
	private readonly footer: FooterComponent;
	private readonly notificationView: NotificationView;
	private readonly callbacks: InterruptCallbacks;

	private interruptArmed = false;
	private interruptTimeout: NodeJS.Timeout | null = null;

	constructor(options: InterruptControllerOptions) {
		this.footer = options.footer;
		this.notificationView = options.notificationView;
		this.callbacks = options.callbacks;
	}

	/**
	 * Check if interrupt is currently armed.
	 */
	isArmed(): boolean {
		return this.interruptArmed;
	}

	/**
	 * Handle an interrupt request (Esc key press).
	 */
	handleInterruptRequest(): void {
		if (!this.callbacks.isAgentRunning() && !this.interruptArmed) {
			return;
		}
		if (!this.interruptArmed) {
			this.arm();
			return;
		}
		this.execute({ keepPartial: false });
	}

	/**
	 * Handle 'K' key press to keep partial response during interrupt.
	 * Only works when interrupt is armed.
	 * @returns true if the key was handled (interrupt was armed), false otherwise
	 */
	handleKeepPartialRequest(): boolean {
		if (!this.interruptArmed) {
			return false;
		}
		this.execute({ keepPartial: true });
		return true;
	}

	/**
	 * Arm the interrupt mechanism.
	 * Shows a confirmation prompt and starts the timeout.
	 */
	private arm(): void {
		this.interruptArmed = true;
		if (this.interruptTimeout) {
			clearTimeout(this.interruptTimeout);
		}
		const queuedSteering = this.callbacks.hasQueuedSteering?.() === true;
		if (!this.callbacks.isMinimalMode()) {
			this.notificationView.showInfo(
				queuedSteering
					? "Press Esc to interrupt and apply queued steering, K to keep partial response"
					: "Press Esc to discard, K to keep partial response",
			);
		}
		this.footer.setHint(
			queuedSteering
				? "Esc=apply steer | K=keep partial"
				: "Esc=discard | K=keep partial",
		);
		this.interruptTimeout = setTimeout(() => {
			this.clear();
		}, 5000);
	}

	/**
	 * Execute the interrupt with the specified options.
	 */
	private execute(options: { keepPartial: boolean }): void {
		this.clear();

		if (options.keepPartial) {
			this.notificationView.showToast(
				"Interrupted - keeping partial response",
				"info",
			);
		} else {
			this.notificationView.showToast("Interrupted current run", "warn");
		}

		this.callbacks.onInterrupt?.(options);
		this.callbacks.restoreQueuedPrompts?.(options);
	}

	/**
	 * Clear the armed state and restore normal footer hint.
	 */
	clear(): void {
		if (this.interruptTimeout) {
			clearTimeout(this.interruptTimeout);
			this.interruptTimeout = null;
		}
		if (this.interruptArmed) {
			this.interruptArmed = false;
			if (this.callbacks.isAgentRunning()) {
				this.footer.setHint(this.callbacks.getWorkingHint());
			} else {
				this.callbacks.refreshFooterHint();
			}
		}
	}
}
