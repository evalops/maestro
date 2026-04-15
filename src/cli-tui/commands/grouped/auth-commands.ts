/**
 * Consolidated /auth command handler.
 *
 * Combines: /login, /logout
 *
 * Usage:
 *   /auth                 - Show auth status
 *   /auth login [mode]    - Authenticate (pro|console|provider:mode)
 *   /auth logout [provider] - Remove credentials
 *   /auth status          - Show current auth state
 */

import type { CommandExecutionContext } from "../types.js";
import { createGroupedCommandHandler } from "./utils.js";

export interface AuthCommandDeps {
	handleLogin: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleLogout: (ctx: CommandExecutionContext) => Promise<void> | void;
	showInfo: (message: string) => void;
	getAuthState: () => {
		authenticated: boolean;
		provider?: string;
		mode?: string;
	};
}

export function createAuthCommandHandler(deps: AuthCommandDeps) {
	return createGroupedCommandHandler({
		defaultSubcommand: "status",
		showHelp: showAuthHelp,
		routes: [
			{
				match: ["status", "info", "whoami"],
				execute: () => showAuthStatus(deps),
			},
			{
				match: ["login", "signin"],
				execute: ({ rewriteContext }) =>
					deps.handleLogin(rewriteContext("login")),
			},
			{
				match: ["logout", "signout"],
				execute: ({ rewriteContext }) =>
					deps.handleLogout(rewriteContext("logout")),
			},
		],
		onUnknown: async ({ ctx, subcommand, customContext }) => {
			if (
				["pro", "console", "max"].includes(subcommand) ||
				subcommand.includes(":")
			) {
				await deps.handleLogin(
					customContext(`/login ${ctx.argumentText}`, ctx.argumentText),
				);
				return;
			}
			ctx.showError(`Unknown subcommand: ${subcommand}`);
			showAuthHelp(ctx);
		},
	});
}

function showAuthStatus(deps: AuthCommandDeps): void {
	const state = deps.getAuthState();
	if (state.authenticated) {
		deps.showInfo(`Authentication Status:
  Authenticated: yes
  Provider: ${state.provider || "unknown"}
  Mode: ${state.mode || "unknown"}

Use /auth logout to sign out.`);
	} else {
		deps.showInfo(`Authentication Status:
  Authenticated: no

Use /auth login to authenticate with Claude Pro/Max.`);
	}
}

function showAuthHelp(ctx: CommandExecutionContext): void {
	ctx.showInfo(`Auth Commands:
  /auth                  Show auth status
  /auth login [mode]     Authenticate:
                         - pro: Claude Pro
                         - console: Anthropic Console
                         - provider:mode (e.g., anthropic:pro)
  /auth logout [provider] Remove credentials
  /auth status           Show current auth state

Direct shortcuts still work: /login, /logout`);
}
