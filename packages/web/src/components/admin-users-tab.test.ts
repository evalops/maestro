import { fixture, html } from "@open-wc/testing";
import { LitElement } from "lit";
import { assert, describe, it, vi } from "vitest";
import type { OrgMember, Role } from "../services/enterprise-api.js";
import { AdminUsersTab } from "./admin-users-tab.js";

type ConfirmCall = {
	title: string;
	message: string;
	confirmText: string;
	onConfirm: () => void | Promise<void>;
};

class TestAdminUsersHost extends LitElement {
	readonly toastCalls: Array<{ message: string; type: string }> = [];
	readonly confirmCalls: ConfirmCall[] = [];

	members: OrgMember[] = [];
	roles: Role[] = [];

	readonly getOrgMembers = vi.fn(async () => ({ members: this.members }));
	readonly getRoles = vi.fn(async () => ({ roles: this.roles }));
	readonly inviteUser = vi.fn(async () => undefined);
	readonly removeMember = vi.fn(async () => undefined);

	private readonly usersTab = new AdminUsersTab(
		this,
		() => ({
			getOrgMembers: this.getOrgMembers,
			getRoles: this.getRoles,
			inviteUser: this.inviteUser,
			removeMember: this.removeMember,
		}),
		(message, type) => {
			this.toastCalls.push({ message, type });
		},
		(options) => {
			this.confirmCalls.push(options);
		},
		(value) => value.toString(),
		(value) => value,
	);

	async load() {
		await this.usersTab.load();
	}

	override render() {
		return this.usersTab.render(false);
	}
}

if (!customElements.get("test-admin-users-host")) {
	customElements.define("test-admin-users-host", TestAdminUsersHost);
}

describe("AdminUsersTab", () => {
	it("keeps search handler context when filtering members", async () => {
		const element = await fixture<TestAdminUsersHost>(
			html`<test-admin-users-host></test-admin-users-host>`,
		);
		element.members = [
			{
				id: "member-1",
				userId: "user-1",
				user: {
					id: "user-1",
					email: "alice@example.com",
					name: "Alice",
					isActive: true,
				},
				roleId: "developer",
				role: {
					id: "developer",
					name: "Developer",
					isSystem: true,
				},
				tokenUsed: 120,
				joinedAt: "2026-04-01T00:00:00.000Z",
			},
			{
				id: "member-2",
				userId: "user-2",
				user: {
					id: "user-2",
					email: "bob@example.com",
					name: "Bob",
					isActive: true,
				},
				roleId: "admin",
				role: {
					id: "admin",
					name: "Admin",
					isSystem: true,
				},
				tokenUsed: 240,
				joinedAt: "2026-04-02T00:00:00.000Z",
			},
		];
		element.roles = [
			{ id: "developer", name: "Developer", isSystem: true },
			{ id: "admin", name: "Admin", isSystem: true },
		];
		await element.load();
		await element.updateComplete;

		const searchInput = element.shadowRoot?.querySelector(
			"input.search-input",
		) as HTMLInputElement | null;

		assert.ok(searchInput);

		searchInput.value = "bob";
		searchInput.dispatchEvent(
			new Event("input", { bubbles: true, composed: true }),
		);
		await element.updateComplete;

		const text = element.shadowRoot?.textContent ?? "";
		assert.include(text, "Team Members (2)");
		assert.include(text, "Bob");
		assert.notInclude(text, "Alice");
	});

	it("keeps invite handler context when submitting a new member", async () => {
		const element = await fixture<TestAdminUsersHost>(
			html`<test-admin-users-host></test-admin-users-host>`,
		);
		element.roles = [{ id: "developer", name: "Developer", isSystem: true }];
		await element.load();
		await element.updateComplete;

		const emailInput = element.shadowRoot?.querySelector(
			'input[type="email"]',
		) as HTMLInputElement | null;
		const inviteButton = element.shadowRoot?.querySelector(
			"button.btn-primary",
		) as HTMLButtonElement | null;

		assert.ok(emailInput);
		assert.ok(inviteButton);

		emailInput.value = "new-user@example.com";
		emailInput.dispatchEvent(
			new Event("input", { bubbles: true, composed: true }),
		);
		await element.updateComplete;

		inviteButton.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await element.updateComplete;

		assert.deepEqual(element.inviteUser.mock.calls, [
			["new-user@example.com", "developer"],
		]);
		assert.deepEqual(element.toastCalls, [
			{ message: "Invited new-user@example.com", type: "success" },
		]);
		assert.equal(element.getOrgMembers.mock.calls.length, 2);
		assert.equal(element.getRoles.mock.calls.length, 2);
		assert.equal(emailInput.value, "");
	});

	it("keeps remove handler context when confirming member removal", async () => {
		const element = await fixture<TestAdminUsersHost>(
			html`<test-admin-users-host></test-admin-users-host>`,
		);
		element.members = [
			{
				id: "member-1",
				userId: "user-1",
				user: {
					id: "user-1",
					email: "alice@example.com",
					name: "Alice",
					isActive: true,
				},
				roleId: "developer",
				role: {
					id: "developer",
					name: "Developer",
					isSystem: true,
				},
				tokenUsed: 120,
				joinedAt: "2026-04-01T00:00:00.000Z",
			},
		];
		element.roles = [{ id: "developer", name: "Developer", isSystem: true }];
		await element.load();
		await element.updateComplete;

		const removeButton = element.shadowRoot?.querySelector(
			"button.btn-danger",
		) as HTMLButtonElement | null;

		assert.ok(removeButton);

		removeButton.click();
		await element.updateComplete;

		assert.equal(element.confirmCalls.length, 1);
		assert.equal(element.confirmCalls[0]?.title, "Remove Team Member");

		await element.confirmCalls[0]?.onConfirm();
		await element.updateComplete;

		assert.deepEqual(element.removeMember.mock.calls, [["user-1"]]);
		assert.equal(element.getOrgMembers.mock.calls.length, 2);
		assert.equal(element.getRoles.mock.calls.length, 2);
		assert.deepEqual(element.toastCalls, [
			{ message: "Member removed", type: "success" },
		]);
	});
});
