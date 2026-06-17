import type { SandboxConfig } from "./sandbox.js";

export function parseSlackUserAllowList(value?: string): Set<string> {
	const users =
		value
			?.split(",")
			.map((item) => item.trim())
			.filter((item) => item.length > 0) ?? [];
	return new Set(users);
}

export function isSlackUserAllowed(
	userId: string,
	allowedUsers: ReadonlySet<string>,
): boolean {
	return allowedUsers.size === 0 || allowedUsers.has(userId);
}

export function formatSlackUserAccessDenied(): string {
	return "_Access denied: this Slack user is not in SLACK_AGENT_ALLOWED_USERS._";
}

export function getHostSandboxGateError(
	sandbox: SandboxConfig,
	allowHostSandbox: boolean,
): string | null {
	if (sandbox.type !== "host" || allowHostSandbox) {
		return null;
	}
	return [
		"Host sandbox mode is disabled for Slack agent by default because Slack is a multi-user surface.",
		"Use --sandbox=docker:auto or --sandbox=daytona, or set SLACK_AGENT_ALLOW_HOST_SANDBOX=true only for an explicitly trusted single-user install.",
	].join("\n");
}
