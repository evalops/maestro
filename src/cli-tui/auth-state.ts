import { hasOpenAICodexAppServerAccount } from "../codex/auth.js";
import { listOAuthProviders, loadOAuthCredentials } from "../oauth/storage.js";

export interface TuiAuthState {
	authenticated: boolean;
	provider?: string;
	mode?: string;
}

export async function getTuiAuthState(
	currentProvider?: string,
): Promise<TuiAuthState> {
	const providers = listOAuthProviders();
	let hasCodexAppServerAccount: boolean | undefined;
	const maybeHasCodexAppServerAccount = async (): Promise<boolean> => {
		hasCodexAppServerAccount ??= await hasOpenAICodexAppServerAccount();
		return hasCodexAppServerAccount;
	};

	if (providers.length === 0) {
		if (await maybeHasCodexAppServerAccount()) {
			return {
				authenticated: true,
				provider: "openai-codex",
				mode: "app-server",
			};
		}

		return { authenticated: false };
	}

	let activeProvider = providers[0];

	if (currentProvider === "openai-codex") {
		if (
			providers.includes("openai-codex") ||
			(await maybeHasCodexAppServerAccount())
		) {
			activeProvider = "openai-codex";
		}
	} else if (currentProvider && providers.includes(currentProvider)) {
		activeProvider = currentProvider;
	}

	if (!activeProvider) {
		return { authenticated: false, provider: undefined, mode: undefined };
	}

	const credentials = loadOAuthCredentials(activeProvider);
	const storedMode = credentials?.metadata?.mode as string | undefined;
	const mode =
		storedMode ??
		(activeProvider === "openai-codex" &&
		(await maybeHasCodexAppServerAccount())
			? "app-server"
			: undefined);

	return {
		authenticated: true,
		provider: activeProvider,
		mode,
	};
}
