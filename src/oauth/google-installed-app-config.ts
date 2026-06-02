export type GoogleInstalledAppOAuthProvider =
	| "google-gemini-cli"
	| "google-antigravity";

export interface GoogleInstalledAppOAuthConfig {
	clientId: string;
	clientSecret: string;
}

interface ProviderConfig {
	displayName: string;
	clientIdEnv: string;
	clientSecretEnv: string;
	setupAction: string;
}

const PROVIDER_CONFIG: Record<GoogleInstalledAppOAuthProvider, ProviderConfig> =
	{
		"google-gemini-cli": {
			displayName: "Google Gemini CLI",
			clientIdEnv: "MAESTRO_GOOGLE_GEMINI_CLI_CLIENT_ID",
			clientSecretEnv: "MAESTRO_GOOGLE_GEMINI_CLI_CLIENT_SECRET",
			setupAction: "open the Maestro TUI and run /login google-gemini-cli",
		},
		"google-antigravity": {
			displayName: "Google Antigravity",
			clientIdEnv: "MAESTRO_GOOGLE_ANTIGRAVITY_CLIENT_ID",
			clientSecretEnv: "MAESTRO_GOOGLE_ANTIGRAVITY_CLIENT_SECRET",
			setupAction: "open the Maestro TUI and run /login google-antigravity",
		},
	};

export class MissingGoogleInstalledAppOAuthConfigError extends Error {
	readonly provider: GoogleInstalledAppOAuthProvider;

	constructor(provider: GoogleInstalledAppOAuthProvider, message: string) {
		super(message);
		this.name = "MissingGoogleInstalledAppOAuthConfigError";
		this.provider = provider;
	}
}

function readRequiredEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value && value.length > 0 ? value : undefined;
}

export function getGoogleInstalledAppOAuthEnvNames(
	provider: GoogleInstalledAppOAuthProvider,
): { clientIdEnv: string; clientSecretEnv: string } {
	const config = PROVIDER_CONFIG[provider];
	return {
		clientIdEnv: config.clientIdEnv,
		clientSecretEnv: config.clientSecretEnv,
	};
}

export function loadGoogleInstalledAppOAuthConfig(
	provider: GoogleInstalledAppOAuthProvider,
): GoogleInstalledAppOAuthConfig {
	const config = PROVIDER_CONFIG[provider];
	const clientId = readRequiredEnv(config.clientIdEnv);
	const clientSecret = readRequiredEnv(config.clientSecretEnv);

	if (!clientId || !clientSecret) {
		throw new MissingGoogleInstalledAppOAuthConfigError(
			provider,
			`${config.displayName} OAuth requires installed-app client configuration. ` +
				`Set ${config.clientIdEnv} and ${config.clientSecretEnv}, then run ` +
				`${config.setupAction}.`,
		);
	}

	return { clientId, clientSecret };
}
