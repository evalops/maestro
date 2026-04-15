import { fixture, html } from "@open-wc/testing";
import { LitElement } from "lit";
import { assert, describe, it, vi } from "vitest";
import type { OrganizationSettings } from "../services/enterprise-api.js";
import { AdminSecurityTab } from "./admin-security-tab.js";

class TestAdminSecurityHost extends LitElement {
	readonly toastCalls: Array<{ message: string; type: string }> = [];

	state: {
		orgSettings: OrganizationSettings | null;
		piiPatterns: string;
		auditRetention: number;
		webhookUrls: string;
	} = {
		orgSettings: null,
		piiPatterns: "",
		auditRetention: 90,
		webhookUrls: "",
	};

	readonly getOrgSettings = vi.fn(async () => ({
		piiRedactionEnabled: true,
		piiPatterns: ["EMP-\\d{6}"],
		auditRetentionDays: 30,
		alertWebhooks: ["https://hooks.slack.com/services/a"],
	}));

	readonly updateOrgSettings = vi.fn(async () => undefined);

	private readonly securityTab = new AdminSecurityTab(
		this,
		() => ({
			getOrgSettings: this.getOrgSettings,
			updateOrgSettings: this.updateOrgSettings,
		}),
		() => this.state,
		(state) => {
			this.state = { ...this.state, ...state };
			this.requestUpdate();
		},
		(message, type) => {
			this.toastCalls.push({ message, type });
		},
	);

	async load() {
		await this.securityTab.load();
	}

	override render() {
		return this.securityTab.render(false);
	}
}

if (!customElements.get("test-admin-security-host")) {
	customElements.define("test-admin-security-host", TestAdminSecurityHost);
}

describe("AdminSecurityTab", () => {
	it("loads persisted org settings into the security form", async () => {
		const element = await fixture<TestAdminSecurityHost>(
			html`<test-admin-security-host></test-admin-security-host>`,
		);

		await element.load();
		await element.updateComplete;

		const textareas = Array.from(
			element.shadowRoot?.querySelectorAll("textarea.form-input") ?? [],
		) as HTMLTextAreaElement[];
		const retentionInput = element.shadowRoot?.querySelector(
			'input[type="number"]',
		) as HTMLInputElement | null;

		assert.equal(textareas[0]?.value, "EMP-\\d{6}");
		assert.equal(textareas[1]?.value, "https://hooks.slack.com/services/a");
		assert.equal(retentionInput?.value, "30");
	});

	it("keeps PII save handler context when persisting settings", async () => {
		const element = await fixture<TestAdminSecurityHost>(
			html`<test-admin-security-host></test-admin-security-host>`,
		);
		await element.updateComplete;

		const piiTextarea = element.shadowRoot?.querySelector(
			"textarea.form-input",
		) as HTMLTextAreaElement | null;
		const saveButton = element.shadowRoot?.querySelector(
			"button.btn-primary",
		) as HTMLButtonElement | null;

		assert.ok(piiTextarea);
		assert.ok(saveButton);

		piiTextarea.value = "EMP-\\d{6}\nINTERNAL-[A-Z]{3}-\\d{4}";
		piiTextarea.dispatchEvent(
			new Event("input", { bubbles: true, composed: true }),
		);
		await element.updateComplete;

		saveButton.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await element.updateComplete;

		assert.deepEqual(element.updateOrgSettings.mock.calls, [
			[
				{
					piiRedactionEnabled: true,
					piiPatterns: ["EMP-\\d{6}", "INTERNAL-[A-Z]{3}-\\d{4}"],
				},
			],
		]);
		assert.deepEqual(element.toastCalls, [
			{ message: "PII settings saved", type: "success" },
		]);
	});

	it("keeps webhook save handler context when persisting webhook URLs", async () => {
		const element = await fixture<TestAdminSecurityHost>(
			html`<test-admin-security-host></test-admin-security-host>`,
		);
		await element.updateComplete;

		const textareas = Array.from(
			element.shadowRoot?.querySelectorAll("textarea.form-input") ?? [],
		) as HTMLTextAreaElement[];
		const webhookTextarea = textareas[1];
		const buttons = Array.from(
			element.shadowRoot?.querySelectorAll("button.btn-primary") ?? [],
		) as HTMLButtonElement[];
		const webhookButton = buttons[2];

		assert.ok(webhookTextarea);
		assert.ok(webhookButton);

		webhookTextarea.value =
			"https://hooks.slack.com/services/a\nhttps://hooks.slack.com/services/b";
		webhookTextarea.dispatchEvent(
			new Event("input", { bubbles: true, composed: true }),
		);
		await element.updateComplete;

		webhookButton.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await element.updateComplete;

		assert.deepEqual(element.updateOrgSettings.mock.calls, [
			[
				{
					alertWebhooks: [
						"https://hooks.slack.com/services/a",
						"https://hooks.slack.com/services/b",
					],
				},
			],
		]);
		assert.deepEqual(element.toastCalls, [
			{ message: "Webhooks saved", type: "success" },
		]);
	});
});
