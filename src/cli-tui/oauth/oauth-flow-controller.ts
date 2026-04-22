import { execFile } from "node:child_process";
import { Spacer, type TUI, Text } from "@evalops/tui";
import type { Container } from "@evalops/tui";
import type { SupportedOAuthProvider } from "../../oauth/index.js";
import { theme } from "../../theme/theme.js";
import type { ModalManager } from "../modal-manager.js";
import type { NotificationView } from "../notification-view.js";
import { OAuthSelectorView } from "../selectors/oauth-selector-view.js";
import { formatLink } from "../utils/links.js";

const OSC52_PREFIX = "\u001b]52;c;";
const OSC52_SUFFIX = "\u0007";

function copyToOsc52(value: string): boolean {
	if (!process.stdout.isTTY) {
		return false;
	}
	const base64 = Buffer.from(value).toString("base64");
	process.stdout.write(`${OSC52_PREFIX}${base64}${OSC52_SUFFIX}`);
	return true;
}

/**
 * Callback interface for editor interactions during OAuth flow.
 */
export interface OAuthEditorCallbacks {
	clearEditor(): void;
	getText(): string;
	setText(text: string): void;
	onSubmit: ((text: string) => void) | undefined;
}

/**
 * Context for rendering OAuth UI elements.
 */
export interface OAuthRenderContext {
	chatContainer: Container;
	ui: TUI;
	requestRender(): void;
}

/**
 * Options for the OAuth flow controller.
 */
export interface OAuthFlowControllerOptions {
	modalManager: ModalManager;
	notificationView: NotificationView;
	renderContext: OAuthRenderContext;
	editorCallbacks: OAuthEditorCallbacks;
}

/**
 * Controller for handling OAuth login and logout flows.
 *
 * Extracts OAuth flow logic from TuiRenderer to provide a cohesive unit
 * for authentication operations.
 */
export class OAuthFlowController {
	private readonly modalManager: ModalManager;
	private readonly notificationView: NotificationView;
	private readonly renderContext: OAuthRenderContext;
	private readonly editorCallbacks: OAuthEditorCallbacks;
	private isOAuthFlowActive = false;
	private oauthLoginView?: OAuthSelectorView;
	private oauthLogoutView?: OAuthSelectorView;

	constructor(options: OAuthFlowControllerOptions) {
		this.modalManager = options.modalManager;
		this.notificationView = options.notificationView;
		this.renderContext = options.renderContext;
		this.editorCallbacks = options.editorCallbacks;
	}

	/**
	 * Check if an OAuth flow is currently active.
	 */
	isActive(): boolean {
		return this.isOAuthFlowActive;
	}

	/**
	 * Handle the /login command.
	 */
	async handleLoginCommand(
		argumentText: string,
		showError: (msg: string) => void,
	): Promise<void> {
		if (this.isOAuthFlowActive) {
			showError(
				"An OAuth flow is already in progress. Please complete or cancel it first.",
			);
			return;
		}

		this.isOAuthFlowActive = true;

		const args = argumentText.trim().toLowerCase();

		// Parse argument: can be either "mode" or "provider:mode"
		let requestedProvider: string | undefined;
		let selectedMode = "pro";
		const validModes = ["pro", "console"];

		if (args) {
			if (args.includes(":")) {
				const parts = args.split(":").map((s) => s.trim());
				requestedProvider = parts[0];
				const mode = parts[1];
				if (mode && !validModes.includes(mode)) {
					this.isOAuthFlowActive = false;
					showError(
						`Invalid mode: ${mode}. Valid modes: ${validModes.join(", ")}`,
					);
					return;
				}
				selectedMode = mode && validModes.includes(mode) ? mode : "pro";
			} else {
				if (validModes.includes(args)) {
					selectedMode = args;
				} else {
					requestedProvider = args;
				}
			}
		}

		// Import OAuth system
		const { getOAuthProviders, migrateOAuthCredentials } = await import(
			"../../oauth/index.js"
		);

		// Migrate old credentials if needed
		await migrateOAuthCredentials();

		// Get available providers
		const providers = getOAuthProviders().filter((p) => p.available);

		if (providers.length === 0) {
			this.isOAuthFlowActive = false;
			showError("No OAuth providers available");
			return;
		}

		// If only one provider or specific provider requested, use it directly
		if (providers.length === 1 || requestedProvider) {
			const provider = requestedProvider
				? providers.find(
						(p) =>
							p.id === requestedProvider || p.id.includes(requestedProvider),
					)
				: providers[0];

			if (!provider) {
				this.isOAuthFlowActive = false;
				showError(`Unknown provider: ${requestedProvider}`);
				return;
			}

			await this.performOAuthLogin(provider.id, selectedMode, showError);
			return;
		}

		// Multiple providers - show selector
		this.oauthLoginView = new OAuthSelectorView({
			modalManager: this.modalManager,
			ui: this.renderContext.ui,
			mode: "login",
			onProviderSelected: async (providerId) => {
				try {
					await this.performOAuthLogin(providerId, selectedMode, showError);
				} finally {
					this.isOAuthFlowActive = false;
				}
			},
			onCancel: () => {
				this.isOAuthFlowActive = false;
				this.notificationView.showInfo("Login cancelled");
			},
		});

		this.oauthLoginView.show();
	}

	/**
	 * Handle the /logout command.
	 */
	async handleLogoutCommand(
		argumentText: string,
		showError: (msg: string) => void,
		showInfo: (msg: string) => void,
	): Promise<void> {
		if (this.isOAuthFlowActive) {
			showError(
				"An OAuth flow is already in progress. Please complete or cancel it first.",
			);
			return;
		}

		this.isOAuthFlowActive = true;

		const args = argumentText.trim().toLowerCase();
		const requestedProvider = args || null;

		// Import OAuth system
		const { listOAuthProviders } = await import("../../oauth/index.js");

		// Get logged-in providers
		const loggedInProviders = listOAuthProviders();

		if (loggedInProviders.length === 0) {
			this.isOAuthFlowActive = false;
			showInfo("No OAuth providers logged in. Use /login first.");
			return;
		}

		// If specific provider requested or only one logged in, use it directly
		if (loggedInProviders.length === 1 || requestedProvider) {
			const provider = requestedProvider
				? loggedInProviders.find(
						(p) => p === requestedProvider || p.includes(requestedProvider),
					)
				: loggedInProviders[0];

			if (!provider) {
				this.isOAuthFlowActive = false;
				showError(`Not logged in to: ${requestedProvider}`);
				return;
			}

			await this.performOAuthLogout(
				provider as SupportedOAuthProvider,
				showError,
			);
			this.isOAuthFlowActive = false;
			return;
		}

		// Multiple providers - show selector
		this.oauthLogoutView = new OAuthSelectorView({
			modalManager: this.modalManager,
			ui: this.renderContext.ui,
			mode: "logout",
			onProviderSelected: async (providerId) => {
				try {
					await this.performOAuthLogout(providerId, showError);
				} finally {
					this.isOAuthFlowActive = false;
				}
			},
			onCancel: () => {
				this.isOAuthFlowActive = false;
				this.notificationView.showInfo("Logout cancelled");
			},
		});

		this.oauthLogoutView.show();
	}

	/**
	 * Handle the /auth source-of-truth command.
	 */
	async handleSourceOfTruthPolicyCommand(
		argumentText: string,
		showError: (msg: string) => void,
		showInfo: (msg: string) => void,
	): Promise<void> {
		const args = argumentText.trim().split(/\s+/).filter(Boolean);
		const usage =
			"Usage: /auth source-of-truth <provider> <area> [fallbackConnectionId]\n" +
			"       /auth source-of-truth clear <provider>\n" +
			"Areas: analytics, billing, crm, hris, support";
		if (
			args.length === 0 ||
			["help", "?", "-h", "--help"].includes(args[0]?.toLowerCase() ?? "")
		) {
			showInfo(usage);
			return;
		}

		const subcommand = args[0]?.toLowerCase();
		try {
			if (["clear", "unset", "remove"].includes(subcommand ?? "")) {
				const provider = args[1];
				if (!provider || args.length > 2) {
					showError(usage);
					return;
				}
				const { clearOAuthProviderSourceOfTruthPolicy } = await import(
					"../../oauth/connectors.js"
				);
				const cleared = clearOAuthProviderSourceOfTruthPolicy(provider);
				showInfo(
					cleared
						? `Source-of-truth policy metadata cleared for ${provider}.`
						: `No source-of-truth policy metadata was set for ${provider}.`,
				);
				return;
			}

			const provider = args[0];
			const area = args[1];
			const fallbackConnectionId = args[2];
			if (!provider || !area || args.length > 3) {
				showError(usage);
				return;
			}

			const { configureOAuthProviderSourceOfTruthPolicy } = await import(
				"../../oauth/connectors.js"
			);
			const configured = await configureOAuthProviderSourceOfTruthPolicy(
				provider,
				{ area, fallbackConnectionId },
			);
			const details = [
				`Source-of-truth policy metadata configured for ${configured.provider}.`,
				`Area: ${configured.area}`,
				...(configured.fallbackConnectionId
					? [`Fallback connection: ${configured.fallbackConnectionId}`]
					: []),
				...(configured.connectorConnectionId
					? [`Connector connection: ${configured.connectorConnectionId}`]
					: []),
				...(configured.primaryConnectionId
					? [`Platform primary connection: ${configured.primaryConnectionId}`]
					: [
							"Platform policy will sync when the connector service integration is configured and reachable.",
						]),
				...(configured.workspaceId
					? [`Workspace: ${configured.workspaceId}`]
					: []),
			];
			showInfo(details.join("\n"));
		} catch (error) {
			showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async performOAuthLogin(
		providerId: SupportedOAuthProvider,
		mode: string,
		showError: (msg: string) => void,
	): Promise<void> {
		const { login } = await import("../../oauth/index.js");

		const { chatContainer, ui, requestRender } = this.renderContext;
		const requiresPromptCode = providerId === "anthropic";

		chatContainer.addChild(new Spacer(1));
		chatContainer.addChild(new Text(`Logging in to ${providerId}...`, 1, 0));
		requestRender();

		try {
			await login(providerId, {
				mode: mode as "pro" | "console" | undefined,
				onStatus: (status: string) => {
					chatContainer.addChild(new Spacer(1));
					chatContainer.addChild(new Text(status, 1, 0));
					requestRender();
				},
				onAuthUrl: (url: string) => {
					chatContainer.addChild(new Spacer(1));
					chatContainer.addChild(new Text("Opening browser to:", 1, 0));
					chatContainer.addChild(new Spacer(1));
					if (process.stdout.isTTY) {
						chatContainer.addChild(
							new Text(
								theme.fg("accent", formatLink(url, "Open login URL")),
								1,
								0,
							),
						);
					}
					chatContainer.addChild(new Text(url, 1, 0));
					chatContainer.addChild(new Spacer(1));
					if (copyToOsc52(url)) {
						chatContainer.addChild(
							new Text(
								theme.fg(
									"dim",
									"(Clipboard copy requested via OSC-52; paste in browser if supported.)",
								),
								1,
								0,
							),
						);
						chatContainer.addChild(new Spacer(1));
					}
					if (requiresPromptCode) {
						chatContainer.addChild(
							new Text(
								"Paste the authorization code below (or type 'cancel' to abort):",
								1,
								0,
							),
						);
					} else {
						chatContainer.addChild(
							new Text(
								"Complete authentication in the browser, then return here.",
								1,
								0,
							),
						);
					}
					requestRender();

					// Auto-open browser using execFile for security
					const openCmd =
						process.platform === "darwin"
							? "open"
							: process.platform === "win32"
								? "cmd"
								: "xdg-open";
					const args =
						process.platform === "win32" ? ["/c", "start", "", url] : [url];
					execFile(openCmd, args, (error) => {
						if (error) {
							this.notificationView.showInfo(
								"Could not auto-open browser. Please copy the URL manually.",
							);
						}
					});
				},
				onDeviceCode: (code: string, verificationUri: string) => {
					chatContainer.addChild(new Spacer(1));
					chatContainer.addChild(new Text("Authenticate by visiting:", 1, 0));
					chatContainer.addChild(new Spacer(1));
					if (process.stdout.isTTY) {
						chatContainer.addChild(
							new Text(
								theme.fg(
									"accent",
									formatLink(verificationUri, "Open verification URL"),
								),
								1,
								0,
							),
						);
					}
					chatContainer.addChild(new Text(verificationUri, 1, 0));
					chatContainer.addChild(new Spacer(1));
					if (copyToOsc52(verificationUri)) {
						chatContainer.addChild(
							new Text(
								theme.fg(
									"dim",
									"(Clipboard copy requested via OSC-52; paste in browser if supported.)",
								),
								1,
								0,
							),
						);
						chatContainer.addChild(new Spacer(1));
					}
					chatContainer.addChild(new Text(`Enter code: ${code}`, 1, 0));
					chatContainer.addChild(new Spacer(1));
					chatContainer.addChild(
						new Text("Waiting for authorization...", 1, 0),
					);
					requestRender();

					const openCmd =
						process.platform === "darwin"
							? "open"
							: process.platform === "win32"
								? "cmd"
								: "xdg-open";
					const args =
						process.platform === "win32"
							? ["/c", "start", "", verificationUri]
							: [verificationUri];
					execFile(openCmd, args, (error) => {
						if (error) {
							this.notificationView.showInfo(
								"Could not auto-open browser. Please copy the URL manually.",
							);
						}
					});
				},
				onPromptCode: async () => {
					const originalOnSubmit = this.editorCallbacks.onSubmit;
					return new Promise<string>((resolve, reject) => {
						const timeout = setTimeout(
							() => {
								reject(new Error("OAuth flow timed out after 5 minutes"));
							},
							5 * 60 * 1000,
						);

						this.editorCallbacks.onSubmit = (text) => {
							const trimmedText = text.trim();

							if (trimmedText.toLowerCase() === "cancel") {
								clearTimeout(timeout);
								this.editorCallbacks.clearEditor();
								reject(new Error("OAuth flow cancelled by user"));
								return;
							}

							// Basic authorization code validation
							if (
								trimmedText.length < 10 ||
								!/^[a-zA-Z0-9_#-]+$/.test(trimmedText)
							) {
								this.notificationView.showError(
									"Invalid authorization code format. Please try again or type 'cancel'.",
								);
								this.editorCallbacks.clearEditor();
								return;
							}

							clearTimeout(timeout);
							this.editorCallbacks.clearEditor();
							resolve(trimmedText);
						};
					}).finally(() => {
						this.editorCallbacks.onSubmit = originalOnSubmit;
					});
				},
			});

			this.notificationView.showToast(
				`Successfully authenticated with ${providerId}!`,
				"success",
			);
			chatContainer.addChild(new Spacer(1));
			chatContainer.addChild(
				new Text(
					`Authentication complete. ${providerId} OAuth credentials saved.`,
					1,
					0,
				),
			);
			requestRender();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Login failed";

			let errorDetail = message;
			if (message.includes("timeout")) {
				errorDetail = "OAuth flow timed out after 5 minutes. Please try again.";
			} else if (message.includes("cancel")) {
				errorDetail = "OAuth flow cancelled by user.";
			} else if (message.includes("Invalid") || message.includes("failed")) {
				errorDetail = `${message}. The authorization code may be expired or invalid.`;
			}

			showError(errorDetail);
			chatContainer.addChild(new Spacer(1));
			chatContainer.addChild(new Text(`Login failed: ${errorDetail}`, 1, 0));
			requestRender();
		} finally {
			this.isOAuthFlowActive = false;
		}
	}

	private async performOAuthLogout(
		providerId: SupportedOAuthProvider,
		showError: (msg: string) => void,
	): Promise<void> {
		const { chatContainer, requestRender } = this.renderContext;

		try {
			const { logout } = await import("../../oauth/index.js");
			await logout(providerId);

			this.notificationView.showToast(
				`${providerId} OAuth credentials removed`,
				"success",
			);
			chatContainer.addChild(new Spacer(1));
			chatContainer.addChild(
				new Text(
					`Logged out from ${providerId}. OAuth credentials removed.`,
					1,
					0,
				),
			);
			requestRender();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Logout failed";
			showError(message);
		}
	}
}
