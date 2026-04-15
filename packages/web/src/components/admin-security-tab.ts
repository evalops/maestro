import { type LitElement, html } from "lit";
import type {
	EnterpriseApiClient,
	OrganizationSettings,
} from "../services/enterprise-api.js";

type ToastType = "success" | "error" | "info";

type SecuritySettingsClient = Pick<
	EnterpriseApiClient,
	"getOrgSettings" | "updateOrgSettings"
>;

type SecurityState = {
	orgSettings: OrganizationSettings | null;
	piiPatterns: string;
	auditRetention: number;
	webhookUrls: string;
};

export class AdminSecurityTab {
	constructor(
		private readonly host: Pick<LitElement, "requestUpdate">,
		private readonly getApi: () => SecuritySettingsClient,
		private readonly getState: () => SecurityState,
		private readonly setState: (state: Partial<SecurityState>) => void,
		private readonly showToast: (message: string, type: ToastType) => void,
	) {}

	async load() {
		const settings = await this.getApi()
			.getOrgSettings()
			.catch(() => null);
		this.setState({
			orgSettings: settings,
			piiPatterns: settings?.piiPatterns?.join("\n") || "",
			auditRetention: settings?.auditRetentionDays || 90,
			webhookUrls: settings?.alertWebhooks?.join("\n") || "",
		});
	}

	render(tabLoading: boolean) {
		if (tabLoading) {
			return html`<div class="tab-loading"><span class="spinner"></span>Loading security settings...</div>`;
		}

		const state = this.getState();

		return html`
			<div class="section">
				<div class="section-header">
					<h3>PII Detection Settings</h3>
				</div>
				<div class="section-content">
					<div class="form-group">
						<label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
							<input type="checkbox" ?checked=${state.orgSettings?.piiRedactionEnabled ?? true} />
							<span>Enable PII auto-detection and redaction</span>
						</label>
					</div>
					<div class="form-group">
						<label class="form-label">Custom PII Patterns (one regex per line)</label>
						<textarea
							class="form-input"
							rows="4"
							placeholder="EMP-\\d{6}
INTERNAL-[A-Z]{3}-\\d{4}"
							.value=${state.piiPatterns}
							@input=${this.handlePiiPatternsInput}
						></textarea>
					</div>
					<button class="btn btn-primary" @click=${this.handleSavePiiSettings}>Save Settings</button>
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Audit Retention</h3>
				</div>
				<div class="section-content">
					<div class="form-group">
						<label class="form-label">Retention Period (days)</label>
						<input
							type="number"
							class="form-input"
							min="30"
							max="365"
							.value=${String(state.auditRetention)}
							@input=${this.handleAuditRetentionInput}
						/>
					</div>
					<button class="btn btn-primary" @click=${this.handleSaveRetention}>Update</button>
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Alert Webhooks</h3>
				</div>
				<div class="section-content">
					<div class="form-group">
						<label class="form-label">Webhook URLs (one per line)</label>
						<textarea
							class="form-input"
							rows="3"
							placeholder="https://hooks.slack.com/services/..."
							.value=${state.webhookUrls}
							@input=${this.handleWebhookUrlsInput}
						></textarea>
					</div>
					<button class="btn btn-primary" @click=${this.handleSaveWebhooks}>Save Webhooks</button>
				</div>
			</div>
		`;
	}

	private readonly handlePiiPatternsInput = (event: Event) => {
		this.setState({
			piiPatterns: (event.target as HTMLTextAreaElement).value,
		});
	};

	private readonly handleAuditRetentionInput = (event: Event) => {
		this.setState({
			auditRetention:
				Number.parseInt((event.target as HTMLInputElement).value, 10) || 90,
		});
	};

	private readonly handleWebhookUrlsInput = (event: Event) => {
		this.setState({
			webhookUrls: (event.target as HTMLTextAreaElement).value,
		});
	};

	private readonly handleSavePiiSettings = async () => {
		try {
			const patterns = this.getState()
				.piiPatterns.split("\n")
				.map((pattern) => pattern.trim())
				.filter(Boolean);

			await this.getApi().updateOrgSettings({
				piiRedactionEnabled: true,
				piiPatterns: patterns,
			});
			this.showToast("PII settings saved", "success");
		} catch (error) {
			this.showToast(
				error instanceof Error ? error.message : "Failed to save settings",
				"error",
			);
		}
	};

	private readonly handleSaveRetention = async () => {
		try {
			await this.getApi().updateOrgSettings({
				auditRetentionDays: this.getState().auditRetention,
			});
			this.showToast("Retention settings saved", "success");
		} catch (error) {
			this.showToast(
				error instanceof Error ? error.message : "Failed to save settings",
				"error",
			);
		}
	};

	private readonly handleSaveWebhooks = async () => {
		try {
			const webhooks = this.getState()
				.webhookUrls.split("\n")
				.map((url) => url.trim())
				.filter(Boolean);

			await this.getApi().updateOrgSettings({
				alertWebhooks: webhooks,
			});
			this.showToast("Webhooks saved", "success");
		} catch (error) {
			this.showToast(
				error instanceof Error ? error.message : "Failed to save webhooks",
				"error",
			);
		}
	};
}
