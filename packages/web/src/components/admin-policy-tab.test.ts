import { fixture, html } from "@open-wc/testing";
import { LitElement } from "lit";
import { assert, afterEach, describe, it, vi } from "vitest";
import type { PolicyValidationResponse } from "../services/api-client.js";
import { AdminPolicyTab } from "./admin-policy-tab.js";

type PolicyClient = {
	validatePolicy: (
		policy: Record<string, unknown>,
	) => Promise<PolicyValidationResponse>;
};

class TestAdminPolicyHost extends LitElement {
	readonly toastCalls: Array<{ message: string; type: string }> = [];
	policyClient: PolicyClient | null = null;

	private readonly policyTab = new AdminPolicyTab(
		this,
		() => this.policyClient,
		(message, type) => {
			this.toastCalls.push({ message, type });
		},
	);

	override render() {
		return this.policyTab.render();
	}
}

if (!customElements.get("test-admin-policy-host")) {
	customElements.define("test-admin-policy-host", TestAdminPolicyHost);
}

describe("AdminPolicyTab", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps policy handler context when formatting JSON", async () => {
		const element = await fixture<TestAdminPolicyHost>(
			html`<test-admin-policy-host></test-admin-policy-host>`,
		);
		await element.updateComplete;

		const textarea = element.shadowRoot?.querySelector(
			"textarea",
		) as HTMLTextAreaElement | null;
		const formatButton = element.shadowRoot?.querySelectorAll("button")[1] as
			| HTMLButtonElement
			| undefined;

		assert.ok(textarea);
		assert.ok(formatButton);

		textarea.value = '{"orgId":"org_123","tools":{"allowed":[],"blocked":[]}}';
		textarea.dispatchEvent(
			new Event("input", { bubbles: true, composed: true }),
		);
		await element.updateComplete;

		formatButton.click();
		await element.updateComplete;

		assert.include(textarea.value, "\n");
		assert.deepEqual(element.toastCalls, []);
	});

	it("keeps policy handler context when validating JSON", async () => {
		const validatePolicy = vi
			.fn<PolicyClient["validatePolicy"]>()
			.mockResolvedValue({ valid: true, errors: [] });

		const element = await fixture<TestAdminPolicyHost>(
			html`<test-admin-policy-host></test-admin-policy-host>`,
		);
		element.policyClient = { validatePolicy };
		await element.updateComplete;

		const validateButton = element.shadowRoot?.querySelector(
			"button",
		) as HTMLButtonElement | null;

		assert.ok(validateButton);

		validateButton.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await element.updateComplete;

		assert.equal(validatePolicy.mock.calls.length, 1);
		assert.deepEqual(validatePolicy.mock.calls[0]?.[0], {
			orgId: "your-org-id",
			tools: { allowed: [], blocked: [] },
			dependencies: { allowed: [], blocked: [] },
			models: { allowed: ["claude-*", "gpt-4*"], blocked: [] },
			paths: {
				allowed: [],
				blocked: ["/etc/**", "**/.env*", "**/secrets/**"],
			},
			network: {
				allowedHosts: [],
				blockedHosts: [],
				blockLocalhost: false,
				blockPrivateIPs: false,
			},
			limits: {
				maxTokensPerSession: 500000,
				maxSessionDurationMinutes: 480,
			},
		});
		assert.deepEqual(element.toastCalls, [
			{ message: "Policy JSON is valid", type: "success" },
		]);
	});
});
