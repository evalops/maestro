import { type Component, Container, type TUI } from "@evalops/tui";
import { describe, expect, it, vi } from "vitest";
import { BaseView } from "../../src/cli-tui/base-view.js";
import { ModalManager } from "../../src/cli-tui/modal-manager.js";

class TestView extends BaseView {
	readonly onMountSpy = vi.fn();
	readonly onUnmountSpy = vi.fn();
	readonly onDisposeSpy = vi.fn();

	override onMount(): void {
		this.onMountSpy();
	}

	override onUnmount(): void {
		this.onUnmountSpy();
	}

	protected override onDispose(): void {
		this.onDisposeSpy();
	}

	render(): string[] {
		return [];
	}
}

function createUi(): TUI {
	return {
		setFocus: vi.fn(),
		requestRender: vi.fn(),
	} as unknown as TUI;
}

describe("ModalManager lifecycle", () => {
	it("mounts/unmounts/disposes BaseView modals correctly", () => {
		const container = new Container();
		const ui = createUi();
		const defaultComponent: Component = { render: () => [] };

		const mgr = new ModalManager(container, ui, defaultComponent);

		const a = new TestView();
		mgr.push(a);
		expect(a.mounted).toBe(true);
		expect(a.onMountSpy).toHaveBeenCalledTimes(1);

		const b = new TestView();
		mgr.push(b);
		expect(a.mounted).toBe(false);
		expect(a.onUnmountSpy).toHaveBeenCalledTimes(1);
		expect(b.mounted).toBe(true);
		expect(b.onMountSpy).toHaveBeenCalledTimes(1);

		mgr.pop();
		expect(b.disposed).toBe(true);
		expect(b.onUnmountSpy).toHaveBeenCalledTimes(1);
		expect(b.onDisposeSpy).toHaveBeenCalledTimes(1);

		expect(a.mounted).toBe(true);
		expect(a.onMountSpy).toHaveBeenCalledTimes(2);
	});

	it("avoids double-calling when legacy lifecycle methods alias each other", () => {
		const container = new Container();
		const ui = createUi();
		const defaultComponent: Component = { render: () => [] };
		const mgr = new ModalManager(container, ui, defaultComponent);

		const onMount = vi.fn();
		const onUnmount = vi.fn();
		const onClose = onUnmount;

		const legacyModal: Component & {
			onMount: () => void;
			onUnmount: () => void;
			onClose: () => void;
		} = {
			render: () => [],
			onMount,
			onUnmount,
			onClose,
		};

		mgr.push(legacyModal);
		expect(onMount).toHaveBeenCalledTimes(1);

		mgr.pop();
		// onUnmount runs once; onClose is an alias and should not run again.
		expect(onUnmount).toHaveBeenCalledTimes(1);
	});
});
