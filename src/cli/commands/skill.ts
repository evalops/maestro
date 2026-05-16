import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import chalk from "chalk";
import { PATHS } from "../../config/constants.js";
import {
	findSkill,
	formatSkillListItem,
	hasSkillLintErrors,
	lintSkillPaths,
	loadSkills,
	scaffoldSkill,
	skillToDict,
} from "../../skills/index.js";
import { formatSkillLintText } from "../../skills/linter.js";

interface SkillCommandOptions {
	json?: boolean;
	dir?: string;
	description?: string;
	force?: boolean;
	describeToolbox?: boolean;
}

function formatSkillHelp(): string {
	return `maestro skill <command> [options]

Commands:
  list                         List available system, user, and project skills
  inspect <name>               Print one skill package manifest
  lint [path...]               Validate skill packages
  new <name>                   Scaffold a skill package

Options:
  --json                       Emit machine-readable JSON
  --dir <path>                 Base directory for 'new' (default: .maestro/skills)
  --description <text>         Description for 'new'
  --force                      Allow 'new' to overwrite an existing directory
  --describe-toolbox           Run Toolbox describe checks during lint
  --help, -h                   Show this help`;
}

function readValue(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("-")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function parseOptions(args: string[]): {
	options: SkillCommandOptions;
	positionals: string[];
} {
	const options: SkillCommandOptions = {};
	const positionals: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--json":
				options.json = true;
				break;
			case "--dir":
				options.dir = readValue(args, i, arg);
				i++;
				break;
			case "--description":
				options.description = readValue(args, i, arg);
				i++;
				break;
			case "--force":
				options.force = true;
				break;
			case "--describe-toolbox":
				options.describeToolbox = true;
				break;
			case "--help":
			case "-h":
				positionals.push(arg);
				break;
			default:
				if (arg?.startsWith("-")) {
					throw new Error(`Unknown maestro skill option: ${arg}`);
				}
				if (arg) positionals.push(arg);
		}
	}
	return { options, positionals };
}

function defaultLintPaths(workspaceDir: string): string[] {
	const candidates = [
		join(workspaceDir, "skills"),
		join(workspaceDir, ".maestro", "skills"),
		join(PATHS.MAESTRO_HOME, "skills"),
	].filter((path) => existsSync(path));
	return candidates.length > 0 ? candidates : [join(workspaceDir, "skills")];
}

async function handleList(workspaceDir: string, options: SkillCommandOptions) {
	const result = loadSkills(workspaceDir);
	if (options.json) {
		console.log(
			JSON.stringify(
				{
					skills: result.skills.map((skill) => ({
						...skillToDict(skill),
						sourceType: skill.sourceType,
						sourcePath: skill.sourcePath,
					})),
					errors: result.errors.map((error) => ({
						code: error.code,
						message: error.message,
						path: error.path,
					})),
				},
				null,
				2,
			),
		);
		return;
	}

	if (result.skills.length === 0) {
		console.log(chalk.dim("No skills found."));
		return;
	}
	for (const skill of result.skills) {
		console.log(formatSkillListItem(skill));
	}
	if (result.errors.length > 0) {
		console.error(
			chalk.yellow(`\n${result.errors.length} skill load warning(s).`),
		);
	}
}

async function handleInspect(
	workspaceDir: string,
	name: string | undefined,
	options: SkillCommandOptions,
) {
	if (!name) {
		throw new Error("maestro skill inspect requires a skill name");
	}
	const result = loadSkills(workspaceDir);
	const skill = findSkill(result.skills, name);
	if (!skill) {
		throw new Error(`Skill '${name}' not found`);
	}
	const payload = {
		...skillToDict(skill),
		sourceType: skill.sourceType,
		sourcePath: skill.sourcePath,
		resources: skill.resources,
		resourceDirs: skill.resourceDirs,
	};
	if (options.json) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}
	console.log(
		inspect(payload, {
			colors: process.stdout.isTTY,
			compact: false,
			depth: null,
		}),
	);
}

async function handleLint(
	workspaceDir: string,
	paths: string[],
	options: SkillCommandOptions,
) {
	const lintPaths = paths.length > 0 ? paths : defaultLintPaths(workspaceDir);
	const results = await lintSkillPaths(lintPaths, {
		describeToolbox: options.describeToolbox,
	});
	if (options.json) {
		console.log(JSON.stringify({ results }, null, 2));
	} else {
		console.log(formatSkillLintText(results));
	}
	if (hasSkillLintErrors(results)) {
		process.exitCode = 1;
	}
}

async function handleNew(
	workspaceDir: string,
	name: string | undefined,
	options: SkillCommandOptions,
) {
	if (!name) {
		throw new Error("maestro skill new requires a skill name");
	}
	const baseDir = resolve(
		workspaceDir,
		options.dir ?? join(".maestro", "skills"),
	);
	const result = scaffoldSkill(baseDir, name, {
		description: options.description,
		force: options.force,
	});
	if (options.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	console.log(chalk.green(`Created skill ${result.name}`));
	console.log(chalk.dim(result.directory));
	for (const file of result.files) {
		console.log(`  ${file}`);
	}
}

export async function handleSkillCommand(
	subcommand: string | undefined,
	args: string[] = [],
	options: { workspaceDir?: string } = {},
): Promise<void> {
	if (
		!subcommand ||
		subcommand === "help" ||
		args.includes("--help") ||
		args.includes("-h")
	) {
		console.log(formatSkillHelp());
		return;
	}

	const { options: parsedOptions, positionals } = parseOptions(args);
	const workspaceDir = options.workspaceDir ?? process.cwd();

	switch (subcommand) {
		case "list":
			await handleList(workspaceDir, parsedOptions);
			return;
		case "inspect":
			await handleInspect(workspaceDir, positionals[0], parsedOptions);
			return;
		case "lint":
			await handleLint(workspaceDir, positionals, parsedOptions);
			return;
		case "new":
			await handleNew(workspaceDir, positionals[0], parsedOptions);
			return;
		default:
			throw new Error(`Unknown maestro skill command: ${subcommand}`);
	}
}
