import { fixture, html } from "@open-wc/testing";
import { LitElement } from "lit";
import { assert, describe, it, vi } from "vitest";
import type { ModelApproval } from "../services/enterprise-api.js";
import { AdminModelsTab } from "./admin-models-tab.js";

class TestAdminModelsHost extends LitElement {
	readonly toastCalls: Array<{ message: string; type: string }> = [];

	approvals: ModelApproval[] = [];

	readonly getModelApprovals = vi.fn(async () => ({
		approvals: this.approvals,
	}));

	readonly approveModel = vi.fn(async () => undefined);
	readonly denyModel = vi.fn(async () => undefined);

	private readonly modelsTab = new AdminModelsTab(
		this,
		() => ({
			getModelApprovals: this.getModelApprovals,
			approveModel: this.approveModel,
			denyModel: this.denyModel,
		}),
		() => this.approvals,
		(approvals) => {
			this.approvals = [...approvals];
			this.requestUpdate();
		},
		(message, type) => {
			this.toastCalls.push({ message, type });
		},
		(value) => value.toString(),
		(status) => status,
	);

	async load() {
		await this.modelsTab.load();
	}

	override render() {
		return this.modelsTab.render(false);
	}
}

if (!customElements.get("test-admin-models-host")) {
	customElements.define("test-admin-models-host", TestAdminModelsHost);
}

describe("AdminModelsTab", () => {
	it("keeps approve handler context when approving a pending model", async () => {
		const element = await fixture<TestAdminModelsHost>(
			html`<test-admin-models-host></test-admin-models-host>`,
		);
		element.approvals = [
			{
				id: "approval-1",
				orgId: "org-1",
				modelId: "gpt-5.4",
				provider: "openai",
				status: "pending",
				tokenUsed: 1200,
				spendUsed: 150,
			},
		];
		await element.load();
		await element.updateComplete;

		const approveButton = element.shadowRoot?.querySelector(
			"button.btn-primary",
		) as HTMLButtonElement | null;

		assert.ok(approveButton);

		approveButton.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await element.updateComplete;

		assert.deepEqual(element.approveModel.mock.calls, [["gpt-5.4"]]);
		assert.equal(element.getModelApprovals.mock.calls.length, 2);
		assert.deepEqual(element.toastCalls, [
			{ message: "Model approved", type: "success" },
		]);
	});

	it("keeps deny handler context when denying a pending model", async () => {
		const element = await fixture<TestAdminModelsHost>(
			html`<test-admin-models-host></test-admin-models-host>`,
		);
		element.approvals = [
			{
				id: "approval-1",
				orgId: "org-1",
				modelId: "claude-sonnet-4",
				provider: "anthropic",
				status: "pending",
				tokenUsed: 800,
				spendUsed: 0,
			},
		];
		await element.load();
		await element.updateComplete;

		const buttons = Array.from(
			element.shadowRoot?.querySelectorAll("button") ?? [],
		) as HTMLButtonElement[];
		const denyButton = buttons.find((button) =>
			button.textContent?.includes("Deny"),
		);

		assert.ok(denyButton);

		denyButton?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await element.updateComplete;

		assert.deepEqual(element.denyModel.mock.calls, [["claude-sonnet-4"]]);
		assert.equal(element.getModelApprovals.mock.calls.length, 2);
		assert.deepEqual(element.toastCalls, [
			{ message: "Model denied", type: "success" },
		]);
	});
});
