/**
 * Resolve the Maestro system prompt for native headless `init.system_prompt`.
 *
 * Mirrors the prompt resolution used by web-server `createAgent` so native
 * web chat / headless backends get the same bundled/service/project prompt
 * instead of only thinking/approval init fields.
 */

import { detectRuntimeConstraintContext } from "../cli/system-prompt.js";
import type { ComposerConfig } from "../config/index.js";
import { resolveMaestroSystemPrompt } from "../prompts/system-prompt.js";
import type { ResolvedSystemPrompt } from "../prompts/types.js";

export type NativeSystemPromptResolution = {
	systemPrompt: string;
	promptMetadata?: ResolvedSystemPrompt["promptMetadata"];
	promptContextManifest?: ResolvedSystemPrompt["promptContextManifest"];
	systemPromptSourcePaths?: ResolvedSystemPrompt["systemPromptSourcePaths"];
};

export type ResolveNativeSystemPromptOptions = {
	/** Explicit override; when set (including empty string), resolution is skipped. */
	systemPrompt?: string;
	cwd?: string;
	profileName?: string;
	cliOverrides?: Partial<ComposerConfig>;
	env?: NodeJS.ProcessEnv;
};

/**
 * Returns an explicit systemPrompt when provided; otherwise resolves the
 * full Maestro system prompt for the given cwd/profile (same as createAgent).
 */
export async function resolveNativeSystemPrompt(
	options: ResolveNativeSystemPromptOptions = {},
): Promise<NativeSystemPromptResolution> {
	if (options.systemPrompt !== undefined) {
		return { systemPrompt: options.systemPrompt };
	}

	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const runtimeConstraints = detectRuntimeConstraintContext({
		cwd,
		env,
		sandboxMode: env.MAESTRO_SANDBOX_MODE ?? null,
	});

	return resolveMaestroSystemPrompt({
		cwd,
		profileName: options.profileName,
		cliOverrides: options.cliOverrides,
		runtimeConstraints,
	});
}
