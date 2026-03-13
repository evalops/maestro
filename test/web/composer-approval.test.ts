// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import "../../packages/web/src/components/composer-approval.js";

describe("composer-approval", () => {
	it("approves on Enter and emits the request id", async () => {
		const el = document.createElement("composer-approval") as HTMLElement & {
			request: {
				id: string;
				toolName: string;
				args: Record<string, unknown>;
				reason: string;
			};
			updateComplete?: Promise<void>;
		};

		el.request = {
			id: "approval-1",
			toolName: "bash",
			args: { command: "rm -rf /tmp/demo" },
			reason: "Dangerous command",
		};

		const approve = vi.fn();
		el.addEventListener("approve", approve as EventListener);
		document.body.appendChild(el);
		await el.updateComplete;

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

		expect(approve).toHaveBeenCalledTimes(1);
		expect(approve.mock.calls[0]?.[0]).toMatchObject({
			detail: { requestId: "approval-1" },
		});
	});

	it("denies on Escape", async () => {
		const el = document.createElement("composer-approval") as HTMLElement & {
			request: {
				id: string;
				toolName: string;
				args: Record<string, unknown>;
				reason: string;
			};
			updateComplete?: Promise<void>;
		};

		el.request = {
			id: "approval-2",
			toolName: "write",
			args: { path: "/tmp/demo.txt" },
			reason: "Writes a file",
		};

		const deny = vi.fn();
		el.addEventListener("deny", deny as EventListener);
		document.body.appendChild(el);
		await el.updateComplete;

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

		expect(deny).toHaveBeenCalledTimes(1);
		expect(deny.mock.calls[0]?.[0]).toMatchObject({
			detail: { requestId: "approval-2" },
		});
	});
});
