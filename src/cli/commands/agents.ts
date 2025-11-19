import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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
- Overwrite the entire contents of AGENTS.md at the target path.
- Keep output scoped to the single Markdown file; do not create extra files.
- Write the final document directly to the AGENTS.md file and return a brief confirmation when done.`;

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

export function buildAgentsInitPrompt(targetPath: string): string {
	return `${GENERATION_PROMPT}\n\nTarget path: ${targetPath}`;
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
	mkdirSync(directory, { recursive: true });
	writeFileSync(target, buildAgentsTemplate(projectName), "utf-8");
	return target;
}
