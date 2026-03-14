// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../packages/web/src/components/composer-approval.js";

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

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

	it("renders queue status and command details for shell approvals", async () => {
		const command = [
			"echo one",
			"printf two",
			"line three",
			"line four",
			"line five",
			"line six",
			"line seven",
			"line eight",
		].join("\n");
		const el = document.createElement("composer-approval") as HTMLElement & {
			request: {
				id: string;
				toolName: string;
				args: Record<string, unknown>;
				reason: string;
			};
			queueLength: number;
			updateComplete?: Promise<void>;
		};

		el.request = {
			id: "approval-queue-1",
			toolName: "bash",
			args: {
				command,
				action: "execute",
				shell: true,
				cwd: "/tmp/demo",
			},
			reason: "Potentially dangerous shell command",
		};
		el.queueLength = 3;

		document.body.appendChild(el);
		await el.updateComplete;

		const text = (el.shadowRoot?.textContent ?? "").replace(/\s+/g, " ");
		expect(text).toContain("Approval 1 of 3");
		expect(text).toContain("2 more approvals waiting");
		expect(text).toContain("Action execute");
		expect(text).toContain("Shell mode enabled");
		expect(text).toContain("cwd:");

		const preview = el.shadowRoot?.querySelector(".command-preview");
		expect(preview?.textContent).toContain("echo one");
		expect(preview?.textContent).toContain("line eight");
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
