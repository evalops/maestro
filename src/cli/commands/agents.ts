import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const TEMPLATE = `# AGENTS instructions for {{PROJECT_NAME}}

## Project overview
- Describe what this repository does
- Call out primary runtime(s) and deployment targets

## Coding standards
- Languages, frameworks, and architectural preferences to follow
- Link to any existing style guides or lint requirements

## Testing expectations
- When to add or update tests
- How to run the relevant test or lint commands locally

## Review checklist
- [ ] Changes include tests (or explain why not)
- [ ] Documentation/comments updated when behavior shifts
- [ ] Run the required validators before asking for review

## Contacts & escalation
- List maintainers or Slack channels for questions
- Mention any files or directories that require extra review
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
