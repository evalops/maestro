import type { Component, Container, TUI } from "@evalops/tui";

export interface Modal extends Component {
	// Optional: specific modal lifecycle methods if needed
	onClose?: () => void;
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
	 */
	push(modal: Modal): void {
		this.stack.push(modal);
		this.updateView();
	}

	/**
	 * Pop the top modal from the stack.
	 * This will restore the previous modal or the default component.
	 */
	pop(): Modal | undefined {
		const modal = this.stack.pop();
		if (modal?.onClose) {
			modal.onClose();
		}
		this.updateView();
		return modal;
	}

	/**
	 * Replace the current top modal with a new one.
	 * Useful for wizard-like flows (e.g., Git Preview -> Commit).
	 */
	replace(modal: Modal): void {
		const old = this.stack.pop();
		if (old?.onClose) {
			old.onClose();
		}
		this.stack.push(modal);
		this.updateView();
	}

	/**
	 * Clear all modals and restore the default component.
	 */
	clear(): void {
		while (this.stack.length > 0) {
			const modal = this.stack.pop();
			if (modal?.onClose) {
				modal.onClose();
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

