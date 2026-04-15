import { type LitElement, html } from "lit";
import type {
	EnterpriseApiClient,
	OrgMember,
	Role,
} from "../services/enterprise-api.js";

type ToastType = "success" | "error" | "info";

type ConfirmDialog = {
	title: string;
	message: string;
	confirmText: string;
	onConfirm: () => void | Promise<void>;
};

type UserManagementClient = Pick<
	EnterpriseApiClient,
	"getOrgMembers" | "getRoles" | "inviteUser" | "removeMember"
>;

export class AdminUsersTab {
	private members: OrgMember[];

	private roles: Role[];

	private userSearch = "";

	private inviteEmail = "";

	private inviteRoleId = "developer";

	constructor(
		private readonly host: Pick<LitElement, "requestUpdate">,
		private readonly getApi: () => UserManagementClient,
		private readonly showToast: (message: string, type: ToastType) => void,
		private readonly showConfirm: (options: ConfirmDialog) => void,
		private readonly formatNumber: (value: number) => string,
		private readonly formatDate: (value: string) => string,
		initialMembers: OrgMember[] = [],
		initialRoles: Role[] = [],
	) {
		this.members = [...initialMembers];
		this.roles = [...initialRoles];
		this.syncInviteRoleSelection();
	}

	async load() {
		const api = this.getApi();
		const [membersRes, rolesRes] = await Promise.all([
			api.getOrgMembers().catch(() => ({ members: [] })),
			api.getRoles().catch(() => ({ roles: [] })),
		]);

		this.members = membersRes.members;
		this.roles = rolesRes.roles;
		this.syncInviteRoleSelection();
		this.host.requestUpdate();
	}

	render(tabLoading: boolean) {
		if (tabLoading) {
			return html`<div class="tab-loading"><span class="spinner"></span>Loading users...</div>`;
		}

		const filteredMembers = this.filteredMembers;
		const canInvite = this.roles.length > 0;

		return html`
			<div class="section">
				<div class="section-header">
					<h3>Invite New User</h3>
				</div>
				<div class="section-content">
					<div style="display: flex; gap: 0.75rem; align-items: flex-end;">
						<div class="form-group" style="flex: 1; margin-bottom: 0;">
							<label class="form-label">Email Address</label>
							<input
								type="email"
								class="form-input"
								placeholder="user@example.com"
								.value=${this.inviteEmail}
								@input=${this.handleInviteEmailInput}
							/>
						</div>
						<div class="form-group" style="width: 180px; margin-bottom: 0;">
							<label class="form-label">Role</label>
							<select
								class="form-input"
								?disabled=${!canInvite}
								.value=${this.inviteRoleId}
								@change=${this.handleInviteRoleChange}
							>
								${this.roles.map((role) => html`<option value=${role.id}>${role.name}</option>`)}
							</select>
						</div>
						<button class="btn btn-primary" ?disabled=${!canInvite} @click=${this.handleInviteUser}>Invite</button>
					</div>
					${
						canInvite
							? ""
							: html`<div class="empty-state" style="padding: 1rem 0 0;">No roles available. Please wait for roles to load before inviting users.</div>`
					}
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Team Members (${this.members.length})</h3>
				</div>
				<div class="section-content">
					<input
						type="text"
						class="search-input"
						placeholder="Search by name or email..."
						.value=${this.userSearch}
						@input=${this.handleUserSearchInput}
					/>
					${
						filteredMembers.length > 0
							? html`
								<table class="data-table">
									<thead>
										<tr>
											<th>User</th>
											<th>Role</th>
											<th>Token Usage</th>
											<th>Joined</th>
											<th>Actions</th>
										</tr>
									</thead>
									<tbody>
										${filteredMembers.map(
											(member) => html`
												<tr>
													<td>
														<strong>${member.user.name}</strong><br />
														<span style="color: var(--text-tertiary); font-size: 0.75rem;">
															${member.user.email}
														</span>
													</td>
													<td>
														<span class="badge info">${member.role.name}</span>
													</td>
													<td>
														${this.formatNumber(member.tokenUsed)}
														${member.tokenQuota ? `/ ${this.formatNumber(member.tokenQuota)}` : ""}
													</td>
													<td>${this.formatDate(member.joinedAt)}</td>
													<td>
														<div class="action-row">
															<button class="btn btn-sm btn-danger" @click=${() => this.confirmRemoveMember(member)}>Remove</button>
														</div>
													</td>
												</tr>
											`,
										)}
									</tbody>
								</table>
							`
							: html`<div class="empty-state">${this.userSearch ? "No matching members found" : "No team members found"}</div>`
					}
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Available Roles</h3>
				</div>
				<div class="section-content" style="padding: 0;">
					<table class="data-table">
						<thead>
							<tr>
								<th>Role</th>
								<th>Description</th>
								<th>Type</th>
							</tr>
						</thead>
						<tbody>
							${this.roles.map(
								(role) => html`
									<tr>
										<td><span class="badge info">${role.name}</span></td>
										<td>${role.description || "-"}</td>
										<td>${role.isSystem ? "System" : "Custom"}</td>
									</tr>
								`,
							)}
						</tbody>
					</table>
				</div>
			</div>
		`;
	}

	getMembers() {
		return this.members;
	}

	setMembers(members: OrgMember[]) {
		this.members = [...members];
		this.host.requestUpdate();
	}

	getRoles() {
		return this.roles;
	}

	setRoles(roles: Role[]) {
		this.roles = [...roles];
		this.syncInviteRoleSelection();
		this.host.requestUpdate();
	}

	getInviteEmail() {
		return this.inviteEmail;
	}

	setInviteEmail(value: string) {
		this.inviteEmail = value;
		this.host.requestUpdate();
	}

	getInviteRoleId() {
		return this.inviteRoleId;
	}

	setInviteRoleId(value: string) {
		this.inviteRoleId = value;
		this.host.requestUpdate();
	}

	private get filteredMembers(): OrgMember[] {
		if (!this.userSearch) return this.members;

		const search = this.userSearch.toLowerCase();
		return this.members.filter(
			(member) =>
				member.user.name?.toLowerCase().includes(search) ||
				member.user.email?.toLowerCase().includes(search),
		);
	}

	private syncInviteRoleSelection() {
		if (
			this.roles.length > 0 &&
			!this.roles.some((role) => role.id === this.inviteRoleId)
		) {
			this.inviteRoleId = this.roles[0]?.id ?? "";
		}
	}

	private readonly handleInviteEmailInput = (event: Event) => {
		this.inviteEmail = (event.target as HTMLInputElement).value;
		this.host.requestUpdate();
	};

	private readonly handleInviteRoleChange = (event: Event) => {
		this.inviteRoleId = (event.target as HTMLSelectElement).value;
		this.host.requestUpdate();
	};

	private readonly handleUserSearchInput = (event: Event) => {
		this.userSearch = (event.target as HTMLInputElement).value;
		this.host.requestUpdate();
	};

	readonly handleInviteUser = async () => {
		const hasSelectedRole = this.roles.some(
			(role) => role.id === this.inviteRoleId,
		);

		if (!this.inviteEmail || !this.inviteRoleId || !hasSelectedRole) {
			this.showToast("Please enter email and select a role", "error");
			return;
		}

		try {
			await this.getApi().inviteUser(this.inviteEmail, this.inviteRoleId);
			this.showToast(`Invited ${this.inviteEmail}`, "success");
			this.inviteEmail = "";
			await this.load();
		} catch (error) {
			this.showToast(
				error instanceof Error ? error.message : "Failed to invite user",
				"error",
			);
		}
	};

	private confirmRemoveMember(member: OrgMember) {
		this.showConfirm({
			title: "Remove Team Member",
			message: `Are you sure you want to remove ${member.user.name || member.user.email} from the organization? This action cannot be undone.`,
			confirmText: "Remove",
			onConfirm: async () => {
				try {
					await this.getApi().removeMember(member.userId);
					this.showToast("Member removed", "success");
					await this.load();
				} catch (error) {
					this.showToast(
						error instanceof Error ? error.message : "Failed to remove member",
						"error",
					);
				}
			},
		});
	}
}
