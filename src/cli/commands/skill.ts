import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import chalk from "chalk";
import { PATHS } from "../../config/constants.js";
import {
	type WritablePackageScope,
	addConfiguredPackageSpecToConfig,
} from "../../config/index.js";
import {
	buildSkillPackagePublishContract,
	buildSkillRuntimeActivation,
	evaluateSkillPackages,
	findSkill,
	formatSkillEvalText,
	formatSkillListItem,
	formatSkillPackagePublishContract,
	hasSkillEvalFailures,
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
	scope?: WritablePackageScope;
}

interface SkillCommandContext {
	workspaceDir?: string;
	includeSystemSkills?: boolean;
}

function formatSkillHelp(): string {
	return `maestro skill <command> [options]

Commands:
  list                         List available system, user, and project skills
  inspect <name>               Print one skill package manifest
  install <source>             Validate and install an OSS skill package
  publish-check <source>       Validate an OSS skill package before publishing
  lint [path...]               Validate skill packages
  eval [path...]               Score skill packages against Agent Core constraints
  new <name>                   Scaffold a skill package

Options:
  --json                       Emit machine-readable JSON
  --scope <local|project|user> Install scope for 'install' (default: local)
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

function parseScope(value: string): WritablePackageScope {
	if (value === "local" || value === "project" || value === "user") {
		return value;
	}
	throw new Error("--scope must be local, project, or user");
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
			case "--scope":
				options.scope = parseScope(readValue(args, i, arg));
				i++;
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

async function handleInstall(
	workspaceDir: string,
	sourceSpec: string | undefined,
	options: SkillCommandOptions,
) {
	if (!sourceSpec) {
		throw new Error("maestro skill install requires a package source");
	}
	const contract = await buildSkillPackagePublishContract(sourceSpec, {
		cwd: workspaceDir,
		describeToolbox: false,
	});
	if (contract.issues.length > 0) {
		if (options.json) {
			console.log(JSON.stringify({ installed: false, contract }, null, 2));
		} else {
			console.log(formatSkillPackagePublishContract(contract));
			console.error(
				chalk.red("Skill package install blocked by contract issues."),
			);
		}
		process.exitCode = 1;
		return;
	}

	const installed = addConfiguredPackageSpecToConfig({
		workspaceDir,
		scope: options.scope ?? "local",
		spec: sourceSpec,
	});
	if (options.json) {
		console.log(
			JSON.stringify({ installed: true, config: installed, contract }, null, 2),
		);
		return;
	}
	console.log(
		chalk.green(
			`Installed skill package ${contract.package.name ?? sourceSpec}`,
		),
	);
	console.log(chalk.dim(`scope: ${installed.scope}`));
	console.log(chalk.dim(`config: ${installed.path}`));
	console.log(chalk.dim("Run `maestro skill list` to see loaded skills."));
}

async function handlePublishCheck(
	workspaceDir: string,
	sourceSpec: string | undefined,
	options: SkillCommandOptions,
) {
	if (!sourceSpec) {
		throw new Error("maestro skill publish-check requires a package source");
	}
	const contract = await buildSkillPackagePublishContract(sourceSpec, {
		cwd: workspaceDir,
		describeToolbox: options.describeToolbox,
	});
	if (options.json) {
		console.log(JSON.stringify(contract, null, 2));
	} else {
		console.log(formatSkillPackagePublishContract(contract));
	}
	if (contract.issues.length > 0) {
		process.exitCode = 1;
	}
}

async function handleList(
	workspaceDir: string,
	options: SkillCommandOptions,
	context: SkillCommandContext,
) {
	const result = loadSkills(
		workspaceDir,
		context.includeSystemSkills === undefined
			? undefined
			: { includeSystem: context.includeSystemSkills },
	);
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
	} else {
		for (const skill of result.skills) {
			console.log(formatSkillListItem(skill));
		}
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
		runtimeActivation: buildSkillRuntimeActivation(skill),
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

async function handleEval(
	workspaceDir: string,
	paths: string[],
	options: SkillCommandOptions,
) {
	const evalPaths = paths.length > 0 ? paths : defaultLintPaths(workspaceDir);
	const report = await evaluateSkillPackages(
		evalPaths.map((path) => ({ path })),
		{
			describeToolbox: options.describeToolbox,
		},
	);
	if (options.json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(formatSkillEvalText(report));
	}
	if (hasSkillEvalFailures(report)) {
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
	options: SkillCommandContext = {},
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
			await handleList(workspaceDir, parsedOptions, options);
			return;
		case "inspect":
			await handleInspect(workspaceDir, positionals[0], parsedOptions);
			return;
		case "install":
			await handleInstall(workspaceDir, positionals[0], parsedOptions);
			return;
		case "publish-check":
			await handlePublishCheck(workspaceDir, positionals[0], parsedOptions);
			return;
		case "lint":
			await handleLint(workspaceDir, positionals, parsedOptions);
			return;
		case "eval":
			await handleEval(workspaceDir, positionals, parsedOptions);
			return;
		case "new":
			await handleNew(workspaceDir, positionals[0], parsedOptions);
			return;
		default:
			throw new Error(`Unknown maestro skill command: ${subcommand}`);
	}
}
