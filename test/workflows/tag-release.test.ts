import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { expectRegistryInstallSmokeIsReleaseBlocking } from "../utils/registry-install-smoke-guard.js";

describe("tag-release workflow", () => {
	it("dispatches the release workflow from the tag it just created", () => {
		const workflow = YAML.parse(
			readFileSync(
				join(process.cwd(), ".github/workflows/tag-release.yml"),
				"utf8",
			),
		) as {
			env?: Record<string, unknown>;
			jobs: {
				"tag-current-version": {
					env?: Record<string, unknown>;
					outputs?: Record<string, string>;
					permissions?: Record<string, string>;
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
				"dispatch-public-release": {
					if?: string;
					needs?: string[];
					permissions?: Record<string, string>;
					steps: Array<{
						env?: Record<string, string>;
						if?: string;
						name?: string;
						run?: string;
					}>;
					"timeout-minutes"?: number;
				};
				"verify-published-registry-package": {
					env?: Record<string, unknown>;
					if?: string;
					needs?: string;
					permissions?: Record<string, string>;
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
		const steps = workflow.jobs["tag-current-version"].steps;
		const registrySmokeJob = workflow.jobs["verify-published-registry-package"];
		const dispatchJob = workflow.jobs["dispatch-public-release"];
		const upstreamDispatchStep = steps.find(
			(step) => step.name === "Dispatch public release workflow",
		);
		const dispatchStep = dispatchJob.steps.find(
			(step) => step.name === "Dispatch public release workflow",
		);
		const registryStep = steps.find(
			(step) => step.name === "Check npm registry release",
		);
		const activeReleaseStep = steps.find(
			(step) => step.name === "Check active public release workflow",
		);
		const mismatchGuard = steps.find(
			(step) => step.name === "Require version bump for existing release tag",
		);
		const summaryStep = steps.find(
			(step) => step.name === "Summarize tag status",
		);
		const registrySmokeCheckoutStep = registrySmokeJob.steps.find((step) =>
			step.uses?.startsWith("actions/checkout@"),
		);
		const setupPublishedSmokeStep = registrySmokeJob.steps.find(
			(step) => step.name === "Setup registry install smoke tools",
		);
		const verifyPublishedSmokeIndex = registrySmokeJob.steps.findIndex(
			(step) => step.name === "Verify already-published package from registry",
		);
		const verifyPublishedSmokeStep =
			registrySmokeJob.steps[verifyPublishedSmokeIndex];
		const uploadEvidenceStep = registrySmokeJob.steps.find(
			(step) => step.name === "Upload already-published replay evidence",
		);

		expect(workflow.jobs["tag-current-version"]["timeout-minutes"]).toBe(45);
		expect(workflow.jobs["tag-current-version"].permissions).toEqual({
			actions: "read",
			contents: "write",
		});
		expect(workflow.jobs["tag-current-version"].outputs).toMatchObject({
			active_release_count: "${{ steps.active-release.outputs.active_count }}",
			package_name: "${{ steps.release.outputs.package_name }}",
			release_tag: "${{ steps.release.outputs.release_tag }}",
			release_version: "${{ steps.release.outputs.release_version }}",
			tag_exists: "${{ steps.release.outputs.tag_exists }}",
			registry_published: "${{ steps.registry-release.outputs.published }}",
		});
		expect(registrySmokeJob.needs).toBe("tag-current-version");
		expect(registrySmokeJob.if).toContain(
			"needs.tag-current-version.outputs.registry_published == 'true'",
		);
		expect(registrySmokeJob.permissions).toEqual({ contents: "read" });
		expect(registrySmokeJob["timeout-minutes"]).toBe(30);
		expect(registrySmokeCheckoutStep?.with).toMatchObject({
			"persist-credentials": false,
		});
		expect(registryStep?.run).toContain("npm view");
		expect(setupPublishedSmokeStep?.uses).toBe(
			"./.github/actions/setup-bun-nx",
		);
		expect(setupPublishedSmokeStep?.with).toMatchObject({
			install: "false",
			"cache-nx": "false",
			"ensure-rustfmt": "false",
		});
		expect(verifyPublishedSmokeStep?.env).toMatchObject({
			PACKAGE_NAME: "${{ needs.tag-current-version.outputs.package_name }}",
			RELEASE_VERSION:
				"${{ needs.tag-current-version.outputs.release_version }}",
			MAESTRO_INSTALL_AUDIT_LEVEL: "critical",
			MAESTRO_PUBLISHED_REPLAY_SANDBOX_MODE: "local",
			MAESTRO_REGISTRY_SMOKE_EVIDENCE_DIR:
				"tag-release-published-replay-evidence",
			MAESTRO_REGISTRY_POLL_ATTEMPTS: "1",
			MAESTRO_REGISTRY_POLL_DELAY_MS: "1000",
		});
		expect(verifyPublishedSmokeIndex).toBeGreaterThanOrEqual(0);
		expectRegistryInstallSmokeIsReleaseBlocking(
			verifyPublishedSmokeStep,
			[workflow.env, registrySmokeJob.env],
			{
				containingJob: registrySmokeJob,
				precedingSteps: registrySmokeJob.steps.slice(
					0,
					verifyPublishedSmokeIndex,
				),
			},
		);
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
		expect(uploadEvidenceStep?.with?.name).toBe(
			"tag-release-published-replay-evidence-${{ needs.tag-current-version.outputs.release_tag }}",
		);
		expect(uploadEvidenceStep?.with?.path).toBe(
			"tag-release-published-replay-evidence/*.json",
		);
		expect(activeReleaseStep?.run).toContain("gh run list");
		expect(activeReleaseStep?.run).toContain("--workflow release");
		expect(activeReleaseStep?.run).toContain(".headBranch");
		expect(activeReleaseStep?.run).not.toContain("--branch");
		expect(upstreamDispatchStep).toBeUndefined();
		expect(dispatchJob.needs).toEqual([
			"tag-current-version",
			"verify-published-registry-package",
		]);
		expect(dispatchJob.permissions).toEqual({
			actions: "write",
			contents: "read",
		});
		expect(dispatchJob["timeout-minutes"]).toBe(10);
		expect(dispatchJob.if).toContain("always()");
		expect(dispatchJob.if).toContain(
			"needs.tag-current-version.result == 'success'",
		);
		expect(dispatchJob.if).toContain(
			"needs.tag-current-version.outputs.registry_published != 'true'",
		);
		expect(dispatchJob.if).toContain(
			"needs.verify-published-registry-package.result == 'success'",
		);
		expect(dispatchJob.if).toContain(
			"(needs.tag-current-version.outputs.registry_published != 'true' || needs.verify-published-registry-package.result == 'success')",
		);
		expect(dispatchJob.if).toContain(
			"needs.tag-current-version.outputs.tag_exists != 'true'",
		);
		expect(mismatchGuard?.if).toContain(
			"github.repository == 'evalops/maestro'",
		);
		expect(mismatchGuard?.if).toContain(
			"steps.registry-release.outputs.published != 'true'",
		);
		expect(dispatchJob.if).toContain(
			"needs.tag-current-version.outputs.active_release_count == '0'",
		);
		expect(dispatchStep?.env?.RELEASE_TAG).toBe(
			"${{ needs.tag-current-version.outputs.release_tag }}",
		);
		expect(dispatchStep?.env?.RELEASE_VERSION).toBe(
			"${{ needs.tag-current-version.outputs.release_version }}",
		);
		expect(dispatchStep?.run).toContain(
			'gh workflow run release --repo "${GITHUB_REPOSITORY}" --ref "${RELEASE_TAG}" --field "version=${RELEASE_VERSION}"',
		);
		expect(dispatchStep?.run).toMatch(
			/gh run list\s+\\\n\s+--repo "\$\{GITHUB_REPOSITORY\}"/,
		);
		expect(dispatchStep?.run).toContain("dispatched_release_run_count()");
		expect(dispatchStep?.run).not.toContain(
			"new_active_dispatched_release_run_count()",
		);
		expect(dispatchStep?.run).toContain("retry()");
		expect(dispatchStep?.run).toContain(
			'retry "List active release workflows" active_release_run_count',
		);
		expect(dispatchStep?.run).toContain(
			'retry "List dispatched release workflows" dispatched_release_run_count',
		);
		expect(dispatchStep?.run).toContain(
			'retry "Dispatch release workflow" gh workflow run release',
		);
		expect(dispatchStep?.run).toContain(
			'retry "Confirm dispatched release workflow" dispatched_release_run_count',
		);
		expect(dispatchStep?.run).toContain("confirmation attempt ${attempt}/6");
		expect(dispatchStep?.run).toContain("sleep 10");
		expect(dispatchStep?.run).not.toContain("sleep 5");
		expect(dispatchStep?.run).toContain(
			"Release workflow dispatch did not produce a new run",
		);
		expect(dispatchStep?.run).toContain('--repo "${GITHUB_REPOSITORY}"');
		expect(dispatchStep?.run).toContain("--workflow release");
		expect(dispatchStep?.run).toContain(".headBranch");
		expect(dispatchStep?.run).toContain('.event == \\"workflow_dispatch\\"');
		expect(dispatchStep?.run).toContain(
			'if [[ "${active_count}" != "0" ]]; then',
		);
		expect(dispatchStep?.run).toContain("dispatch_status=0");
		expect(dispatchStep?.run).toContain("|| dispatch_status=$?");
		expect(dispatchStep?.run).not.toContain("dispatch_started_at=");
		expect(dispatchStep?.run).toContain("release_run_count=");
		expect(dispatchStep?.run).toContain("--json event,headBranch");
		expect(dispatchStep?.run).toContain(
			"if (( release_run_count > existing_count )); then",
		);
		expect(dispatchStep?.run).toContain(
			"up from ${existing_count} before dispatch",
		);
		const dispatchRun = dispatchStep?.run ?? "";
		const dispatchedHelperBlock = dispatchRun.slice(
			dispatchRun.indexOf("dispatched_release_run_count()"),
			dispatchRun.indexOf("retry()"),
		);
		expect(dispatchedHelperBlock).toContain(
			'select(.headBranch == \\"${RELEASE_TAG}\\" and .event == \\"workflow_dispatch\\")] | length',
		);
		expect(dispatchedHelperBlock).not.toContain("createdAt");
		expect(dispatchedHelperBlock).not.toContain("status !=");
		expect(dispatchStep?.run).toContain(
			'if [[ "${dispatch_status}" != "0" ]]; then',
		);
		expect(summaryStep?.run).toContain("is already published on npm");
	});
});
