import { fixture, html } from "@open-wc/testing";
import { LitElement } from "lit";
import { assert, afterEach, describe, it, vi } from "vitest";
import type { AuditLog } from "../services/enterprise-api.js";
import { AdminAuditTab } from "./admin-audit-tab.js";

class TestAdminAuditHost extends LitElement {
	readonly toastCalls: Array<{ message: string; type: string }> = [];
	readonly exportAuditLogs = vi.fn(async () => "timestamp,action\n");

	private readonly auditTab = new AdminAuditTab(
		this,
		{ exportAuditLogs: this.exportAuditLogs },
		(message, type) => {
			this.toastCalls.push({ message, type });
		},
		(value) => value,
		(status) => status,
	);

	setLogs(logs: AuditLog[]) {
		this.auditTab.setLogs(logs);
	}

	override render() {
		return this.auditTab.render(false);
	}
}

if (!customElements.get("test-admin-audit-host")) {
	customElements.define("test-admin-audit-host", TestAdminAuditHost);
}

describe("AdminAuditTab", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("keeps search handler context when filtering logs", async () => {
		const element = await fixture<TestAdminAuditHost>(
			html`<test-admin-audit-host></test-admin-audit-host>`,
		);
		element.setLogs([
			{
				id: "1",
				orgId: "org",
				userId: "user-1",
				action: "user.login",
				status: "success",
				createdAt: "2026-03-13T15:00:00.000Z",
			},
			{
				id: "2",
				orgId: "org",
				userId: "user-2",
				action: "session.denied",
				resourceType: "session",
				status: "denied",
				createdAt: "2026-03-13T15:01:00.000Z",
			},
		]);
		await element.updateComplete;

		const searchInput = element.shadowRoot?.querySelector(
			"input.search-input",
		) as HTMLInputElement | null;

		assert.ok(searchInput);

		searchInput.value = "denied";
		searchInput.dispatchEvent(
			new Event("input", { bubbles: true, composed: true }),
		);
		await element.updateComplete;

		const text = element.shadowRoot?.textContent ?? "";
		assert.include(text, "Audit Logs (1)");
		assert.include(text, "session.denied");
		assert.notInclude(text, "user.login");
	});

	it("keeps export handler context when exporting CSV", async () => {
		const createObjectURL = vi.fn(() => "blob:csv");
		const revokeObjectURL = vi.fn();
		const clickSpy = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});
		vi.stubGlobal("URL", {
			createObjectURL,
			revokeObjectURL,
		});

		const element = await fixture<TestAdminAuditHost>(
			html`<test-admin-audit-host></test-admin-audit-host>`,
		);
		await element.updateComplete;

		const exportButton = element.shadowRoot?.querySelector(
			"button",
		) as HTMLButtonElement | null;

		assert.ok(exportButton);

		exportButton.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await element.updateComplete;

		assert.equal(element.exportAuditLogs.mock.calls.length, 1);
		assert.deepEqual(element.exportAuditLogs.mock.calls[0], ["csv"]);
		assert.equal(createObjectURL.mock.calls.length, 1);
		assert.equal(revokeObjectURL.mock.calls.length, 1);
		assert.equal(clickSpy.mock.calls.length, 1);
		assert.deepEqual(element.toastCalls, [
			{ message: "Export started", type: "success" },
		]);
	});
});
