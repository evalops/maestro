import { type LitElement, html } from "lit";
import type { ApiClient } from "../services/api-client.js";

type ToastType = "success" | "error" | "info";

type PolicyValidationClient = Pick<ApiClient, "validatePolicy">;

type PolicyValidationError = {
	path?: string;
	message: string;
};

type PolicyValidationResponse = {
	valid: boolean;
	errors?: PolicyValidationError[];
};

const DEFAULT_POLICY_JSON = JSON.stringify(
	{
		orgId: "your-org-id",
		tools: { allowed: [], blocked: [] },
		dependencies: { allowed: [], blocked: [] },
		models: { allowed: ["claude-*", "gpt-4*"], blocked: [] },
		skills: { required: [] },
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
			maxConcurrentSessions: 3,
		},
	},
	null,
	2,
);

const ENTERPRISE_CONTROL_AREAS = [
	{
		name: "Session Defaults",
		source: "limits.*",
		detail: "Token, duration, and concurrency defaults for managed sessions.",
	},
	{
		name: "Model Access",
		source: "models.*",
		detail: "Allowed and blocked model families, providers, and preview tiers.",
	},
	{
		name: "Command Policy",
		source: "tools.*",
		detail:
			"Tool execution guardrails for shell, file, and automation surfaces.",
	},
	{
		name: "MCP Server Policy",
		source: "enterprise MCP config",
		detail:
			"First-party and approved MCP server distribution through managed config.",
	},
	{
		name: "Security",
		source: "paths.*, dependencies.*",
		detail:
			"Filesystem and dependency controls for sensitive workspace boundaries.",
	},
	{
		name: "Network Policy",
		source: "network.*",
		detail:
			"Host allowlists, blocklists, localhost, and private-network restrictions.",
	},
	{
		name: "Git",
		source: "tools.*, paths.*",
		detail: "Repository-safe command access paired with protected path policy.",
	},
	{
		name: "Session Retention",
		source: "limits.*, audit retention",
		detail:
			"Session lifetime limits aligned with enterprise audit retention settings.",
	},
] as const;

export class AdminPolicyTab {
	private policyJson = DEFAULT_POLICY_JSON;

	private policyError: string | null = null;

	constructor(
		private readonly host: Pick<LitElement, "requestUpdate">,
		private readonly getApiClient: () => PolicyValidationClient | null,
		private readonly showToast: (message: string, type: ToastType) => void,
	) {}

	render() {
		return html`
			<div class="section">
				<div class="section-header">
					<h3>Enterprise Policy</h3>
					<span style="font-size: 0.7rem; color: var(--admin-text-tertiary);">
						Deploy via MDM to ~/.maestro/policy.json
					</span>
				</div>
				<div class="section-content">
					<p style="color: var(--admin-text-secondary); font-size: 0.8rem; margin-bottom: 1.25rem; line-height: 1.6;">
						Enterprise policies control which tools, models, paths, and network resources can be accessed.
						Deploy this configuration to managed devices via your MDM (Jamf, Intune, Kandji, etc.) targeting
						<code style="background: var(--admin-bg-surface); padding: 0.15rem 0.35rem;">~/.maestro/policy.json</code>.
					</p>

					${
						this.policyError
							? html`<div style="color: var(--admin-accent-red); font-size: 0.75rem; margin-bottom: 1rem; padding: 0.75rem; background: var(--admin-accent-red-dim); border-left: 2px solid var(--admin-accent-red);">${this.policyError}</div>`
							: ""
					}

					<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 0.75rem; margin-bottom: 1.25rem;">
						${ENTERPRISE_CONTROL_AREAS.map(
							(area) => html`
								<div style="border: 1px solid var(--admin-border-subtle); background: var(--admin-bg-surface); border-radius: 6px; padding: 0.85rem;">
									<div style="display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.45rem;">
										<div style="font-size: 0.82rem; font-weight: 600; color: var(--admin-text-primary);">${area.name}</div>
										<code style="font-size: 0.62rem; color: var(--admin-text-tertiary); background: var(--admin-bg-elevated); padding: 0.12rem 0.3rem; border-radius: 4px;">${area.source}</code>
									</div>
									<div style="font-size: 0.72rem; line-height: 1.5; color: var(--admin-text-secondary);">${area.detail}</div>
								</div>
							`,
						)}
					</div>

					<div class="form-group">
						<label class="form-label">Policy Configuration (JSON)</label>
						<textarea
							class="form-input"
							style="font-family: var(--font-mono); font-size: 0.75rem; min-height: 400px; line-height: 1.5; resize: vertical;"
							.value=${this.policyJson}
							@input=${this.handlePolicyInput}
						></textarea>
					</div>

					<div style="display: flex; gap: 0.75rem; margin-top: 1rem;">
						<button class="btn btn-primary" @click=${this.validatePolicy}>Validate</button>
						<button class="btn" @click=${this.formatPolicy}>Format</button>
						<button class="btn" @click=${this.copyPolicyToClipboard}>Export for MDM</button>
						<button class="btn" @click=${this.downloadPolicy}>Download JSON</button>
					</div>
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Policy Reference</h3>
				</div>
				<div class="section-content" style="padding: 0;">
					<table class="data-table">
						<thead>
							<tr>
								<th>Section</th>
								<th>Description</th>
								<th>Example Values</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td><code>orgId</code></td>
								<td>Organization ID that must match the signed-in user</td>
								<td><code>"org_abc123"</code></td>
							</tr>
							<tr>
								<td><code>tools.allowed</code></td>
								<td>Whitelist of allowed tool names (if set, only these tools work)</td>
								<td><code>["read", "write", "bash"]</code></td>
							</tr>
							<tr>
								<td><code>tools.blocked</code></td>
								<td>Blacklist of blocked tool names</td>
								<td><code>["bash", "background_tasks"]</code></td>
							</tr>
							<tr>
								<td><code>models.allowed</code></td>
								<td>Allowed model patterns (supports wildcards)</td>
								<td><code>["claude-*", "gpt-4o"]</code></td>
							</tr>
							<tr>
								<td><code>models.blocked</code></td>
								<td>Blocked model patterns</td>
								<td><code>["*-preview", "*-experimental"]</code></td>
							</tr>
							<tr>
								<td><code>skills.required</code></td>
								<td>Required skill names for workspace-controlled workflows</td>
								<td><code>["github:gh-address-comments"]</code></td>
							</tr>
							<tr>
								<td><code>paths.blocked</code></td>
								<td>Glob patterns for blocked file paths</td>
								<td><code>["/etc/**", "**/.env*"]</code></td>
							</tr>
							<tr>
								<td><code>paths.allowed</code></td>
								<td>If set, only these paths are accessible</td>
								<td><code>["/home/user/projects/**"]</code></td>
							</tr>
							<tr>
								<td><code>dependencies.blocked</code></td>
								<td>Blocked npm/pip package names</td>
								<td><code>["malicious-pkg"]</code></td>
							</tr>
							<tr>
								<td><code>network.blockedHosts</code></td>
								<td>Blocked hostnames for network requests</td>
								<td><code>["evil.com"]</code></td>
							</tr>
							<tr>
								<td><code>network.allowedHosts</code></td>
								<td>If set, only these hosts are reachable</td>
								<td><code>["api.github.com", "*.company.com"]</code></td>
							</tr>
							<tr>
								<td><code>network.blockLocalhost</code></td>
								<td>Block access to localhost/127.0.0.1</td>
								<td><code>true</code></td>
							</tr>
							<tr>
								<td><code>network.blockPrivateIPs</code></td>
								<td>Block access to private IP ranges (10.x, 192.168.x, etc.)</td>
								<td><code>true</code></td>
							</tr>
							<tr>
								<td><code>limits.maxTokensPerSession</code></td>
								<td>Maximum tokens allowed per session</td>
								<td><code>500000</code></td>
							</tr>
							<tr>
								<td><code>limits.maxSessionDurationMinutes</code></td>
								<td>Maximum session duration in minutes</td>
								<td><code>480</code></td>
							</tr>
							<tr>
								<td><code>limits.maxConcurrentSessions</code></td>
								<td>Maximum concurrent active sessions per policy scope</td>
								<td><code>3</code></td>
							</tr>
							<tr>
								<td><code>enterprise MCP config</code></td>
								<td>Managed MCP server source used alongside policy.json</td>
								<td><code>~/.maestro/mcp.json</code></td>
							</tr>
							<tr>
								<td><code>git safety</code></td>
								<td>Git command access is controlled through tools and path policy</td>
								<td><code>tools.blocked + paths.blocked</code></td>
							</tr>
						</tbody>
					</table>
				</div>
			</div>
		`;
	}

	private handlePolicyInput = (event: Event) => {
		this.policyJson = (event.target as HTMLTextAreaElement).value;
		this.policyError = null;
		this.host.requestUpdate();
	};

	private validatePolicy = async () => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(this.policyJson);
		} catch (error) {
			this.policyError = `Invalid JSON: ${error instanceof Error ? error.message : "Parse error"}`;
			this.host.requestUpdate();
			return;
		}

		const apiClient = this.getApiClient();
		if (!apiClient) {
			this.policyError = null;
			this.showToast(
				"Policy JSON syntax is valid (schema validation unavailable)",
				"info",
			);
			this.host.requestUpdate();
			return;
		}

		try {
			const result = (await apiClient.validatePolicy(
				parsed as Record<string, unknown>,
			)) as PolicyValidationResponse;
			if (result.valid) {
				this.policyError = null;
				this.showToast("Policy JSON is valid", "success");
			} else {
				const errorMessages = (result.errors ?? [])
					.map((error) => `${error.path || "/"}: ${error.message}`)
					.join("; ");
				this.policyError = `Schema validation failed: ${errorMessages}`;
			}
		} catch {
			this.policyError = null;
			this.showToast(
				"Policy JSON syntax is valid (schema validation unavailable)",
				"info",
			);
		}
		this.host.requestUpdate();
	};

	private formatPolicy = () => {
		try {
			const parsed = JSON.parse(this.policyJson);
			this.policyJson = JSON.stringify(parsed, null, 2);
			this.policyError = null;
		} catch (error) {
			this.policyError = `Cannot format invalid JSON: ${error instanceof Error ? error.message : "Parse error"}`;
		}
		this.host.requestUpdate();
	};

	private copyPolicyToClipboard = async () => {
		try {
			await navigator.clipboard.writeText(this.policyJson);
			this.showToast(
				"Policy JSON copied - ready for MDM deployment",
				"success",
			);
		} catch {
			this.showToast("Failed to copy to clipboard", "error");
		}
	};

	private downloadPolicy = () => {
		try {
			JSON.parse(this.policyJson);
			const blob = new Blob([this.policyJson], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = "policy.json";
			anchor.click();
			URL.revokeObjectURL(url);
			this.showToast("Policy downloaded", "success");
		} catch {
			this.showToast("Fix JSON errors before downloading", "error");
		}
	};
}
