import type { Component, Container, TUI } from "@evalops/tui";

export interface Modal extends Component {
	/**
	 * @deprecated Prefer `dispose()` (or `unmount()` for temporary hides).
	 * Called when a modal is permanently removed (pop/replace/clear).
	 */
	onClose?: () => void;

	/**
	 * @deprecated Prefer `mount()`. Called when modal becomes visible.
	 */
	onMount?: () => void;

	/**
	 * @deprecated Prefer `unmount()`. Called when modal becomes hidden.
	 */
	onUnmount?: () => void;

	/**
	 * Lifecycle: Called when modal becomes visible (active/top of stack).
	 * Idempotent implementations are strongly recommended.
	 */
	mount?: () => void;

	/**
	 * Lifecycle: Called when modal becomes hidden (covered by another modal).
	 * Idempotent implementations are strongly recommended.
	 */
	unmount?: () => void;

	/**
	 * Cleanup: Called when a modal is permanently removed (pop/replace/clear).
	 *
	 * Convention: `dispose()` should ensure the modal is unmounted first (or
	 * otherwise release resources as if unmounted). `BaseView` already follows
	 * this pattern.
	 */
	dispose?: () => void;
}

/**
 * Helper to invoke lifecycle methods on a modal
 */
function mountModal(modal: Modal): void {
	if (modal.mount) {
		modal.mount();
		return;
	}
	modal.onMount?.();
}

/**
 * Helper to invoke "hidden" lifecycle methods on a modal (still on stack).
 */
function unmountModal(modal: Modal): void {
	if (modal.unmount) {
		modal.unmount();
		return;
	}
	modal.onUnmount?.();
}

/**
 * Helper to invoke permanent cleanup on a modal (removed from stack).
 */
function disposeModal(modal: Modal): void {
	const unmountFn = modal.unmount ?? modal.onUnmount;
	const disposeFn = modal.dispose;
	const closeFn = modal.onClose;
	const call = (fn: (() => void) | undefined) => fn?.call(modal);

	// Ensure unmount semantics happen exactly once.
	if (unmountFn && disposeFn && unmountFn !== disposeFn) {
		call(unmountFn);
	} else if (unmountFn && !disposeFn) {
		call(unmountFn);
	}

	call(disposeFn);

	// Backwards compatibility: avoid double-calling if onClose is an alias.
	if (closeFn && closeFn !== unmountFn && closeFn !== disposeFn) {
		call(closeFn);
	}
}

export class ModalManager {
	private stack: Modal[] = [];

	constructor(
		private readonly container: Container,
		private readonly ui: TUI,
		private readonly defaultComponent: Component,
		private readonly options: { onLayoutChange?: () => void } = {},
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
			unmountModal(previous);
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
			disposeModal(modal);
		}

		this.updateView();
		// Re-mount the newly visible modal after focus is restored
		const newTop = this.getActiveModal();
		if (newTop) {
			mountModal(newTop);
		}
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
			disposeModal(old);
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
				disposeModal(modal);
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
		this.options.onLayoutChange?.();
		this.ui.requestRender();
	}
}
