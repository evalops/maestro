import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type RuntimeConstraintContext,
	type RuntimeNetworkAccess,
	buildRuntimeConstraintPrompt,
	isSandboxModeEnabled,
} from "@evalops/contracts";
import chalk from "chalk";
import { buildSearchGuidelines } from "../agent/search-guidance.js";
import {
	type ComposerConfig,
	type PromptProjectDocManifest,
	type PromptProjectDocManifestEntry,
	loadPromptProjectDocManifest,
	resolveLoadedAppendSystemPromptPath,
} from "../config/index.js";
import { DEFAULT_GUARDED_FILE_RULES } from "../safety/guarded-files.js";

// Tool descriptions for dynamic system prompt generation
const TOOL_DESCRIPTIONS: Record<string, string> = {
	read: "Read file contents",
	list: "List files and directories safely using glob patterns",
	find: "Fast file search using fd with glob patterns. Respects .gitignore. Use for discovering files across large codebases.",
	search: "Search files with ripgrep (pattern, glob, context options)",
	parallel_ripgrep:
		"Run multiple ripgrep searches in parallel, merge overlapping matches into line ranges, and return their content.",
	diff: "Inspect git diffs (workspace, staged, or revision ranges)",
	bash: "Execute bash commands (ls, grep, find, etc.)",
	background_tasks:
		"Launch and manage long-running commands asynchronously. `start` requires `command` (optional `cwd`, `env`, `shell`, per-task `limits`, and `restart={maxAttempts, delayMs, strategy?, maxDelayMs?, jitterRatio?}`), `stop`/`logs` require `taskId`, and `logs` accepts `lines` (default 40).",
	edit: "Make surgical edits to files (find exact text and replace)",
	write: "Create or overwrite files",
	todo: 'Produce TodoWrite-style checklists. Provide payload { goal: "...", items: [{ content: "...", status: "pending", priority: "medium" }] } (items may also be a JSON string) and optionally supply updates [{ id: "...", status: "completed" }] to check off existing tasks.',
	websearch:
		'Search the web using Exa AI for real-time information beyond training cutoff. Returns LLM-optimized context by default. Use for: current events (after training cutoff), recent news, company information, research papers. Supports domain filtering (includeDomains: ["arxiv.org"]) and categories (category: "research paper").',
	codesearch:
		'Search billions of GitHub repos, docs, and Stack Overflow for code examples. ALWAYS use this FIRST for any programming question before searching local files. Returns working code snippets with source URLs. Examples: "how to use Exa search in python", "React hooks patterns", "Express middleware authentication".',
	webfetch:
		"Fetch and extract content from specific URLs. More efficient than websearch when URL is known. Use for reading documentation pages, articles, or when you have specific URLs to analyze.",
	status: "Get git repository status and information",
	gh_pr: "Manage GitHub Pull Requests using gh CLI",
	gh_issue: "Manage GitHub Issues using gh CLI",
	gh_repo: "Manage GitHub Repositories using gh CLI",
	pipeline_search_contacts:
		"Search Pipeline CRM contacts through the internal evalops Pipeline service. Requires PIPELINE_API_URL and PIPELINE_SERVICE_TOKEN.",
	pipeline_search_deals:
		"Search Pipeline CRM deals through the internal evalops Pipeline service. Requires PIPELINE_API_URL and PIPELINE_SERVICE_TOKEN.",
	pipeline_create_signal:
		"Create a signal in Pipeline CRM through the internal evalops Pipeline service. Requires PIPELINE_API_URL and PIPELINE_SERVICE_TOKEN.",
	pipeline_log_activity:
		"Log a customer, deal, or company activity in Pipeline CRM through the internal evalops Pipeline service. Requires PIPELINE_API_URL and PIPELINE_SERVICE_TOKEN.",
};

function buildToolsSection(toolNames: string[]): string {
	const lines = ["Available tools:"];
	for (const name of toolNames) {
		const desc = TOOL_DESCRIPTIONS[name];
		if (desc) {
			lines.push(`- ${name}: ${desc}`);
		}
	}
	return lines.join("\n");
}

export function resolveSystemPromptOverride(value?: string): string | null {
	if (!value) return null;
	if (existsSync(value)) {
		try {
			return readFileSync(value, "utf-8");
		} catch (error) {
			console.error(
				chalk.yellow(
					`Warning: Could not read system prompt file ${value}: ${error}`,
				),
			);
			return null;
		}
	}
	return value;
}

function resolvePromptInputPath(value?: string): string | null {
	if (!value || !existsSync(value)) {
		return null;
	}
	return resolve(value);
}

export function resolveExplicitSystemPromptSourcePaths(
	customPrompt?: string,
	appendPrompt?: string,
): string[] {
	return [
		...new Set(
			[customPrompt, appendPrompt]
				.map((value) => resolvePromptInputPath(value))
				.filter((value): value is string => typeof value === "string"),
		),
	];
}

function loadAppendSystemPrompt(
	cwd: string,
	profileName?: string,
	cliOverrides?: Partial<ComposerConfig>,
): string | null {
	const appendSystemPath = resolveLoadedAppendSystemPromptPath(
		cwd,
		profileName,
		cliOverrides,
	);
	return appendSystemPath
		? resolveSystemPromptOverride(appendSystemPath)
		: null;
}

interface RuntimeConstraintDetectionOptions {
	cwd?: string;
	sandboxMode?: string | null;
	sandboxEnabled?: boolean;
	readOnly?: boolean;
	env?: Record<string, string | undefined>;
}

export interface FinalizeSystemPromptOptions {
	runtimeConstraints?: RuntimeConstraintContext | null;
	promptContextManifest?: PromptProjectDocManifest;
	profileName?: string;
	cliOverrides?: Partial<ComposerConfig>;
}

function readEnvFlag(
	env: Record<string, string | undefined>,
	name: string,
): boolean {
	const value = env[name]?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

function normalizeNetworkAccess(
	value?: string,
): RuntimeNetworkAccess | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) {
		return undefined;
	}
	if (
		normalized === "disabled" ||
		normalized === "offline" ||
		normalized === "none" ||
		normalized === "no-network"
	) {
		return "disabled";
	}
	if (
		normalized === "restricted" ||
		normalized === "firewall" ||
		normalized === "gated"
	) {
		return "restricted";
	}
	if (normalized === "available" || normalized === "enabled") {
		return "available";
	}
	return "unknown";
}

function resolveGitDirectoryAtPath(path: string): string | null {
	const gitPath = join(path, ".git");
	try {
		const gitStat = statSync(gitPath);
		if (gitStat.isDirectory()) {
			return gitPath;
		}
		if (!gitStat.isFile()) {
			return null;
		}
		const gitFile = readFileSync(gitPath, "utf8");
		const match = /^gitdir:\s*(.+?)\s*$/m.exec(gitFile);
		const gitDir = match?.[1];
		if (!gitDir) {
			return null;
		}
		return resolve(path, gitDir);
	} catch {
		return null;
	}
}

function resolveGitDirectory(cwd: string): string | null {
	let current = resolve(cwd);
	while (true) {
		const gitDir = resolveGitDirectoryAtPath(current);
		if (gitDir) {
			return gitDir;
		}
		const parent = dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}

function resolveGitCommonDirectory(gitDir: string): string {
	try {
		const commonDir = readFileSync(join(gitDir, "commondir"), "utf8").trim();
		if (commonDir) {
			return resolve(gitDir, commonDir);
		}
	} catch {
		// Older/non-worktree repositories do not have a commondir file.
	}
	return gitDir;
}

function isShallowGitCheckout(cwd: string): boolean {
	const gitDir = resolveGitDirectory(cwd);
	if (!gitDir) {
		return false;
	}
	const commonGitDir = resolveGitCommonDirectory(gitDir);
	return (
		existsSync(join(commonGitDir, "shallow")) ||
		existsSync(join(gitDir, "shallow"))
	);
}

export function detectRuntimeConstraintContext(
	options: RuntimeConstraintDetectionOptions = {},
): RuntimeConstraintContext {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const sandboxMode =
		options.sandboxMode ??
		env.MAESTRO_SANDBOX_MODE ??
		env.CODEX_SANDBOX_MODE ??
		env.MAESTRO_SANDBOX ??
		null;
	const networkAccess =
		readEnvFlag(env, "MAESTRO_OFFLINE_EVAL") ||
		readEnvFlag(env, "CODEX_OFFLINE_EVAL")
			? "disabled"
			: normalizeNetworkAccess(
					env.MAESTRO_NETWORK_ACCESS ?? env.CODEX_NETWORK_ACCESS,
				);

	return {
		sandboxMode,
		sandboxEnabled: options.sandboxEnabled ?? isSandboxModeEnabled(sandboxMode),
		isShallowGitCheckout: isShallowGitCheckout(cwd),
		readOnly:
			options.readOnly ??
			(readEnvFlag(env, "MAESTRO_READ_ONLY") ||
				readEnvFlag(env, "CODEX_READ_ONLY")),
		networkAccess,
		hostedRunner:
			readEnvFlag(env, "MAESTRO_HOSTED_RUNNER") ||
			env.MAESTRO_RUNNER_KIND?.trim().toLowerCase() === "hosted",
		firewallRestricted:
			readEnvFlag(env, "MAESTRO_FIREWALL_RESTRICTED") ||
			readEnvFlag(env, "CODEX_FIREWALL_RESTRICTED"),
		runnerImage: env.MAESTRO_RUNNER_IMAGE ?? null,
	};
}

function buildGuidelines(toolNames: Set<string>, currentYear: number): string {
	const guidelines: string[] = [];

	guidelines.push(
		"You can emit multiple tool calls in a single turn; the runtime will execute independent calls in parallel. No batch tool is needed—just include separate tool calls when parallelism helps.",
	);
	guidelines.push(
		"Emit independent safe tool calls together when their inputs are known, including read-only inspections, trusted MCP reads, and disjoint file mutations with explicit paths.",
	);
	guidelines.push(
		"Avoid one-tool-per-turn inspection chains: when the next few read/list/search calls are already known and independent, emit them together.",
	);
	guidelines.push(...buildSearchGuidelines(toolNames, currentYear));

	if (toolNames.has("bash")) {
		guidelines.push(
			"Always use bash tool for file operations like ls, grep, find",
		);
		guidelines.push(
			"Destructive commands (e.g., `rm -rf`, `mkfs`, `dd if=/dev/zero`, `chmod 000`) always require manual approval—even through `background_tasks`—so only run them when absolutely necessary",
		);
	}

	if (toolNames.has("background_tasks")) {
		guidelines.push(
			"Running `background_tasks` with `shell: true` requires approval because it enables pipes/redirects/globbing; prefer direct exec unless shell mode is unavoidable",
		);
	}

	if (toolNames.has("read")) {
		guidelines.push("Use read to examine files before editing");
	}

	if (toolNames.has("edit")) {
		guidelines.push(
			"Use edit for precise changes (old text must match exactly)",
		);
	}

	if (toolNames.has("write")) {
		guidelines.push("Use write only for new files or complete rewrites");
	}

	if (toolNames.has("list")) {
		guidelines.push(
			"Use list to inspect directory structures when you only need filenames",
		);
	}

	if (toolNames.has("find")) {
		guidelines.push(
			"Use find for fast file discovery with glob patterns across large codebases",
		);
	}

	if (toolNames.has("search")) {
		guidelines.push(
			"Use search to locate relevant files or symbols before editing",
		);
	}

	if (toolNames.has("diff")) {
		guidelines.push(
			"Use diff to review pending changes before summarizing or committing",
		);
	}

	if (toolNames.has("todo")) {
		guidelines.push(
			"Use todo when you need a structured task list; supply a goal plus an items array shaped like TodoWrite entries or updates for existing tasks",
		);
	}

	// Always include these
	guidelines.push("Be concise in your responses");
	guidelines.push("Show file paths clearly when working with files");
	guidelines.push(
		"When evaluating new features, use precise, technical language",
	);
	guidelines.push(
		'When the user specifies an explicit output token target such as "+500k", "use 2M tokens", or "spend 1B tokens", keep working until you approach that target productively instead of stopping early.',
	);
	guidelines.push(
		"Length limits: keep text between tool calls to <=25 words. Keep final responses to <=100 words unless the task requires more detail.",
	);
	guidelines.push("Avoid unnecessary emojis unless humor improves clarity");
	guidelines.push(
		"Do NOT create summary documents or CHANGELOG files unless explicitly requested by the user",
	);

	return `Guidelines:\n${guidelines.map((g) => `- ${g}`).join("\n")}`;
}

export interface ContextFile {
	path: string;
	content: string;
}

export function truncateUtf8(
	buffer: Buffer,
	maxBytes: number,
): {
	content: string;
	bytes: number;
} {
	let end = Math.min(maxBytes, buffer.length);
	if (end === 0) {
		return { content: "", bytes: 0 };
	}

	let start = end - 1;
	while (start >= 0) {
		const byte = buffer[start];
		if (byte === undefined) {
			return { content: "", bytes: 0 };
		}
		if ((byte & 0b1100_0000) !== 0b1000_0000) {
			break;
		}
		start -= 1;
	}

	if (start < 0) {
		return { content: "", bytes: 0 };
	}

	const lead = buffer[start];
	if (lead === undefined) {
		return { content: "", bytes: 0 };
	}
	let expected = 1;
	if ((lead & 0b1000_0000) === 0) {
		expected = 1;
	} else if ((lead & 0b1110_0000) === 0b1100_0000) {
		expected = 2;
	} else if ((lead & 0b1111_0000) === 0b1110_0000) {
		expected = 3;
	} else if ((lead & 0b1111_1000) === 0b1111_0000) {
		expected = 4;
	} else {
		end = start;
	}

	if (start + expected > end) {
		end = start;
	}

	const slice = buffer.slice(0, Math.max(0, end));
	return { content: slice.toString("utf-8"), bytes: slice.length };
}

export function loadProjectContextFiles(
	cwdOverride?: string,
	options: { config?: ComposerConfig } = {},
): ContextFile[] {
	return loadPromptProjectDocManifest(cwdOverride, options.config).entries.map(
		(entry) => ({
			path: entry.path,
			content: entry.content,
		}),
	);
}

function formatProjectContextFile(
	file: ContextFile | PromptProjectDocManifestEntry,
): string {
	const filename = basename(file.path);
	const dir = dirname(file.path);
	const content = escapeXml(file.content.trimEnd());
	return [
		`# ${filename} instructions for ${dir}`,
		"",
		"<INSTRUCTIONS>",
		content,
		"</INSTRUCTIONS>",
		"",
		"",
	].join("\n");
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// Default tool names when no filter is applied
const DEFAULT_TOOL_NAMES = [
	"read",
	"list",
	"find",
	"search",
	"diff",
	"bash",
	"background_tasks",
	"edit",
	"write",
	"todo",
	"websearch",
	"codesearch",
	"webfetch",
	"status",
	"gh_pr",
	"gh_issue",
	"gh_repo",
	"pipeline_search_contacts",
	"pipeline_search_deals",
	"pipeline_create_signal",
	"pipeline_log_activity",
];

function formatCurrentDateTime(): string {
	return new Date().toLocaleString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		timeZoneName: "short",
	});
}

const GUARDED_WORKSPACE_SCAN_IGNORES = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".turbo",
	".nx",
	".cache",
	"tmp",
]);

const DEFAULT_GUARDED_CATEGORY_BY_KEY = new Map(
	DEFAULT_GUARDED_FILE_RULES.map((rule) => [rule.key, rule.category]),
);

const GUARDED_WORKSPACE_ENTRY_KEYS = new Map<string, string>([
	[".cursor", "cursor-config"],
	[".windsurf", "windsurf-config"],
	[".idea", "jetbrains-project-config"],
	[".amp", "amp-settings"],
	["amp.json", "amp-settings"],
	[".ssh", "ssh-gpg-keys"],
	[".gnupg", "ssh-gpg-keys"],
]);

interface GuardedAbsolutePathRule {
	key: string;
	path: string;
	match: "exact" | "prefix";
}

function normalizeGuardScanPath(path: string): string {
	return resolve(path).replace(/\\/g, "/");
}

function addGuardedCategory(categories: Set<string>, key: string): void {
	const category = DEFAULT_GUARDED_CATEGORY_BY_KEY.get(key);
	if (category) {
		categories.add(category);
	}
}

function buildGuardedAbsolutePathRules(
	env: Record<string, string | undefined> = process.env,
): GuardedAbsolutePathRule[] {
	const home = normalizeGuardScanPath(homedir());
	const prefix = (key: string, path: string): GuardedAbsolutePathRule => ({
		key,
		path: normalizeGuardScanPath(path),
		match: "prefix",
	});
	const exact = (key: string, path: string): GuardedAbsolutePathRule => ({
		key,
		path: normalizeGuardScanPath(path),
		match: "exact",
	});
	const envPrefix = (
		key: string,
		name: string,
		child: string,
	): GuardedAbsolutePathRule[] => {
		const base = (env[name] ?? env[name.toUpperCase()])?.trim();
		return base ? [prefix(key, join(base, child))] : [];
	};

	return [
		prefix("cursor-config", join(home, ".cursor")),
		prefix("cursor-config", join(home, "Library/Application Support/Cursor")),
		prefix("cursor-config", join(home, ".config/Cursor")),
		...envPrefix("cursor-config", "APPDATA", "Cursor"),
		prefix("windsurf-config", join(home, ".codeium/windsurf")),
		prefix(
			"windsurf-config",
			join(home, "Library/Application Support/Windsurf"),
		),
		prefix("windsurf-config", join(home, ".config/Windsurf")),
		prefix("windsurf-config", "/Library/Application Support/Windsurf"),
		prefix("windsurf-config", "/etc/windsurf"),
		...envPrefix("windsurf-config", "APPDATA", "Windsurf"),
		...envPrefix("windsurf-config", "LOCALAPPDATA", "Windsurf"),
		...envPrefix("windsurf-config", "ProgramData", "Windsurf"),
		prefix("antigravity-config", join(home, ".gemini")),
		prefix(
			"jetbrains-app-config",
			join(home, "Library/Application Support/JetBrains"),
		),
		prefix("jetbrains-app-config", join(home, ".config/JetBrains")),
		prefix("jetbrains-app-config", join(home, ".local/share/JetBrains")),
		...envPrefix("jetbrains-app-config", "APPDATA", "JetBrains"),
		...envPrefix("jetbrains-app-config", "LOCALAPPDATA", "JetBrains"),
		prefix("neovim-config", join(home, ".config/nvim")),
		prefix("neovim-config", join(home, ".local/share/nvim")),
		prefix("neovim-config", join(home, ".local/state/nvim")),
		exact("shell-config", join(home, ".bashrc")),
		exact("shell-config", join(home, ".zshrc")),
		exact("shell-config", join(home, ".cshrc")),
		exact("shell-config", join(home, ".tcshrc")),
		exact("shell-config", join(home, ".config/fish/config.fish")),
		prefix("shell-config", join(home, ".config/fish/conf.d")),
		prefix("ssh-gpg-keys", join(home, ".ssh")),
		prefix("ssh-gpg-keys", join(home, ".gnupg")),
	];
}

function matchesGuardedAbsolutePath(
	path: string,
	rule: GuardedAbsolutePathRule,
): boolean {
	if (rule.match === "exact") {
		return path === rule.path;
	}
	return path === rule.path || path.startsWith(`${rule.path}/`);
}

function collectGuardedWorkspaceCategories(
	cwd: string,
	options: { maxEntries?: number } = {},
): string[] {
	const maxEntries = options.maxEntries ?? 5000;
	const categories = new Set<string>();
	const absoluteRules = buildGuardedAbsolutePathRules();
	const stack = [cwd];
	let entriesVisited = 0;

	while (stack.length > 0 && entriesVisited < maxEntries) {
		const dir = stack.pop();
		if (!dir) break;

		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (entriesVisited >= maxEntries) break;
			entriesVisited += 1;
			const path = join(dir, entry.name);
			const normalizedPath = normalizeGuardScanPath(path);
			const entryKey = GUARDED_WORKSPACE_ENTRY_KEYS.get(entry.name);
			if (entryKey) {
				addGuardedCategory(categories, entryKey);
			}
			for (const rule of absoluteRules) {
				if (matchesGuardedAbsolutePath(normalizedPath, rule)) {
					addGuardedCategory(categories, rule.key);
					break;
				}
			}

			if (
				entry.isDirectory() &&
				!GUARDED_WORKSPACE_SCAN_IGNORES.has(entry.name)
			) {
				stack.push(path);
			}
		}
	}

	return DEFAULT_GUARDED_FILE_RULES.map((rule) => rule.category).filter(
		(category) => categories.has(category),
	);
}

function buildGuardedWorkspacePromptFragment(cwd: string): string | null {
	const categories = collectGuardedWorkspaceCategories(cwd);
	if (categories.length === 0) {
		return null;
	}

	const categoryText = categories.join(", ");
	return [
		"# Guarded Workspace Paths",
		"",
		`This workspace contains paths covered by Maestro's default guarded-files policy: ${categoryText}.`,
		"Ask for explicit user approval before attempting to read, list, search, execute against, or modify these guarded paths.",
	].join("\n");
}

export function buildFileCitationPromptFragment(cwd = process.cwd()): string {
	const examplePath = join(cwd, "src/auth/middleware.ts");
	const exampleUri = `${pathToFileURL(examplePath).href}#L42`;

	return [
		"# File Citations",
		"",
		"When mentioning a workspace file in any user-facing response, link it using Markdown with a `file:///` URI so every surface can make the reference clickable.",
		"Prefer the displayed text users expect to read, such as `src/auth/middleware.ts`, and percent-encode spaces and other URI characters in the link target.",
		"Include known line references as URL fragments, such as `#L42`, `#L42-L48`, or `#L42C8`.",
		"At GitHub comment boundaries, use repository blob URLs instead of local `file:///` URIs when repository metadata is available.",
		`Good: See [src/auth/middleware.ts](${exampleUri}) for the validation logic.`,
		"Bad: See src/auth/middleware.ts for the validation logic.",
	].join("\n");
}

/**
 * Behavioral discipline baked into the bundled (offline) prompt so a Maestro
 * run without a remote prompt service still holds the standards a strong
 * coding agent applies: follow existing conventions, keep changes scoped,
 * surface problems, and verify before claiming done. Sections that depend on
 * specific tools are included only when those tools are available.
 */
function buildEngineeringDisciplineSection(toolNames: Set<string>): string {
	const sections: string[] = [];

	sections.push(
		[
			"## Following conventions",
			"- Before using a library, confirm it is already a dependency of this project — check imports in neighbouring files and the package manifest. Never assume a package is available because it is popular.",
			"- Match the conventions of the surrounding code: its naming, typing, error handling, and file layout. New code should be hard to distinguish from what is already there.",
			"- Add a comment only to explain intent the code cannot convey. Do not narrate what the code plainly does.",
		].join("\n"),
	);

	const doingTask: string[] = [
		"## Doing the task",
		"- Do what was asked, then stop. Prefer the smallest change that fully solves the problem, and do not refactor adjacent code the task did not require.",
		"- Surface problems as you find them. If an assumption turns out wrong, a requirement is missing, or a change is riskier than it looked, say so instead of quietly working around it.",
	];
	if (toolNames.has("todo")) {
		doingTask.push(
			"- Track multi-step work with the todo tool. Keep exactly one item in_progress, and mark an item completed as soon as its work is verified rather than batching updates at the end.",
		);
	}
	sections.push(doingTask.join("\n"));

	if (
		toolNames.has("edit") ||
		toolNames.has("write") ||
		toolNames.has("bash")
	) {
		sections.push(
			[
				"## Verifying your work",
				"- A change is not finished until it is verified. After a non-trivial change run the project's validators — build, lint, and the tests that cover what you touched — unless the user explicitly waives them, and report what you ran and what it showed.",
				"- Do not report that something works on the basis of reading the code when you could have run it.",
			].join("\n"),
		);
	}

	return `# Engineering discipline\n\n${sections.join("\n\n")}`;
}

export function buildBundledSystemPromptBase(toolNames?: string[]): string {
	const currentYear = new Date().getFullYear();
	const activeToolNames = toolNames ?? DEFAULT_TOOL_NAMES;
	const toolNameSet = new Set(activeToolNames);

	return `You are Maestro, an expert software engineering agent. You help users with real software work — reading files, executing commands, editing code, and writing new files — and you optimize for correct, verified changes over volume of output.

${buildEngineeringDisciplineSection(toolNameSet)}

${buildToolsSection(activeToolNames)}

${buildGuidelines(toolNameSet, currentYear)}`;
}

export function finalizeSystemPrompt(
	basePrompt: string,
	appendPrompt?: string,
	cwd = process.cwd(),
	options: FinalizeSystemPromptOptions = {},
): string {
	const appendSource =
		resolveSystemPromptOverride(appendPrompt) ??
		loadAppendSystemPrompt(cwd, options.profileName, options.cliOverrides);
	const appendText = appendSource?.trim();
	let prompt = basePrompt;
	const contextFiles =
		options.promptContextManifest?.entries ?? loadProjectContextFiles(cwd);
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "The following project context files have been loaded:\n\n";
		for (const file of contextFiles) {
			prompt += formatProjectContextFile(file);
		}
	}

	const guardedWorkspaceFragment = buildGuardedWorkspacePromptFragment(cwd);
	if (guardedWorkspaceFragment) {
		prompt += `\n\n${guardedWorkspaceFragment}\n`;
	}

	const runtimeConstraintPrompt = buildRuntimeConstraintPrompt(
		options.runtimeConstraints,
	);
	if (runtimeConstraintPrompt) {
		prompt += `\n\n${runtimeConstraintPrompt}\n`;
	}

	prompt += `\n\n${buildFileCitationPromptFragment(cwd)}\n`;

	if (appendText) {
		prompt += "\n\n# Additional System Instructions\n\n";
		prompt += `${appendText}\n\n`;
	}

	prompt += `\nCurrent date and time: ${formatCurrentDateTime()}`;
	prompt += `\nCurrent working directory: ${cwd}`;

	return prompt;
}

export function buildSystemPrompt(
	customPrompt?: string,
	toolNames?: string[],
	appendPrompt?: string,
	options?: FinalizeSystemPromptOptions,
): string {
	const promptSource =
		resolveSystemPromptOverride(customPrompt) ??
		buildBundledSystemPromptBase(toolNames);
	return finalizeSystemPrompt(
		promptSource,
		appendPrompt,
		process.cwd(),
		options,
	);
}
