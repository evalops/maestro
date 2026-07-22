/**
 * Authentication Setup - CLI flag validation still used by the Node shim.
 *
 * Credential resolution helpers (createAuthSetup) were removed after the
 * TypeScript Agent bootstrap was amputated; native maestro-tui owns auth.
 *
 * @module bootstrap/auth-setup
 */

/**
 * Validate that no unsupported legacy Codex/ChatGPT flags are used.
 * Throws with an error message on invalid flags.
 */
export function validateCodexFlags(args: string[], command?: string): void {
	if (command !== "help" && command !== "config") {
		const codexFlagsUsed = args.some((arg, index) => {
			if (arg === "--codex-api-key" || arg.startsWith("--codex-api-key=")) {
				return true;
			}
			if (arg === "--auth" && args[index + 1] === "chatgpt") return true;
			if (arg.startsWith("--auth=chatgpt")) return true;
			return false;
		});
		if (codexFlagsUsed) {
			throw new Error(
				"Legacy Codex/ChatGPT auth flags are no longer supported. Use the openai-codex provider with `maestro codex login` instead.",
			);
		}
		const retiredAnthropicAuthUsed = args.some((arg, index) => {
			if (arg === "--auth" && args[index + 1] === "claude") return true;
			if (arg.startsWith("--auth=claude")) return true;
			return false;
		});
		if (retiredAnthropicAuthUsed) {
			throw new Error(
				"Anthropic OAuth auth mode is no longer supported. Set ANTHROPIC_API_KEY to use Anthropic models, or run `maestro codex login` for the default Codex flow.",
			);
		}
	}
}
