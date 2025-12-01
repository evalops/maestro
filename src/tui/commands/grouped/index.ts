/**
 * Grouped command handlers.
 *
 * These handlers organize related commands under parent commands
 * with subcommands, reducing the total number of top-level commands.
 */

export {
	createSessionCommandHandler,
	type SessionCommandDeps,
} from "./session-commands.js";

export {
	createDiagCommandHandler,
	type DiagCommandDeps,
} from "./diag-commands.js";

export { createUiCommandHandler, type UiCommandDeps } from "./ui-commands.js";

export {
	createSafetyCommandHandler,
	type SafetyCommandDeps,
} from "./safety-commands.js";

export {
	createGitCommandHandler,
	type GitCommandDeps,
} from "./git-commands.js";

export {
	createAuthCommandHandler,
	type AuthCommandDeps,
} from "./auth-commands.js";

export {
	createUsageCommandHandler,
	type UsageCommandDeps,
} from "./usage-commands.js";

export {
	createUndoCommandHandler,
	type UndoCommandDeps,
} from "./undo-commands.js";

export {
	parseSubcommand,
	isHelpRequest,
	isNumericArg,
	isSessionId,
	matchesAlias,
	COMMON_ALIASES,
	type ParsedSubcommand,
} from "./utils.js";
