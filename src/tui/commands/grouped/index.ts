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
	createSubcommandCompletions,
	COMMON_ALIASES,
	SESSION_SUBCOMMANDS,
	DIAG_SUBCOMMANDS,
	UI_SUBCOMMANDS,
	SAFETY_SUBCOMMANDS,
	GIT_SUBCOMMANDS,
	AUTH_SUBCOMMANDS,
	USAGE_SUBCOMMANDS,
	UNDO_SUBCOMMANDS,
	type ParsedSubcommand,
	type SubcommandDef,
} from "./utils.js";
