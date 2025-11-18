import type { AgentToolResult } from "../agent/types.js";
import { bashTool } from "./bash.js";

/**
 * Check if GitHub CLI is installed and authenticated.
 * Returns an error result if not available, otherwise returns null.
 */
export async function checkGhCliAvailable(
	signal?: AbortSignal,
): Promise<AgentToolResult<undefined> | null> {
	// Check if gh CLI is installed
	const checkResult = await bashTool.execute(
		"gh-check",
		{ command: "which gh" },
		signal,
	);

	const checkContent = checkResult.content[0];
	if (
		checkContent &&
		"text" in checkContent &&
		checkContent.text.includes("Command failed")
	) {
		return {
			content: [
				{
					type: "text",
					text: `GitHub CLI (gh) is not installed.

Install it with:
  macOS:   brew install gh
  Linux:   See https://github.com/cli/cli/blob/trunk/docs/install_linux.md
  Windows: See https://cli.github.com

After installing, authenticate with: gh auth login`,
				},
			],
			details: undefined,
		};
	}

	// Check if authenticated by running a simple gh command
	const authCheck = await bashTool.execute(
		"gh-auth-check",
		{ command: "gh auth status" },
		signal,
	);

	const authContent = authCheck.content[0];
	const authText = authContent && "text" in authContent ? authContent.text : "";
	if (
		authText.includes("not logged in") ||
		authText.includes("gh auth login") ||
		authText.includes("You are not logged into any")
	) {
		return {
			content: [
				{
					type: "text",
					text: `GitHub CLI is not authenticated.

Please run: gh auth login

This will open a browser to authenticate with GitHub.
You can also use a personal access token: gh auth login --with-token`,
				},
			],
			details: undefined,
		};
	}

	return null; // All checks passed
}

/**
 * Execute a gh CLI command with automatic error handling for common issues.
 */
export async function executeGhCommand(
	toolCallId: string,
	command: string,
	signal?: AbortSignal,
): Promise<AgentToolResult<undefined>> {
	const result = await bashTool.execute(toolCallId, { command }, signal);

	const resultContent = result.content[0];
	const text =
		resultContent && "text" in resultContent ? resultContent.text : "";

	// Check for common errors and provide helpful messages
	if (text.includes("not logged in") || text.includes("gh auth login")) {
		return {
			content: [
				{
					type: "text",
					text: `GitHub CLI is not authenticated.

Please run: gh auth login

Original error:
${text}`,
				},
			],
			details: undefined,
		};
	}

	if (text.includes("not found") && text.includes("repository")) {
		return {
			content: [
				{
					type: "text",
					text: `Not in a git repository with GitHub remote.

Make sure you're in a git repository that has a GitHub remote configured.
Check with: git remote -v

Original error:
${text}`,
				},
			],
			details: undefined,
		};
	}

	if (text.includes("GraphQL") && text.includes("Could not resolve to")) {
		return {
			content: [
				{
					type: "text",
					text: `GitHub resource not found.

This usually means:
- The PR/issue number doesn't exist
- You don't have access to this repository
- The repository/organization doesn't exist

Original error:
${text}`,
				},
			],
			details: undefined,
		};
	}

	return result;
}
