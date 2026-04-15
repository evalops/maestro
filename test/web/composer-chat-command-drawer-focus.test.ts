// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerChat } from "../../packages/web/src/components/composer-chat.js";

afterEach(() => {
	vi.restoreAllMocks();
});

type CommandDrawerFocusInternals = {
	commandDrawerOpen: boolean;
	closeCommandDrawer: () => void;
	focusComposerInput: () => void;
	scheduleComposerInputFocus: () => void;
	shadowRoot: {
		querySelector: ReturnType<typeof vi.fn>;
	} | null;
};

describe("composer-chat command drawer focus", () => {
	it("schedules composer input focus when the command drawer closes", () => {
		const element =
			new ComposerChat() as unknown as CommandDrawerFocusInternals;
		element.commandDrawerOpen = true;
		element.scheduleComposerInputFocus = vi.fn();

		element.closeCommandDrawer();

		expect(element.commandDrawerOpen).toBe(false);
		expect(element.scheduleComposerInputFocus).toHaveBeenCalledOnce();
	});

	it("forwards focus restoration to the composer input component", () => {
		const focusInput = vi.fn();
		const querySelector = vi.fn().mockReturnValue({ focusInput });
		const element =
			new ComposerChat() as unknown as CommandDrawerFocusInternals;
		Object.defineProperty(element, "shadowRoot", {
			configurable: true,
			value: { querySelector },
		});

		element.focusComposerInput();

		expect(querySelector).toHaveBeenCalledWith("composer-input");
		expect(focusInput).toHaveBeenCalledOnce();
	});
});
