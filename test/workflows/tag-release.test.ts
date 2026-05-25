import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

describe("tag-release workflow", () => {
	it("dispatches the release workflow from the tag it just created", () => {
		const workflow = YAML.parse(
			readFileSync(
				join(process.cwd(), ".github/workflows/tag-release.yml"),
				"utf8",
			),
		) as {
			jobs: {
				"tag-current-version": {
					steps: Array<{
						env?: Record<string, string>;
						name?: string;
						run?: string;
					}>;
				};
			};
		};
		const dispatchStep = workflow.jobs["tag-current-version"].steps.find(
			(step) => step.name === "Dispatch public release workflow",
		);
		const registryStep = workflow.jobs["tag-current-version"].steps.find(
			(step) => step.name === "Check npm registry release",
		);
		const activeReleaseStep = workflow.jobs["tag-current-version"].steps.find(
			(step) => step.name === "Check active public release workflow",
		);

		expect(dispatchStep?.env?.RELEASE_TAG).toBe(
			"${{ steps.release.outputs.release_tag }}",
		);
		expect(registryStep?.run).toContain("npm view");
		expect(activeReleaseStep?.run).toContain("gh run list");
		expect(activeReleaseStep?.run).toContain("--workflow release");
		expect(activeReleaseStep?.run).toContain(".headBranch");
		expect(activeReleaseStep?.run).not.toContain("--branch");
		expect(dispatchStep?.if).toContain(
			"steps.registry-release.outputs.published != 'true'",
		);
		expect(dispatchStep?.if).toContain(
			"steps.active-release.outputs.active_count == '0'",
		);
		expect(dispatchStep?.run).toContain(
			'gh workflow run release --ref "${RELEASE_TAG}" --field "version=${RELEASE_VERSION}"',
		);
	});
});
