import { fixture, html } from "@open-wc/testing";
import { LitElement } from "lit";
import { assert, describe, it, vi } from "vitest";
import type { DirectoryRule } from "../services/enterprise-api.js";
import { AdminDirectoriesTab } from "./admin-directories-tab.js";

type ConfirmCall = {
	title: string;
	message: string;
	confirmText: string;
	onConfirm: () => void | Promise<void>;
};

class TestAdminDirectoriesHost extends LitElement {
	readonly toastCalls: Array<{ message: string; type: string }> = [];
	readonly confirmCalls: ConfirmCall[] = [];

	rules: DirectoryRule[] = [];

	readonly getDirectoryRules = vi.fn(async () => ({ rules: this.rules }));
	readonly createDirectoryRule = vi.fn(
		async (rule: {
			pattern: string;
			isAllowed: boolean;
			roleIds?: string[];
			description?: string;
			priority?: number;
		}) => ({
			id: "created-rule",
			orgId: "org-1",
			pattern: rule.pattern,
			isAllowed: rule.isAllowed,
			priority: rule.priority ?? 0,
			description: rule.description,
		}),
	);
	readonly deleteDirectoryRule = vi.fn(async () => undefined);

	private readonly directoriesTab = new AdminDirectoriesTab(
		this,
		() => ({
			getDirectoryRules: this.getDirectoryRules,
			createDirectoryRule: this.createDirectoryRule,
			deleteDirectoryRule: this.deleteDirectoryRule,
		}),
		() => this.rules,
		(rules) => {
			this.rules = [...rules];
			this.requestUpdate();
		},
		(message, type) => {
			this.toastCalls.push({ message, type });
		},
		(options) => {
			this.confirmCalls.push(options);
		},
	);

	async load() {
		await this.directoriesTab.load();
	}

	override render() {
		return this.directoriesTab.render(false);
	}
}

if (!customElements.get("test-admin-directories-host")) {
	customElements.define(
		"test-admin-directories-host",
		TestAdminDirectoriesHost,
	);
}

describe("AdminDirectoriesTab", () => {
	it("keeps add-rule handler context when creating a directory rule", async () => {
		const element = await fixture<TestAdminDirectoriesHost>(
			html`<test-admin-directories-host></test-admin-directories-host>`,
		);
		await element.load();
		await element.updateComplete;

		const inputs = Array.from(
			element.shadowRoot?.querySelectorAll("input.form-input") ?? [],
		) as HTMLInputElement[];
		const patternInput = inputs[0];
		const descriptionInput = inputs[1];
		const accessSelect = element.shadowRoot?.querySelector(
			"select.form-input",
		) as HTMLSelectElement | null;
		const addButton = element.shadowRoot?.querySelector(
			"button.btn-primary",
		) as HTMLButtonElement | null;

		assert.ok(patternInput);
		assert.ok(descriptionInput);
		assert.ok(accessSelect);
		assert.ok(addButton);

		patternInput.value = "/app/src/**";
		patternInput.dispatchEvent(
			new Event("input", { bubbles: true, composed: true }),
		);
		accessSelect.value = "deny";
		accessSelect.dispatchEvent(
			new Event("change", { bubbles: true, composed: true }),
		);
		descriptionInput.value = "Block source";
		descriptionInput.dispatchEvent(
			new Event("input", { bubbles: true, composed: true }),
		);
		await element.updateComplete;

		addButton.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await element.updateComplete;

		assert.deepEqual(element.createDirectoryRule.mock.calls, [
			[
				{
					pattern: "/app/src/**",
					isAllowed: false,
					description: "Block source",
				},
			],
		]);
		assert.equal(element.getDirectoryRules.mock.calls.length, 2);
		assert.deepEqual(element.toastCalls, [
			{ message: "Rule created", type: "success" },
		]);
		assert.equal(patternInput.value, "");
		assert.equal(descriptionInput.value, "");
	});

	it("keeps delete handler context when removing a directory rule", async () => {
		const element = await fixture<TestAdminDirectoriesHost>(
			html`<test-admin-directories-host></test-admin-directories-host>`,
		);
		element.rules = [
			{
				id: "rule-1",
				orgId: "org-1",
				pattern: "/app/secrets/**",
				isAllowed: false,
				priority: 10,
				description: "Block secrets",
			},
		];
		await element.load();
		await element.updateComplete;

		const deleteButton = element.shadowRoot?.querySelector(
			"button.btn-danger",
		) as HTMLButtonElement | null;

		assert.ok(deleteButton);

		deleteButton.click();
		await element.updateComplete;

		assert.equal(element.confirmCalls.length, 1);
		assert.equal(element.confirmCalls[0]?.title, "Delete Directory Rule");

		await element.confirmCalls[0]?.onConfirm();
		await element.updateComplete;

		assert.deepEqual(element.deleteDirectoryRule.mock.calls, [["rule-1"]]);
		assert.equal(element.getDirectoryRules.mock.calls.length, 2);
		assert.deepEqual(element.toastCalls, [
			{ message: "Rule deleted", type: "success" },
		]);
	});
});
