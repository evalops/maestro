// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../packages/web/src/components/composer-tool-retry.js";

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("composer-tool-retry", () => {
	it("ignores global Enter and Escape keys when no retry request is active", async () => {
		const el = document.createElement("composer-tool-retry") as HTMLElement & {
			updateComplete?: Promise<void>;
		};

		const retry = vi.fn();
		const skip = vi.fn();
		el.addEventListener("retry", retry as EventListener);
		el.addEventListener("skip", skip as EventListener);
		document.body.appendChild(el);
		await el.updateComplete;

		const enterEvent = new KeyboardEvent("keydown", {
			key: "Enter",
			cancelable: true,
		});
		const escapeEvent = new KeyboardEvent("keydown", {
			key: "Escape",
			cancelable: true,
		});

		window.dispatchEvent(enterEvent);
		window.dispatchEvent(escapeEvent);

		expect(retry).not.toHaveBeenCalled();
		expect(skip).not.toHaveBeenCalled();
		expect(enterEvent.defaultPrevented).toBe(false);
		expect(escapeEvent.defaultPrevented).toBe(false);
	});
});
