export type RuntimeNetworkAccess =
	| "available"
	| "restricted"
	| "disabled"
	| "unknown";

export interface RuntimeConstraintContext {
	/**
	 * Runtime sandbox mode selected by the caller, for example `workspace-write`
	 * or `read-only`.
	 */
	sandboxMode?: string | null;
	sandboxEnabled?: boolean;
	isShallowGitCheckout?: boolean;
	readOnly?: boolean;
	networkAccess?: RuntimeNetworkAccess;
	hostedRunner?: boolean;
	firewallRestricted?: boolean;
	runnerImage?: string | null;
}

export interface RuntimeConstraintFragment {
	contextKey: string;
	prompt: string;
}

export interface RuntimeConstraintDefinition extends RuntimeConstraintFragment {
	condition: (context: RuntimeConstraintContext) => boolean;
}

export function isSandboxModeEnabled(mode?: string | null): boolean {
	const normalized = mode?.trim().toLowerCase();
	return Boolean(
		normalized &&
			normalized !== "none" &&
			normalized !== "local" &&
			normalized !== "danger-full-access",
	);
}

function isSandboxEnabled(context: RuntimeConstraintContext): boolean {
	if (context.sandboxEnabled !== undefined) {
		return context.sandboxEnabled;
	}
	return isSandboxModeEnabled(context.sandboxMode);
}

function isReadOnly(context: RuntimeConstraintContext): boolean {
	return (
		context.readOnly === true ||
		context.sandboxMode?.trim().toLowerCase() === "read-only"
	);
}

export const RUNTIME_CONSTRAINT_FRAGMENTS: RuntimeConstraintDefinition[] = [
	{
		contextKey: "sandbox.filesystem",
		condition: (context) => isSandboxEnabled(context),
		prompt:
			"Filesystem sandboxing is active. Keep file reads, writes, and command execution inside the approved workspace and use explicit user approval before attempting paths outside the sandbox.",
	},
	{
		contextKey: "sandbox.shallow-git",
		condition: (context) =>
			isSandboxEnabled(context) && context.isShallowGitCheckout === true,
		prompt:
			"Git history note: this sandbox checkout is shallow. Run `git fetch --unshallow` before relying on history-sensitive commands such as `git log`, `git blame`, or commit archaeology.",
	},
	{
		contextKey: "hosted-runner.ephemeral",
		condition: (context) => context.hostedRunner === true,
		prompt:
			"Hosted runner note: this environment may be ephemeral. Persist user-visible outputs intentionally, treat secrets as environment-only, and do not print secret values in logs or summaries.",
	},
	{
		contextKey: "network.offline",
		condition: (context) => context.networkAccess === "disabled",
		prompt:
			"Offline evaluation mode is active. Web search, external fetches, MCP calls, and Platform network requests are expected to fail; skip web search and rely on local repository context unless the user provides network data.",
	},
	{
		contextKey: "network.restricted",
		condition: (context) =>
			context.networkAccess !== "disabled" &&
			(context.networkAccess === "restricted" ||
				context.firewallRestricted === true),
		prompt:
			"Network egress is restricted. Avoid repeated failed network probes; prefer local evidence, configured internal routes, or explicit user approval before depending on external services.",
	},
	{
		contextKey: "checkout.read-only",
		condition: (context) => isReadOnly(context),
		prompt:
			"Read-only checkout mode is active. Do not attempt file edits or mutating commands; inspect, plan, and report the exact changes needed instead.",
	},
];

export function getRuntimeConstraintFragments(
	context?: RuntimeConstraintContext | null,
): RuntimeConstraintFragment[] {
	if (!context) {
		return [];
	}
	return RUNTIME_CONSTRAINT_FRAGMENTS.filter((fragment) =>
		fragment.condition(context),
	).map(({ contextKey, prompt }) => ({ contextKey, prompt }));
}

export function formatRuntimeConstraintFragments(
	fragments: RuntimeConstraintFragment[],
): string {
	if (fragments.length === 0) {
		return "";
	}
	return [
		"# Runtime Constraints",
		"",
		...fragments.map(
			(fragment) => `## ${fragment.contextKey}\n\n${fragment.prompt}`,
		),
	].join("\n\n");
}

export function buildRuntimeConstraintPrompt(
	context?: RuntimeConstraintContext | null,
): string {
	return formatRuntimeConstraintFragments(
		getRuntimeConstraintFragments(context),
	);
}
