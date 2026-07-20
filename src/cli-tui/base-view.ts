/**
 * BaseView - Abstract base class for views with lifecycle management
 *
 * Provides standard lifecycle hooks for mounting/unmounting views:
 * - onMount(): Called when view becomes visible/active
 * - onUnmount(): Called when view is hidden/deactivated
 * - dispose(): Called when view is permanently destroyed
 *
 * Usage:
 * ```typescript
 * class MyView extends BaseView {
 *   private subscription?: () => void;
 *
 *   onMount(): void {
 *     this.subscription = eventBus.subscribe('event', this.handleEvent);
 *   }
 *
 *   onUnmount(): void {
 *     this.subscription?.();
 *   }
 *
 *   render(width: number): string[] {
 *     return ['My view content'];
 *   }
 * }
 * ```
 */

import type { Component } from "@evalops/tui";

export abstract class BaseView implements Component {
	private _mounted = false;
	private _disposed = false;

	/**
	 * Whether the view is currently mounted
	 */
	get mounted(): boolean {
		return this._mounted;
	}

	/**
	 * Whether the view has been disposed
	 */
	get disposed(): boolean {
		return this._disposed;
	}

	/**
	 * Mount the view. Called automatically by ModalManager or manually.
	 * Idempotent - calling multiple times has no effect.
	 */
	mount(): void {
		if (this._disposed) {
			throw new Error("Cannot mount a disposed view");
		}
		if (!this._mounted) {
			this._mounted = true;
			this.onMount();
		}
	}

	/**
	 * Unmount the view. Called automatically by ModalManager or manually.
	 * Idempotent - calling multiple times has no effect.
	 */
	unmount(): void {
		if (this._mounted) {
			this._mounted = false;
			this.onUnmount();
		}
	}

	/**
	 * Permanently dispose the view, releasing all resources.
	 * After disposal, the view cannot be mounted again.
	 */
	dispose(): void {
		if (!this._disposed) {
			this.unmount();
			this._disposed = true;
			this.onDispose();
		}
	}

	/**
	 * Lifecycle: Called when view is mounted.
	 * Override to subscribe to events, start timers, etc.
	 * Note: Use mount() to trigger this - don't call onMount() directly.
	 */
	onMount(): void {
		// Override in subclass
	}

	/**
	 * Lifecycle: Called when view is unmounted.
	 * Override to unsubscribe from events, stop timers, etc.
	 * Note: Use unmount() to trigger this - don't call onUnmount() directly.
	 */
	onUnmount(): void {
		// Override in subclass
	}

	/**
	 * Called when view is permanently disposed. Override for final cleanup.
	 * Called after onUnmount if the view was mounted.
	 */
	protected onDispose(): void {
		// Override in subclass
	}

	/**
	 * Render the view. Must be implemented by subclass.
	 */
	abstract render(width: number): string[];

	/**
	 * Optional input handler. Override to handle keyboard input.
	 */
	handleInput?(data: string): void;

	/**
	 * Optional cache invalidation. Override to clear cached render state.
	 */
	invalidate?(): void;
}

/**
 * Subscription tracking helper for views.
 * Automatically cleans up all subscriptions on dispose.
 */
export class SubscriptionManager {
	private subscriptions: Array<() => void> = [];

	/**
	 * Add a subscription (cleanup function) to be tracked
	 */
	add(cleanup: () => void): void {
		this.subscriptions.push(cleanup);
	}

	/**
	 * Add an event listener and track it for cleanup
	 */
	addListener<
		T extends {
			on: (event: string, handler: (...args: unknown[]) => void) => void;
			off: (event: string, handler: (...args: unknown[]) => void) => void;
		},
	>(target: T, event: string, handler: (...args: unknown[]) => void): void {
		target.on(event, handler);
		this.subscriptions.push(() => target.off(event, handler));
	}

	/**
	 * Clean up all tracked subscriptions
	 */
	dispose(): void {
		for (const cleanup of this.subscriptions) {
			try {
				cleanup();
			} catch {
				// Ignore cleanup errors
			}
		}
		this.subscriptions = [];
	}
}

/**
 * Helper to create a view with automatic subscription cleanup
 */
export function createManagedView<T extends BaseView>(
	ViewClass: new (...args: unknown[]) => T,
	...args: ConstructorParameters<typeof ViewClass>
): T {
	return new ViewClass(...args);
}
