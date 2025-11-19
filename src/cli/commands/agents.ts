import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const TEMPLATE = `# Repository Guidelines

Applies to **{{PROJECT_NAME}}**. Keep this concise, actionable guide close when adding features or debugging.

## Project Structure & Module Organization
- Bun + Nx monorepo; list projects with \`npx nx show projects\`.
- Runtime/CLI code in \`src/\`; apps and shared libs in \`packages/\`; tests co-located as \`*.test.ts\`.
- Key config: \`nx.json\`, \`project.json\`, \`package.json\`, and CI specs under \`.github/workflows/\`.

## Build, Test, and Development Commands
- Install deps: \`bun install\` (or \`bun install --filter <pkg>\` for a single package).
- Lint: \`bun run bun:lint\`.
- Full suite: \`npx nx run composer:test --skip-nx-cache\` (builds TUI + web).
- Package builds: \`npx nx run tui:build\`, \`npx nx run composer-web:build\`.
- Targeted tests: \`bunx vitest --run -t "<test name>"\`.

## Coding Style & Naming Conventions
- TypeScript-first; prefer functional utilities and async/await; avoid implicit any.
- Follow existing patterns in \`src/\` and \`packages/\`; keep imports relative within a package.
- Formatting via Biome; descriptive names (command handlers \`handleX\`, components PascalCase).

## Testing Guidelines
- Use Vitest; keep tests near sources as \`*.test.ts\`.
- Cover error paths and CLI output; keep fixtures minimal and deterministic.
- Run relevant \`nx run ...:test\` targets or focused Vitest commands locally.

## Commit & Pull Request Guidelines
- Branch from main; never commit directly to main.
- Commit titles: \`[composer] <imperative change>\`.
- PRs: describe behavior change, link issues, note skipped checks, include screenshots for UI.
- Before review: \`bun run bun:lint\`, \`npx nx run composer:test --skip-nx-cache\`, and build any touched packages.

## Security & Configuration Tips
- Keep secrets out of logs; prefer local \`.env\` files.
- Respect safe-mode flags; avoid destructive commands; favor documented Nx/Bun workflows over ad-hoc scripts.
`;

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
