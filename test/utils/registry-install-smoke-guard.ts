import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { parse } from "yaml";

type RegistryInstallSmokeStep = {
	env?: Record<string, unknown>;
	run?: string;
	uses?: string;
	"continue-on-error"?: unknown;
};

type RegistryInstallSmokeJob = {
	"continue-on-error"?: unknown;
};

type RegistryInstallSmokeCompositeAction = {
	runs?: {
		steps?: RegistryInstallSmokeStep[];
		using?: string;
	};
};

type RegistryInstallSmokeGuardOptions = {
	containingJob?: RegistryInstallSmokeJob;
	localActionRoot?: string;
	precedingSteps?: RegistryInstallSmokeStep[];
};

const runWritesSkipVariableToGitHubEnv = (
	run: string,
	variable: string,
): boolean =>
	/\bGITHUB_ENV\b/u.test(run) && new RegExp(`\\b${variable}\\b`, "u").test(run);

const localActionPathForUses = (
	uses: string | undefined,
): string | undefined => (uses?.startsWith("./") ? uses.slice(2) : undefined);

const loadLocalCompositeActionSteps = (
	uses: string | undefined,
	root: string,
	visitedActionFiles: Set<string>,
): RegistryInstallSmokeStep[] => {
	const actionPath = localActionPathForUses(uses);
	if (!actionPath) {
		return [];
	}
	const actionFiles = [
		join(root, actionPath, "action.yml"),
		join(root, actionPath, "action.yaml"),
	];
	const actionFile = actionFiles.find((candidate) => existsSync(candidate));
	if (!actionFile || visitedActionFiles.has(actionFile)) {
		return [];
	}
	visitedActionFiles.add(actionFile);
	const action = parse(readFileSync(actionFile, "utf8")) as
		| RegistryInstallSmokeCompositeAction
		| undefined;
	if (action?.runs?.using !== "composite") {
		return [];
	}
	return action.runs.steps ?? [];
};

const collectRunBlocks = (
	step: RegistryInstallSmokeStep,
	root: string,
	visitedActionFiles: Set<string>,
): string[] => [
	...(step.run ? [step.run] : []),
	...loadLocalCompositeActionSteps(step.uses, root, visitedActionFiles).flatMap(
		(actionStep) => collectRunBlocks(actionStep, root, visitedActionFiles),
	),
];

export function expectRegistryInstallSmokeIsReleaseBlocking(
	step: RegistryInstallSmokeStep | undefined,
	inheritedEnv: Array<Record<string, unknown> | undefined> = [],
	options: RegistryInstallSmokeGuardOptions = {},
) {
	const skipVariables = [
		"MAESTRO_SKIP_BUN_INSTALL_SMOKE",
		"MAESTRO_ALLOW_REGISTRY_BUN_INSTALL_SMOKE_SKIP",
	];
	expect(step).toBeDefined();
	expect(step?.run).toContain("scripts/smoke-registry-install.js");
	expect(step ?? {}).not.toHaveProperty("continue-on-error");
	expect(options.containingJob ?? {}).not.toHaveProperty("continue-on-error");
	for (const env of [...inheritedEnv, step?.env ?? {}]) {
		for (const variable of skipVariables) {
			expect(env ?? {}).not.toHaveProperty(variable);
		}
	}
	for (const variable of skipVariables) {
		expect(step?.run ?? "").not.toMatch(new RegExp(`\\b${variable}\\s*=`));
	}
	for (const precedingStep of options.precedingSteps ?? []) {
		const precedingRunBlocks = collectRunBlocks(
			precedingStep,
			options.localActionRoot ?? process.cwd(),
			new Set(),
		);
		for (const variable of skipVariables) {
			for (const precedingRun of precedingRunBlocks) {
				expect(
					runWritesSkipVariableToGitHubEnv(precedingRun, variable),
					`${variable} must not be written to GITHUB_ENV before registry install smoke`,
				).toBe(false);
			}
		}
	}
}
