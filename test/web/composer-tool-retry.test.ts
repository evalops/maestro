// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../packages/web/src/components/composer-tool-retry.js";

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("composer-tool-retry", () => {
	it("renders queue source and timeout metadata", async () => {
		const el = document.createElement("composer-tool-retry") as HTMLElement & {
			request: {
				id: string;
				toolCallId: string;
				toolName: string;
				args: Record<string, unknown>;
				errorMessage: string;
				attempt: number;
				pendingRequest?: Record<string, unknown>;
			};
			queueLength: number;
			updateComplete?: Promise<void>;
		};

		el.request = {
			id: "retry-1",
			toolCallId: "tool-call-1",
			toolName: "bash",
			args: { command: "npm test" },
			errorMessage: "exit 1",
			attempt: 2,
			pendingRequest: {
				source: "local",
				createdAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 3 * 60 * 1000).toISOString(),
			},
		};
		el.queueLength = 1;

		document.body.appendChild(el);
		await el.updateComplete;

		const text = (el.shadowRoot?.textContent ?? "").replace(/\s+/g, " ");
		expect(text).toContain("Retry request 1 of 1");
		expect(text).toContain("Local wait");
		expect(text).toContain("Expires");
	});

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
