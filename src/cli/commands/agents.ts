import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { truncateUtf8 } from "../system-prompt.js";

const TEMPLATE = `# Repository Guidelines

Use this as the contributor quickstart for **{{PROJECT_NAME}}**. Keep it concise, specific, and updated as the project evolves.

## Project Structure & Module Organization
- Summarize top-level folders (e.g., \`src/\` for core code, \`tests/\` or \`__tests__/\` for suites, \`docs/\` for references, \`scripts/\` for tooling, \`packages/\` for monorepo packages, \`apps/\` for deployables, \`assets/\` for static files).
- Note where configs live (\`package.json\`, \`tsconfig.json\`, bundler/tooling configs) and where CI definitions reside (typically \`.github/workflows/\`).
- Call out any generated code or directories that should not be hand-edited.

## Build, Test, and Development Commands
- Install dependencies: \`npm install\` (or \`pnpm install\`, \`yarn install\`, \`bun install\` as applicable).
- Start development: \`npm run dev\` (mention default port or entrypoint).
- Build: \`npm run build\` (or \`make build\` for binaries/containers).
- Quality gates: \`npm run lint\`, \`npm run format\`.
- Tests: \`npm test\`, \`npm run test:unit\`, or \`npm run test:e2e\`. Include any required setup (e.g., \`docker compose up\` for services).

## Coding Style & Naming Conventions
- Enforce formatter (Prettier/Biome) and linter (ESLint or project default); prefer 2-space indent and consistent semicolons per config.
- Naming: camelCase for variables/functions, PascalCase for components/classes, SCREAMING_SNAKE_CASE for constants; keep file names predictable (e.g., \`feature-name.test.ts\`).
- Favor small, focused modules and pure functions; document non-obvious behavior with brief comments.

## Testing Guidelines
- Primary framework (e.g., Vitest/Jest); colocate tests as \`*.test.ts\` near sources or group under \`tests/\`.
- Cover success, error, and boundary cases; keep fixtures deterministic and minimal.
- For long suites, run focused tests: \`npm test -- <pattern>\`; add coverage goals if required.

## Commit & Pull Request Guidelines
- Branch from \`main\`; use imperative commit subjects (e.g., \`Add auth middleware\`), optionally scoped.
- PRs: describe behavior changes, link issues, note skipped checks, and attach screenshots for UI. Include validation steps a reviewer can run.
- Run the project's lint/test/build commands expected by CI before requesting review.

## Security & Configuration Tips
- Do not commit secrets; rely on local \`.env.local\` and checked-in \`.env.example\`.
- Document new environment variables, migrations, and destructive scripts; prefer least-privilege defaults.
`;

const GENERATION_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.

Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section. Follow the outline below, but adapt as needed—add sections if relevant, and omit those that do not apply to this project.

Document Requirements:
- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise; 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections:
- Project Structure & Module Organization: Outline where source code, tests, docs, configs, and assets live.
- Build, Test, and Development Commands: List key commands for installing, building, testing, and running locally with short explanations.
- Coding Style & Naming Conventions: Indentation rules, style preferences, naming patterns, formatting/linting tools.
- Testing Guidelines: Frameworks, coverage expectations, naming conventions, and how to run tests.
- Commit & Pull Request Guidelines: Commit message conventions, PR requirements (descriptions, linked issues, screenshots), and pre-review checks.
- (Optional) Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions if applicable.

Instructions:
- Use the available tools to inspect this repository as needed (e.g., list directories, read configs, inspect scripts) before writing.
- If existing AI tool rule files are supplied below, preserve their intent in the generated AGENTS.md instead of ignoring or mechanically concatenating them.
- Add a short HTML comment near the top noting which AI rule sources contributed.
- Overwrite the entire contents of AGENTS.md at the target path.
- Keep output scoped to the single Markdown file; do not create extra files.
- Write the final document directly to the AGENTS.md file and return a brief confirmation when done.`;

const MAX_IMPORTED_RULE_BYTES = 12_000;
const RULE_WALK_IGNORE_DIRS = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".turbo",
	".cache",
	"tmp",
]);

export interface AgentRuleSource {
	path: string;
	relativePath: string;
	label: string;
	content: string;
	truncated: boolean;
}

function buildAgentsTemplate(projectName: string): string {
	return TEMPLATE.replace(/{{PROJECT_NAME}}/g, projectName);
}

export interface AgentsInitOptions {
	force?: boolean;
}

function resolveTargetPath(targetPath?: string): string {
	if (!targetPath) {
		return join(process.cwd(), "AGENTS.md");
	}
	const resolved = resolve(targetPath);
	if (resolved.toLowerCase().endsWith(".md")) {
		return resolved;
	}
	return join(resolved, "AGENTS.md");
}

function isMarkdownRuleFile(fileName: string): boolean {
	const lower = fileName.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".mdc");
}

function isPathInside(root: string, candidate: string): boolean {
	const relativePath = relative(root, candidate);
	return (
		relativePath === "" ||
		(!relativePath.startsWith("..") && !isAbsolute(relativePath))
	);
}

function readRuleSource(
	projectRoot: string,
	filePath: string,
	label: string,
): AgentRuleSource | null {
	try {
		const resolvedPath = resolve(filePath);
		const linkStat = lstatSync(resolvedPath);
		if (!linkStat.isFile()) {
			return null;
		}
		const rootRealPath = realpathSync(projectRoot);
		const fileRealPath = realpathSync(resolvedPath);
		if (!isPathInside(rootRealPath, fileRealPath)) {
			return null;
		}
		const stat = statSync(resolvedPath);
		if (!stat.isFile()) {
			return null;
		}
		const raw = readFileSync(resolvedPath);
		const truncated = raw.byteLength > MAX_IMPORTED_RULE_BYTES;
		const content = truncated
			? truncateUtf8(raw, MAX_IMPORTED_RULE_BYTES).content
			: raw.toString("utf-8");
		return {
			path: resolvedPath,
			relativePath:
				relative(projectRoot, resolvedPath) || basename(resolvedPath),
			label,
			content,
			truncated,
		};
	} catch {
		return null;
	}
}

function walkRuleFiles(
	dir: string,
	predicate: (fileName: string) => boolean,
): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const entry of entries) {
		const entryPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!RULE_WALK_IGNORE_DIRS.has(entry.name)) {
				files.push(...walkRuleFiles(entryPath, predicate));
			}
			continue;
		}
		if (entry.isFile() && predicate(entry.name)) {
			files.push(entryPath);
		}
	}
	return files.sort((a, b) => a.localeCompare(b));
}

export function discoverAgentRuleSources(
	projectRoot: string,
	targetPath?: string,
	includeTarget = false,
): AgentRuleSource[] {
	const root = resolve(projectRoot);
	const target = targetPath ? resolve(targetPath) : null;
	const sources = new Map<string, AgentRuleSource>();

	const addSource = (filePath: string, label: string): void => {
		const resolvedPath = resolve(filePath);
		const source = readRuleSource(root, resolvedPath, label);
		if (!source) {
			return;
		}
		sources.set(resolvedPath, source);
	};

	if (target && includeTarget && existsSync(target)) {
		addSource(target, "Existing AGENTS.md");
	}
	for (const candidate of ["AGENTS.md", "AGENT.md"]) {
		const candidatePath = join(root, candidate);
		if (!target || resolve(candidatePath) !== target) {
			addSource(candidatePath, "Existing Maestro agent instructions");
		}
	}

	for (const cursorRule of walkRuleFiles(
		join(root, ".cursor", "rules"),
		(name) => isMarkdownRuleFile(name),
	)) {
		addSource(cursorRule, "Cursor rule");
	}
	addSource(join(root, ".cursorrules"), "Cursor rules");
	for (const claudeRule of walkRuleFiles(
		root,
		(name) => name === "CLAUDE.md",
	)) {
		addSource(claudeRule, "Claude instructions");
	}
	addSource(join(root, ".windsurfrules"), "Windsurf rules");
	addSource(join(root, ".clinerules"), "Cline rules");
	addSource(join(root, ".goosehints"), "Goose hints");
	addSource(
		join(root, ".github", "copilot-instructions.md"),
		"Copilot instructions",
	);

	return Array.from(sources.values()).sort((a, b) =>
		a.relativePath.localeCompare(b.relativePath),
	);
}

function formatRuleSourceSummary(sources: AgentRuleSource[]): string {
	if (sources.length === 0) {
		return "";
	}
	const sourcePaths = sources.map((source) =>
		formatRulePathForHtmlComment(source.relativePath),
	);
	return [
		"## Imported AI Tooling Rules",
		`<!-- Imported by maestro /init from: ${sourcePaths.join(", ")} -->`,
		"",
		"Review and fold these existing AI-tool instructions into the sections above:",
		"",
		...sources.map((source) => {
			const truncatedNote = source.truncated ? " (truncated)" : "";
			return `- ${formatRulePathForMarkdown(source.relativePath)}: ${source.label}${truncatedNote}`;
		}),
		"",
	].join("\n");
}

function formatRulePathForMarkdown(relativePath: string): string {
	return JSON.stringify(relativePath);
}

function formatRulePathForHtmlComment(relativePath: string): string {
	return JSON.stringify(relativePath).replaceAll("--", "- -");
}

function markdownFenceFor(content: string): string {
	const longestBacktickRun = Math.max(
		0,
		...(content.match(/`+/g) ?? []).map((run) => run.length),
	);
	return "`".repeat(Math.max(3, longestBacktickRun + 1));
}

function formatRuleSourcesForPrompt(sources: AgentRuleSource[]): string {
	if (sources.length === 0) {
		return "";
	}
	const blocks = sources.map((source) => {
		const fence = markdownFenceFor(source.content);
		return [
			`### ${formatRulePathForMarkdown(source.relativePath)} (${source.label})`,
			source.truncated
				? `The content below was truncated to ${MAX_IMPORTED_RULE_BYTES} bytes.`
				: "",
			`${fence}md`,
			source.content.trimEnd(),
			fence,
		]
			.filter(Boolean)
			.join("\n");
	});
	return ["", "Existing AI tool rule files to merge:", "", ...blocks].join(
		"\n\n",
	);
}

export function buildAgentsInitPrompt(
	targetPath: string,
	sources: AgentRuleSource[] = discoverAgentRuleSources(
		dirname(targetPath),
		targetPath,
	),
): string {
	return `${GENERATION_PROMPT}\n\nTarget path: ${targetPath}${formatRuleSourcesForPrompt(sources)}`;
}

export function handleAgentsInit(
	inputPath?: string,
	options: AgentsInitOptions = {},
): string {
	const target = resolveTargetPath(inputPath);
	const directory = dirname(target);
	const projectName = basename(directory);
	const exists = existsSync(target);
	if (exists && !options.force) {
		throw new Error(`AGENTS.md already exists at ${target}`);
	}
	const ruleSources = discoverAgentRuleSources(directory, target, exists);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		target,
		`${buildAgentsTemplate(projectName).trimEnd()}\n\n${formatRuleSourceSummary(ruleSources)}`,
		"utf-8",
	);
	return target;
}
