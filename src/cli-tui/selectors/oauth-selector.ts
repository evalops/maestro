import { Container, Spacer, Text } from "@evalops/tui";
import type {
	OAuthProviderInfo,
	SupportedOAuthProvider,
} from "../../oauth/index.js";
import { getOAuthProviders, hasOAuthCredentials } from "../../oauth/index.js";

/**
 * Component that renders an OAuth provider selector
 */
export class OAuthSelectorComponent extends Container {
	private listContainer: Container;
	private allProviders: OAuthProviderInfo[] = [];
	private selectedIndex = 0;
	private mode: "login" | "logout";

	constructor(
		mode: "login" | "logout",
		private onSelectCallback: (providerId: SupportedOAuthProvider) => void,
		private onCancelCallback: () => void,
	) {
		super();

		this.mode = mode;

		// Load providers
		this.loadProviders();

		this.addChild(new Spacer(1));

		// Add title
		const title =
			mode === "login"
				? "Select provider to login:"
				: "Select provider to logout:";
		this.addChild(new Text(title, 0, 0));
		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Initial render
		this.updateList();
	}

	private loadProviders(): void {
		this.allProviders = getOAuthProviders();

		// For logout mode, only show providers with credentials
		if (this.mode === "logout") {
			this.allProviders = this.allProviders.filter((p) =>
				hasOAuthCredentials(p.id),
			);
		} else {
			// For login mode, only show available providers
			this.allProviders = this.allProviders.filter((p) => p.available);
		}
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.allProviders.length === 0) {
			const message =
				this.mode === "login"
					? "No OAuth providers available"
					: "No OAuth providers logged in. Use /login first.";
			this.listContainer.addChild(new Text(`  ${message}`, 0, 0));
			return;
		}

		for (let i = 0; i < this.allProviders.length; i++) {
			const provider = this.allProviders[i];
			if (!provider) continue;

			const isSelected = i === this.selectedIndex;
			const isAvailable = provider.available;

			let line = "";
			if (isSelected) {
				line = `→ ${provider.name} - ${provider.description}`;
			} else {
				line = `  ${provider.name} - ${provider.description}`;
			}

			if (!isAvailable) {
				line = `  ${provider.name} - ${provider.description} (coming soon)`;
			}

			this.listContainer.addChild(new Text(line, 0, 0));
		}

		// Add help text
		this.listContainer.addChild(new Spacer(1));
		this.listContainer.addChild(
			new Text("Use ↑↓ to navigate, Enter to select, Esc to cancel", 0, 0),
		);
	}

	handleInput(keyData: string): void {
		// Up arrow
		if (keyData === "\x1b[A") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		}
		// Down arrow
		else if (keyData === "\x1b[B") {
			this.selectedIndex = Math.min(
				this.allProviders.length - 1,
				this.selectedIndex + 1,
			);
			this.updateList();
		}
		// Enter
		else if (keyData === "\r") {
			const selectedProvider = this.allProviders[this.selectedIndex];
			// Guard against undefined provider (e.g., empty array)
			if (
				selectedProvider &&
				(selectedProvider.available || this.mode === "logout")
			) {
				this.onSelectCallback(selectedProvider.id);
			}
		}
		// Escape
		else if (keyData === "\x1b") {
			this.onCancelCallback();
		}
	}
}
