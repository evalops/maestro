export type GuardedFileDefaultBehavior = "ask" | "block";

export interface GuardedFilePattern {
	key: string;
	description: string;
	patterns: string[];
	reason?: string;
	defaultBehavior: GuardedFileDefaultBehavior;
}

export interface GuardedFilesSettings {
	allowlist?: string[];
	rules?: GuardedFilePattern[];
	mandatoryKeys?: string[];
}

export interface GuardedFilesPolicySettings {
	user?: GuardedFilesSettings | null;
	organization?: GuardedFilesSettings | null;
}

export const DEFAULT_GUARDED_FILE_PATTERNS: GuardedFilePattern[] = [
	{
		key: "cursor-config",
		description: "Cursor configuration",
		patterns: [
			"**/.cursor/**",
			"~/.cursor/**",
			"~/Library/Application Support/Cursor/**",
			"~/.config/Cursor/**",
			"%APPDATA%/Cursor/**",
		],
		reason:
			"Editor configuration can contain local agent state and credentials.",
		defaultBehavior: "ask",
	},
	{
		key: "windsurf-config",
		description: "Windsurf configuration",
		patterns: [
			"**/.windsurf/**",
			"~/.codeium/windsurf/**",
			"~/Library/Application Support/Windsurf/**",
			"~/.config/Windsurf/**",
			"%APPDATA%/Windsurf/**",
			"/Library/Application Support/Windsurf/**",
			"/etc/windsurf/**",
			"%ProgramData%/Windsurf/**",
		],
		reason:
			"Editor configuration can contain local agent state and credentials.",
		defaultBehavior: "ask",
	},
	{
		key: "antigravity-config",
		description: "Antigravity configuration",
		patterns: ["~/.gemini/**"],
		reason: "Agent configuration can contain prompts, state, and credentials.",
		defaultBehavior: "ask",
	},
	{
		key: "jetbrains-app-config",
		description: "JetBrains application configuration",
		patterns: [
			"~/Library/Application Support/JetBrains/**",
			"~/.config/JetBrains/**",
			"~/.local/share/JetBrains/**",
			"%APPDATA%/JetBrains/**",
			"%LOCALAPPDATA%/JetBrains/**",
		],
		reason:
			"IDE application settings can contain credentials and local history.",
		defaultBehavior: "ask",
	},
	{
		key: "jetbrains-project-config",
		description: "JetBrains project configuration",
		patterns: ["**/.idea/**"],
		reason:
			"Project IDE state can contain machine-local paths and credentials.",
		defaultBehavior: "ask",
	},
	{
		key: "neovim-config",
		description: "Neovim configuration",
		patterns: [
			"~/.config/nvim/**",
			"~/.local/share/nvim/**",
			"~/.local/state/nvim/**",
		],
		reason:
			"Editor configuration can execute code or reveal local workflow state.",
		defaultBehavior: "ask",
	},
	{
		key: "amp-settings",
		description: "Amp settings",
		patterns: ["**/amp.json", "**/.amp/**"],
		reason: "Agent configuration can contain prompts, state, and credentials.",
		defaultBehavior: "ask",
	},
	{
		key: "shell-config",
		description: "Shell configuration",
		patterns: [
			"~/.bashrc",
			"~/.zshrc",
			"~/.config/fish/config.fish",
			"~/.config/fish/conf.d/**",
			"~/.cshrc",
			"~/.tcshrc",
		],
		reason:
			"Shell startup files can alter command execution and privilege boundaries.",
		defaultBehavior: "ask",
	},
	{
		key: "ssh-gpg-keys",
		description: "SSH and GPG keys",
		patterns: ["**/.ssh/**", "~/.ssh/**", "**/.gnupg/**", "~/.gnupg/**"],
		reason:
			"Private keys and signing material must not be read or modified implicitly.",
		defaultBehavior: "ask",
	},
];

function normalizeStringList(values: unknown): string[] {
	return Array.isArray(values)
		? [
				...new Set(
					values
						.filter((value): value is string => typeof value === "string")
						.map((value) => value.trim())
						.filter(Boolean),
				),
			]
		: [];
}

function normalizeGuardedFilePattern(rule: unknown): GuardedFilePattern | null {
	if (rule === null || typeof rule !== "object") {
		return null;
	}
	const record = rule as Record<string, unknown>;
	const key = typeof record.key === "string" ? record.key.trim() : "";
	const patterns = normalizeStringList(record.patterns);
	if (!key || patterns.length === 0) {
		return null;
	}
	const description =
		typeof record.description === "string" && record.description.trim()
			? record.description.trim()
			: key;
	const defaultBehavior =
		record.defaultBehavior === "block" || record.defaultBehavior === "ask"
			? record.defaultBehavior
			: "ask";
	const reason =
		typeof record.reason === "string" && record.reason.trim()
			? record.reason.trim()
			: undefined;
	return {
		key,
		description,
		patterns,
		...(reason ? { reason } : {}),
		defaultBehavior,
	};
}

export function normalizeGuardedFilesSettings(
	settings?: GuardedFilesSettings | null,
): Required<
	Pick<GuardedFilesSettings, "allowlist" | "rules" | "mandatoryKeys">
> {
	return {
		allowlist: normalizeStringList(settings?.allowlist),
		rules: Array.isArray(settings?.rules)
			? settings.rules.flatMap((rule) => {
					const normalizedRule = normalizeGuardedFilePattern(rule);
					return normalizedRule ? [normalizedRule] : [];
				})
			: [],
		mandatoryKeys: normalizeStringList(settings?.mandatoryKeys),
	};
}
