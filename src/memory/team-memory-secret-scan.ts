const ANTHROPIC_API_KEY_PREFIX = ["sk", "ant", "api"].join("-");

interface TeamMemorySecretRule {
	label: string;
	pattern: RegExp;
}

export interface TeamMemorySecretMatch {
	label: string;
	match: string;
}

// High-confidence token formats adapted from the upstream team-memory sync
// secret scanner. These supplement Maestro's generic outbound detector with
// repo-memory-specific patterns that are easy to identify and should never
// be stored in shared durable memory.
const TEAM_MEMORY_SECRET_RULES: TeamMemorySecretRule[] = [
	{
		label: "Anthropic Admin API Key",
		pattern: /\b(sk-ant-admin01-[a-zA-Z0-9_\-]{93}AA)(?:[\x60'"\s;]|\\[nr]|$)/g,
	},
	{
		label: "OpenAI API Key",
		pattern:
			/\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})(?:[\x60'"\s;]|\\[nr]|$)/g,
	},
	{
		label: "Anthropic API Key",
		pattern: new RegExp(
			String.raw`\b(${ANTHROPIC_API_KEY_PREFIX}03-[a-zA-Z0-9_\-]{93}AA)(?:[\x60'"\s;]|\\[nr]|$)`,
			"g",
		),
	},
	{
		label: "GitHub Fine-Grained PAT",
		pattern: /github_pat_\w{82}/g,
	},
	{
		label: "GitLab PAT",
		pattern: /glpat-[\w-]{20}/g,
	},
	{
		label: "npm Access Token",
		pattern: /\b(npm_[a-zA-Z0-9]{36})(?:[\x60'"\s;]|\\[nr]|$)/g,
	},
	{
		label: "Hugging Face Access Token",
		pattern: /\b(hf_[a-zA-Z]{34})(?:[\x60'"\s;]|\\[nr]|$)/g,
	},
	{
		label: "DigitalOcean PAT",
		pattern: /\b(dop_v1_[a-f0-9]{64})(?:[\x60'"\s;]|\\[nr]|$)/g,
	},
];

export function scanTeamMemorySecrets(
	content: string,
): TeamMemorySecretMatch[] {
	const matches: TeamMemorySecretMatch[] = [];

	for (const rule of TEAM_MEMORY_SECRET_RULES) {
		for (const matched of content.matchAll(rule.pattern)) {
			const value = matched[1] ?? matched[0];
			if (!value) {
				continue;
			}
			matches.push({
				label: rule.label,
				match: value,
			});
		}
	}

	return matches;
}
