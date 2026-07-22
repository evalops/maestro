import type { AuthCredential } from "../providers/auth.js";
import { Agent, ProviderTransport } from "./index.js";
import type { Api, Model } from "./types.js";

/**
 * Lightweight in-process TypeScript Agent for external SDK embedding.
 * Product runtime paths use native background one-shots instead.
 */
export function createBackgroundTextAgent(params: {
	model: Model<Api>;
	systemPrompt: string;
	cwd: string;
	getAuthContext: (
		provider: string,
	) => AuthCredential | undefined | Promise<AuthCredential | undefined>;
}): Agent {
	return new Agent({
		transport: new ProviderTransport({
			getAuthContext: params.getAuthContext,
			cwd: params.cwd,
		}),
		initialState: {
			systemPrompt: params.systemPrompt,
			model: params.model,
			thinkingLevel: "off",
			reasoningSummary: null,
			tools: [],
			sandboxMode: null,
			sandboxEnabled: false,
		},
		contextSources: [],
	});
}
