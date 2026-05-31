import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

type Workflow = {
	on: {
		schedule?: Array<{ cron: string }>;
		workflow_dispatch?: {
			inputs?: Record<string, unknown>;
		};
	};
	env?: Record<string, string>;
	jobs: {
		"version-bump": {
			if?: string;
			steps: Array<{
				id?: string;
				name?: string;
				run?: string;
				env?: Record<string, string>;
			}>;
		};
	};
};

function readWorkflow(): Workflow {
	return YAML.parse(
		readFileSync(
			join(process.cwd(), ".github/workflows/version-bump.yml"),
			"utf8",
		),
	) as Workflow;
}

describe("version-bump workflow", () => {
	it("runs on the weekly internal release cadence", () => {
		const workflow = readWorkflow();

		expect(workflow.on.schedule?.[0]?.cron).toBe("0 16 * * 1");
		expect(workflow.jobs["version-bump"].if).toContain(
			"github.repository == 'evalops/maestro-internal'",
		);
		expect(workflow.env?.RELEASE_BUMP_TYPE).toBe(
			"${{ github.event.inputs.bump_type || 'patch' }}",
		);
	});

	it("extracts generated changelog notes into the release PR body", () => {
		const workflow = readWorkflow();
		const steps = workflow.jobs["version-bump"].steps;
		const changelogStep = steps.find(
			(step) => step.name === "Extract generated changelog entry",
		);
		const prStep = steps.find(
			(step) => step.name === "Open or reuse release PR",
		);

		expect(changelogStep?.run).toContain(
			"scripts/release-notes.js latest-entry",
		);
		expect(prStep?.run).toContain("## Changelog");
		expect(prStep?.run).toContain("${changelog_entry}");
	});

	it("refreshes an existing release branch instead of no-oping the cadence", () => {
		const workflow = readWorkflow();
		const prepareStep = workflow.jobs["version-bump"].steps.find(
			(step) => step.name === "Prepare versioned files",
		);
		const commitStep = workflow.jobs["version-bump"].steps.find(
			(step) => step.name === "Commit release branch",
		);

		expect(prepareStep?.run).toContain(
			'git switch -C "$RELEASE_BRANCH" "origin/$RELEASE_BRANCH"',
		);
		expect(prepareStep?.run).toContain(
			'git merge --no-edit "origin/${RELEASE_BASE_REF}"',
		);
		expect(prepareStep?.run).toContain(
			'node scripts/version.js set "$RELEASE_VERSION" --release-notes-ref "origin/${RELEASE_BASE_REF}"',
		);
		expect(commitStep?.run).toContain("git status --porcelain");
		expect(commitStep?.run).toContain('git rev-parse "origin/$RELEASE_BRANCH"');
		expect(commitStep?.run).toContain('git push origin "$RELEASE_BRANCH"');
	});

	it("updates an existing release PR body with regenerated changelog notes", () => {
		const workflow = readWorkflow();
		const prStep = workflow.jobs["version-bump"].steps.find(
			(step) => step.name === "Open or reuse release PR",
		);

		expect(prStep?.run).toContain("existing_pr_number=");
		expect(prStep?.run).toContain('gh pr edit "$existing_pr_number"');
		expect(prStep?.run).toContain('--body "$pr_body"');
	});
});
