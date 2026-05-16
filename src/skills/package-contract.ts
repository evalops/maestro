import { relative } from "node:path";
import {
	collectPackageValidationIssues,
	inspectPackageSource,
} from "../packages/inspection.js";
import { formatPackageSource } from "../packages/sources.js";
import type { DiscoveredPackage } from "../packages/types.js";
import {
	type SkillEvalReport,
	evaluateSkillPackages,
	formatSkillEvalText,
	hasSkillEvalFailures,
} from "./eval-harness.js";

export const SKILL_PACKAGE_CONTRACT_SCHEMA =
	"evalops.maestro.skill-package-publish-contract.v1";
export const MAESTRO_PACKAGE_KEYWORD = "maestro-package";
export const MAESTRO_SKILL_PACKAGE_KEYWORD = "maestro-skill-package";

export interface SkillPackageContractIssue {
	code: string;
	message: string;
}

export interface SkillPackageInstallCommandSet {
	local: string;
	npm?: string;
}

export interface SkillPackagePublishContract {
	schemaVersion: typeof SKILL_PACKAGE_CONTRACT_SCHEMA;
	sourceSpec: string;
	resolvedSource: string;
	resolvedPath: string;
	package: {
		name: string | null;
		version: string | null;
		keywords: string[];
	};
	resources: {
		skills: string[];
		prompts: string[];
		extensions: string[];
		themes: string[];
	};
	install: SkillPackageInstallCommandSet;
	evalReport: SkillEvalReport | null;
	issues: SkillPackageContractIssue[];
}

export interface BuildSkillPackagePublishContractOptions {
	cwd?: string;
	describeToolbox?: boolean;
}

function packageKeywords(discovered: DiscoveredPackage | null): string[] {
	return Array.isArray(discovered?.packageJson.keywords)
		? discovered.packageJson.keywords
		: [];
}

function issue(code: string, message: string): SkillPackageContractIssue {
	return { code, message };
}

function buildInstallCommands(input: {
	cwd: string;
	resolvedPath: string;
	discovered: DiscoveredPackage | null;
}): SkillPackageInstallCommandSet {
	const relativePath = relative(input.cwd, input.resolvedPath) || ".";
	const localPath = relativePath.startsWith(".")
		? relativePath
		: `./${relativePath}`;
	const local = `maestro skill install local:${localPath}`;
	const name = input.discovered?.packageJson.name;
	const version = input.discovered?.packageJson.version;
	return {
		local,
		...(name
			? {
					npm: `maestro skill install npm:${name}${version ? `@${version}` : ""}`,
				}
			: {}),
	};
}

function collectContractIssues(input: {
	discovered: DiscoveredPackage | null;
	validationIssues: string[];
	skillCount: number;
	evalReport: SkillEvalReport | null;
}): SkillPackageContractIssue[] {
	const issues = input.validationIssues.map((message) =>
		issue("package_validation", message),
	);
	const keywords = packageKeywords(input.discovered);
	if (!keywords.includes(MAESTRO_PACKAGE_KEYWORD)) {
		issues.push(
			issue(
				"missing_maestro_package_keyword",
				`package.json keywords must include "${MAESTRO_PACKAGE_KEYWORD}".`,
			),
		);
	}
	if (!keywords.includes(MAESTRO_SKILL_PACKAGE_KEYWORD)) {
		issues.push(
			issue(
				"missing_maestro_skill_package_keyword",
				`package.json keywords must include "${MAESTRO_SKILL_PACKAGE_KEYWORD}" for OSS skill registry discovery.`,
			),
		);
	}
	if (input.skillCount === 0) {
		issues.push(
			issue(
				"missing_skill_resources",
				"package.json maestro.skills must expose at least one skill directory.",
			),
		);
	}
	if (input.evalReport && hasSkillEvalFailures(input.evalReport)) {
		issues.push(
			issue(
				"skill_package_eval_failed",
				"One or more bundled skills failed the Agent Core package eval contract.",
			),
		);
	}
	return issues;
}

export async function buildSkillPackagePublishContract(
	sourceSpec: string,
	options: BuildSkillPackagePublishContractOptions = {},
): Promise<SkillPackagePublishContract> {
	const cwd = options.cwd ?? process.cwd();
	const inspected = await inspectPackageSource(sourceSpec, cwd);
	const resources = inspected.resources ?? {
		extensions: [],
		skills: [],
		prompts: [],
		themes: [],
	};
	const evalReport =
		resources.skills.length > 0
			? await evaluateSkillPackages(
					resources.skills.map((path) => ({ path })),
					{ describeToolbox: options.describeToolbox },
				)
			: null;
	const issues = collectContractIssues({
		discovered: inspected.discovered,
		validationIssues: collectPackageValidationIssues(inspected),
		skillCount: resources.skills.length,
		evalReport,
	});

	return {
		schemaVersion: SKILL_PACKAGE_CONTRACT_SCHEMA,
		sourceSpec,
		resolvedSource: formatPackageSource(inspected.source),
		resolvedPath: inspected.resolvedPath,
		package: {
			name: inspected.discovered?.packageJson.name ?? null,
			version: inspected.discovered?.packageJson.version ?? null,
			keywords: packageKeywords(inspected.discovered),
		},
		resources: {
			skills: resources.skills,
			prompts: resources.prompts,
			extensions: resources.extensions,
			themes: resources.themes,
		},
		install: buildInstallCommands({
			cwd,
			resolvedPath: inspected.resolvedPath,
			discovered: inspected.discovered,
		}),
		evalReport,
		issues,
	};
}

export function formatSkillPackagePublishContract(
	contract: SkillPackagePublishContract,
): string {
	const lines = [
		`Skill package: ${contract.package.name ?? "(unknown)"}${contract.package.version ? `@${contract.package.version}` : ""}`,
		`Source: ${contract.resolvedSource}`,
		`Skills: ${contract.resources.skills.length}`,
		"Install:",
		`  ${contract.install.local}`,
	];
	if (contract.install.npm) {
		lines.push(`  ${contract.install.npm}`);
	}
	if (contract.evalReport) {
		lines.push("", "Eval:", formatSkillEvalText(contract.evalReport));
	}
	if (contract.issues.length > 0) {
		lines.push("", "Issues:");
		for (const item of contract.issues) {
			lines.push(`- ${item.code}: ${item.message}`);
		}
	} else {
		lines.push("", "Result: publish/install contract passed.");
	}
	return lines.join("\n");
}
