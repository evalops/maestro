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
						if?: string;
						name?: string;
						run?: string;
						uses?: string;
						with?: Record<string, string>;
					}>;
					"timeout-minutes"?: number;
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
		const mismatchGuard = workflow.jobs["tag-current-version"].steps.find(
			(step) => step.name === "Require version bump for existing release tag",
		);
		const summaryStep = workflow.jobs["tag-current-version"].steps.find(
			(step) => step.name === "Summarize tag status",
		);
		const setupPublishedSmokeStep = workflow.jobs[
			"tag-current-version"
		].steps.find((step) => step.name === "Setup registry install smoke tools");
		const verifyPublishedSmokeStep = workflow.jobs[
			"tag-current-version"
		].steps.find(
			(step) => step.name === "Verify already-published package from registry",
		);
		const uploadEvidenceStep = workflow.jobs["tag-current-version"].steps.find(
			(step) => step.name === "Upload already-published replay evidence",
		);

		expect(workflow.jobs["tag-current-version"]["timeout-minutes"]).toBe(45);
		expect(dispatchStep?.env?.RELEASE_TAG).toBe(
			"${{ steps.release.outputs.release_tag }}",
		);
		expect(registryStep?.run).toContain("npm view");
		expect(setupPublishedSmokeStep?.if).toContain(
			"steps.registry-release.outputs.published == 'true'",
		);
		expect(setupPublishedSmokeStep?.uses).toBe(
			"./.github/actions/setup-bun-nx",
		);
		expect(setupPublishedSmokeStep?.with).toMatchObject({
			install: "false",
			"cache-nx": "false",
			"ensure-rustfmt": "false",
		});
		expect(verifyPublishedSmokeStep?.if).toContain(
			"github.repository == 'evalops/maestro'",
		);
		expect(verifyPublishedSmokeStep?.if).toContain(
			"steps.registry-release.outputs.published == 'true'",
		);
		expect(verifyPublishedSmokeStep?.env).toMatchObject({
			PACKAGE_NAME: "${{ steps.release.outputs.package_name }}",
			RELEASE_VERSION: "${{ steps.release.outputs.release_version }}",
			MAESTRO_INSTALL_AUDIT_LEVEL: "critical",
			MAESTRO_PUBLISHED_REPLAY_SANDBOX_MODE: "local",
			MAESTRO_REGISTRY_SMOKE_EVIDENCE_DIR:
				"tag-release-published-replay-evidence",
			MAESTRO_REGISTRY_POLL_ATTEMPTS: "1",
			MAESTRO_REGISTRY_POLL_DELAY_MS: "1000",
		});
		expect(verifyPublishedSmokeStep?.run).toContain(
			"node scripts/smoke-registry-install.js",
		);
		expect(verifyPublishedSmokeStep?.run).toContain(
			'--package "$PACKAGE_NAME"',
		);
		expect(verifyPublishedSmokeStep?.run).toContain(
			'--version "$RELEASE_VERSION"',
		);
		expect(verifyPublishedSmokeStep?.run).toContain(
			"node scripts/verify-published-replay-evidence.js --evidence-dir tag-release-published-replay-evidence",
		);
		expect(uploadEvidenceStep?.uses).toBe(
			"actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
		);
		expect(uploadEvidenceStep?.with?.path).toBe(
			"tag-release-published-replay-evidence/*.json",
		);
		expect(activeReleaseStep?.run).toContain("gh run list");
		expect(activeReleaseStep?.run).toContain("--workflow release");
		expect(activeReleaseStep?.run).toContain(".headBranch");
		expect(activeReleaseStep?.run).not.toContain("--branch");
		expect(dispatchStep?.if).toContain(
			"steps.registry-release.outputs.published != 'true'",
		);
		expect(mismatchGuard?.if).toContain(
			"github.repository == 'evalops/maestro'",
		);
		expect(mismatchGuard?.if).toContain(
			"steps.registry-release.outputs.published != 'true'",
		);
		expect(dispatchStep?.if).toContain(
			"steps.active-release.outputs.active_count == '0'",
		);
		expect(dispatchStep?.run).toContain(
			'gh workflow run release --ref "${RELEASE_TAG}" --field "version=${RELEASE_VERSION}"',
		);
		expect(summaryStep?.run).toContain("is already published on npm");
	});
});
