/**
 * Session selection for interactive CLI.
 *
 * The TypeScript TUI session selector was removed with the TS TUI cutover.
 * Interactive resume is owned by the native `maestro-tui` binary (`-r` / `--resume`),
 * which `src/main.ts` launches for interactive mode.
 *
 * @module cli/session
 */
import type { SessionManager } from "../session/manager.js";

/**
 * @deprecated Interactive session selection lives in maestro-tui.
 * This stub remains so any residual dynamic import fails closed with a clear message.
 */
export async function selectSession(
	_sessionManager: SessionManager,
): Promise<string | null> {
	console.error(
		"Interactive session selection is handled by the native TUI. " +
			"Run `maestro -r` / `maestro --resume` (or `maestro-tui --resume`).",
	);
	return null;
}
