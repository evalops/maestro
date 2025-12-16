import type { Component, Container, TUI } from "@evalops/tui";

export interface Modal extends Component {
	/**
	 * @deprecated Use onUnmount instead. Called when modal is closed.
	 */
	onClose?: () => void;

	/**
	 * Lifecycle: Called when modal is pushed onto the stack and becomes visible.
	 */
	onMount?: () => void;

	/**
	 * Lifecycle: Called when modal is removed from the stack.
	 */
	onUnmount?: () => void;

	/**
	 * Cleanup: Called for permanent disposal. Alias for onUnmount.
	 */
	dispose?: () => void;
}

/**
 * Helper to invoke lifecycle methods on a modal
 */
function mountModal(modal: Modal): void {
	modal.onMount?.();
}

/**
 * Helper to invoke cleanup methods on a modal
 */
function unmountModal(modal: Modal): void {
	modal.onUnmount?.();
	modal.onClose?.(); // Backwards compatibility
	modal.dispose?.();
}

export class ModalManager {
	private stack: Modal[] = [];

	constructor(
		private readonly container: Container,
		private readonly ui: TUI,
		private readonly defaultComponent: Component,
	) {}

	/**
	 * Push a new modal onto the stack.
	 * This will clear the container, render the new modal, and set focus to it.
	 * Calls onMount on the new modal.
	 */
	push(modal: Modal): void {
		// Unmount previous top modal (it's being covered)
		const previous = this.getActiveModal();
		if (previous) {
			previous.onUnmount?.();
		}

		this.stack.push(modal);
		this.updateView();
		mountModal(modal);
	}

	/**
	 * Pop the top modal from the stack.
	 * This will restore the previous modal or the default component.
	 * Calls onUnmount/onClose/dispose on the popped modal.
	 */
	pop(): Modal | undefined {
		const modal = this.stack.pop();
		if (modal) {
			unmountModal(modal);
		}

		// Re-mount the newly visible modal
		const newTop = this.getActiveModal();
		if (newTop) {
			newTop.onMount?.();
		}

		this.updateView();
		return modal;
	}

	/**
	 * Replace the current top modal with a new one.
	 * Useful for wizard-like flows (e.g., Git Preview -> Commit).
	 * Calls lifecycle methods appropriately.
	 */
	replace(modal: Modal): void {
		const old = this.stack.pop();
		if (old) {
			unmountModal(old);
		}
		this.stack.push(modal);
		this.updateView();
		mountModal(modal);
	}

	/**
	 * Clear all modals and restore the default component.
	 * Calls lifecycle methods on all modals being cleared.
	 */
	clear(): void {
		while (this.stack.length > 0) {
			const modal = this.stack.pop();
			if (modal) {
				unmountModal(modal);
			}
		}
		this.updateView();
	}

	/**
	 * Check if any modal is currently active.
	 */
	hasActiveModal(): boolean {
		return this.stack.length > 0;
	}

	/**
	 * Get the currently active modal.
	 */
	getActiveModal(): Modal | undefined {
		return this.stack[this.stack.length - 1];
	}

	private updateView(): void {
		this.container.clear();
		const active = this.getActiveModal() ?? this.defaultComponent;
		this.container.addChild(active);
		this.ui.setFocus(active);
		this.ui.requestRender();
	}
}
