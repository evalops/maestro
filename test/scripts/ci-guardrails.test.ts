import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	evaluateGuardrailManifest,
	loadGuardrailManifest,
} from "../../scripts/check-guardrail-regression-suite.mjs";
import {
	evaluatePublicMirrorReviewDebt,
	parsePublicMirrorPulls,
} from "../../scripts/check-public-mirror-review-debt.mjs";
import { scanRuntimeEnvSnapshotHygiene } from "../../scripts/check-runtime-env-snapshot-hygiene.mjs";
import {
	autoMergeText,
	markdownChecklist,
	nextAction,
	summarizeChecks,
} from "../../scripts/maestro-merge-queue-status.mjs";
import { planCiChecks } from "../../scripts/plan-ci-checks.mjs";
import {
	packageManifestReleaseMetadataOnlyChanged,
	planNxTestCommand,
	runtimePackageValidatorsRequired,
} from "../../scripts/plan-nx-test-command.mjs";
import {
	GH_OUTPUT_MAX_BUFFER_BYTES,
	collectFeedbackAuditTargets,
	dedupeFeedbackAuditTargets,
	fetchRecentPullTargets,
	informationalReviewFeedback,
	parseFeedbackAuditArgs,
	reviewFeedbackSeverity,
	reviewThreadSeverity,
	threadBlocksFeedbackAudit,
} from "../../scripts/pr-feedback-audit.mjs";
import {
	evaluateReviewFeedbackDashboardThresholds,
	formatReviewFeedbackDashboard,
	parseReviewFeedbackDashboardArgs,
	summarizeReviewFeedbackDashboard,
} from "../../scripts/pr-feedback-dashboard.mjs";
import {
	LATEST_HEAD_CHECKS_QUERY,
	extractLatestHeadCheckPage,
	formatLatestHeadCheckReport,
} from "../../scripts/pr-latest-head-checks.mjs";
import {
	evaluateReadiness,
	fetchRequiredStatusChecks,
	fetchReviewThreads,
	isBugbotAutofixFalsePositive,
	isBugbotAutofixResolvedByFix,
	parseBugbotAutofixFixedTitles,
	parseRepoSpec,
	prNumberFromInput,
	reviewThreadFindingTitle,
	threadBlocksAfterBugbotDisposition,
} from "../../scripts/pr-ready-to-merge.mjs";
import {
	publicMirrorRefCandidates,
	resolvePublicMirrorRef,
} from "../../scripts/resolve-public-mirror-ref.mjs";
import { expectRegistryInstallSmokeIsReleaseBlocking } from "../utils/registry-install-smoke-guard.js";

const isPreparedPublicMirror = !existsSync(
	new URL("../../.github/public-release-mirror.exclude", import.meta.url),
);

type WorkflowStep = {
	env?: Record<string, unknown>;
	id?: string;
	if?: string;
	name?: string;
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
	"timeout-minutes"?: number;
	"working-directory"?: string;
};

type Workflow = {
	concurrency?: {
		"cancel-in-progress"?: boolean | string;
		group?: string;
	};
	env?: Record<string, unknown>;
	jobs?: Record<
		string,
		{
			env?: Record<string, unknown>;
			needs?: string | string[];
			outputs?: Record<string, unknown>;
			services?: Record<string, { ports?: Array<number | string> }>;
			steps?: WorkflowStep[];
			"timeout-minutes"?: number;
			"runs-on"?: unknown;
		}
	>;
	on?: Record<string, unknown>;
	permissions?: Record<string, unknown>;
};

const node24CreateGitHubAppTokenPin =
	"actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1";

type ProjectConfig = {
	targets?: Record<string, { dependsOn?: string[] }>;
};

type NxTargetTimingRow = {
	durationMs: number;
	status: string;
	target: string;
};

type ReleaseMirrorSourceIdentity = {
	hasInternalReleaseMirrorManifest?: boolean;
};

const releaseMirrorManifestUrl = new URL(
	"../../.github/release-mirror-manifest.json",
	import.meta.url,
);

function hasInternalReleaseMirrorManifest(
	identity: ReleaseMirrorSourceIdentity = {},
): boolean {
	return (
		identity.hasInternalReleaseMirrorManifest ??
		existsSync(releaseMirrorManifestUrl)
	);
}

function isPublicValidationWorkflow(
	workflow: Workflow,
	identity: ReleaseMirrorSourceIdentity = {},
): boolean {
	if (hasInternalReleaseMirrorManifest(identity)) {
		return false;
	}

	const runsOnValues = Object.values(workflow.jobs ?? {}).map((job) =>
		String(job["runs-on"] ?? ""),
	);
	return (
		runsOnValues.some((runsOn) =>
			runsOn.includes("PUBLIC_PR_VALIDATION_RUNNER"),
		) && !workflow.jobs?.["public-release-mirror"]
	);
}

function expectPublicValidationWorkflow(): void {
	const workflow = parse(
		readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
			encoding: "utf8",
		}),
	) as Workflow;
	expect(isPublicValidationWorkflow(workflow)).toBe(true);
}

function expectRustTuiRunnerLane(runsOn: string): void {
	expect(runsOn).toContain("ubuntu-latest");
	if (runsOn.includes("PUBLIC_PR_VALIDATION_RUNNER")) {
		expect(runsOn).not.toContain("PR_RUST_RUNNER");
		expect(runsOn).not.toContain("evalops-private-heavy");
		expect(runsOn).not.toContain("INTERNAL_CONFIRMATION_RUNNER");
		return;
	}

	// Rust PR work uses the configurable owned PR lane
	// (Blacksmith retired 2026-07-20; GitHub-hosted spend is budget-blocked
	// on this private repo, so ubuntu-latest is only for fork PRs above);
	// main confirmation falls back through INTERNAL_CONFIRMATION_RUNNER to
	// evalops-internal.
	expect(runsOn).toContain("PR_RUST_RUNNER");
	expect(runsOn).toContain("PR_CHECKS_RUNNER");
	expect(runsOn).not.toContain("evalops-private-heavy");
	expect(runsOn).not.toContain("BLACKSMITH");
	expect(runsOn).not.toContain("blacksmith");
	expect(runsOn).toContain("INTERNAL_CONFIRMATION_RUNNER");
	expect(runsOn).toContain("evalops-internal");
}

describe("planCiChecks", () => {
	it("runs expensive checks on non-PR events", () => {
		expect(
			planCiChecks({
				eventName: "push",
				changedFiles: ["docs/release-ops.md"],
			}),
		).toMatchObject({ coverage: true, publicMirror: true });
	});

	it("lets full-ci force both expensive checks", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				labels: ["full-ci"],
				changedFiles: ["docs/release-ops.md"],
			}),
		).toMatchObject({
			coverage: true,
			publicMirror: true,
			rustHostedConformance: true,
		});
	});

	it("skips expensive app checks for workflow-only pull requests", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [
					".github/workflows/actionlint.yml",
					".github/workflows/ci.yml",
					".github/workflows/rust.yml",
				],
			}),
		).toMatchObject({
			ciInfrastructureOnly: true,
			codegenUtilityOnly: false,
			coverage: false,
			lightPrChecks: true,
			prChecks: true,
			publicMirror: false,
			rustHostedConformance: false,
		});
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [
					".github/workflows/ci.yml",
					"scripts/plan-ci-checks.mjs",
					"test/scripts/ci-guardrails.test.ts",
				],
			}),
		).toMatchObject({
			ciInfrastructureOnly: true,
			codegenUtilityOnly: false,
			coverage: false,
			lightPrChecks: true,
			prChecks: true,
			publicMirror: true,
			rustHostedConformance: false,
		});
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [
					".github/actions/setup-rust/action.yml",
					"test/scripts/ci-guardrails.test.ts",
				],
			}),
		).toMatchObject({
			ciInfrastructureOnly: true,
			coverage: false,
			lightPrChecks: false,
			prChecks: true,
			publicMirror: true,
			rustHostedConformance: true,
		});
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [
					".github/workflows/rust.yml",
					"packages/tui-rs/src/tools/batch.rs",
				],
			}),
		).toMatchObject({
			ciInfrastructureOnly: false,
			coverage: true,
			prChecks: true,
			rustHostedConformance: true,
		});
	});

	it("keeps workflow unit-test changes on the light proof lane", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [
					".github/workflows/tag-release.yml",
					"test/scripts/ci-guardrails.test.ts",
					"test/workflows/tag-release.test.ts",
				],
			}),
		).toMatchObject({
			ciInfrastructureOnly: false,
			coverage: false,
			lightPrChecks: true,
			proofHarnessOnly: true,
			prChecks: true,
			publicMirror: true,
			rustHostedConformance: false,
		});
	});

	it("skips TS/Nx checks for Rust-only pull requests", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: ["packages/tui-rs/src/safety/path_containment.rs"],
			}),
		).toMatchObject({
			ciInfrastructureOnly: false,
			coverage: false,
			prChecks: false,
			publicMirror: true,
			rustHostedConformance: true,
		});

		expect(
			planCiChecks({
				eventName: "pull_request",
				labels: "run-pr-checks,run-coverage",
				changedFiles: ["packages/tui-rs/src/safety/path_containment.rs"],
			}),
		).toMatchObject({
			coverage: true,
			prChecks: true,
			rustHostedConformance: true,
		});
	});

	it("skips nested docs/readme-only coverage but not root README coverage", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [
					"docs/internal/operator-note.md",
					"docs/release-ops.md",
					"packages/ai/README.md",
				],
			}).coverage,
		).toBe(false);
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: ["README.md"],
			}).coverage,
		).toBe(true);
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: ["examples/README.md"],
			}).coverage,
		).toBe(true);
	});

	it("skips coverage for runtime package metadata and test-only changes", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [
					".github/workflows/ci.yml",
					"CHANGELOG.md",
					"openapi.json",
					"package.json",
					"packages/contracts/package.json",
					"packages/slack-agent/test/tools-status.test.ts",
					"scripts/bundle-runtime-deps.mjs",
					"scripts/check-docker-runtime-workspaces.mjs",
					"scripts/check-packed-bundled-workspaces.mjs",
					"scripts/check-runtime-deps.js",
					"scripts/ci-nx-tests.sh",
					"scripts/install-smoke-utils.js",
					"scripts/plan-nx-test-command.mjs",
					"scripts/release-impact-filter.mjs",
					"scripts/release-readiness.js",
					"scripts/runtime-workspaces.mjs",
					"scripts/summarize-nx-profile.mjs",
					"scripts/validate-public-package-deps.js",
					"scripts/workspace-utils.js",
					"test/scripts/ci-guardrails.test.ts",
				],
			}),
		).toMatchObject({
			ciInfrastructureOnly: false,
			coverage: false,
			lightPrChecks: false,
			proofHarnessOnly: false,
			prChecks: true,
			publicMirror: true,
			rustHostedConformance: false,
		});
	});

	it("routes release helper-only PR checks to the light runner lane", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [
					"docs/protocols/release-surface-conformance.json",
					"docs/protocols/release-surface-conformance.md",
					"scripts/check-package-cutover-readiness.js",
					"scripts/check-release-surface-conformance.mjs",
					"scripts/configure-npm-trusted-publisher.mjs",
					"scripts/deprecate-release.js",
					"scripts/install-smoke-utils.js",
					"scripts/ci-nx-tests.sh",
					"scripts/plan-ci-checks.mjs",
					"scripts/plan-nx-test-command.mjs",
					"scripts/published-replay-evidence-gate.js",
					"scripts/release-impact-filter.mjs",
					"scripts/release-observability-query-contract.js",
					"scripts/release-readiness.js",
					"scripts/smoke-packed-cli.js",
					"scripts/smoke-published-replay-e2e.js",
					"scripts/smoke-registry-install.js",
					"scripts/workspace-utils.js",
					"test/scripts/ci-guardrails.test.ts",
					"test/scripts/deprecate-release.test.ts",
					"test/scripts/release-impact-filter.test.ts",
					"test/scripts/release-observability-query-contract.test.ts",
					"test/scripts/release-surface-conformance.test.ts",
					"test/scripts/workspace-utils.test.ts",
				],
			}),
		).toMatchObject({
			coverage: false,
			lightPrChecks: true,
			prChecks: true,
			publicMirror: true,
			releaseHelperOnly: true,
			rustHostedConformance: false,
		});
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: ["test/scripts/workspace-utils.test.ts"],
			}),
		).toMatchObject({
			coverage: false,
			lightPrChecks: true,
			prChecks: true,
			releaseHelperOnly: true,
			rustHostedConformance: false,
		});
	});

	it("keeps release helper workflow smoke changes off the light runner lane", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [
					".github/workflows/ci.yml",
					"scripts/release-readiness.js",
					"test/scripts/ci-guardrails.test.ts",
				],
			}),
		).toMatchObject({
			coverage: false,
			lightPrChecks: false,
			prChecks: true,
			publicMirror: true,
			releaseHelperOnly: true,
			rustHostedConformance: false,
		});
	});

	it("keeps release helper test and CI plumbing changes on the light lane with mirror validation", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [
					"scripts/ci-nx-tests.sh",
					"scripts/plan-ci-checks.mjs",
					"scripts/plan-nx-test-command.mjs",
					"test/scripts/ci-guardrails.test.ts",
					"test/scripts/deprecate-release.test.ts",
					"test/scripts/smoke-published-replay-e2e.test.ts",
					"test/scripts/workspace-utils.test.ts",
				],
			}),
		).toMatchObject({
			coverage: false,
			lightPrChecks: true,
			prChecks: true,
			publicMirror: true,
			releaseHelperOnly: true,
			rustHostedConformance: false,
		});
	});

	it("keeps release helper test-only changes eligible for public mirror checks", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: ["test/scripts/smoke-published-replay-e2e.test.ts"],
			}),
		).toMatchObject({
			coverage: false,
			lightPrChecks: true,
			prChecks: true,
			publicMirror: true,
			releaseHelperOnly: true,
			rustHostedConformance: false,
		});
	});

	it("keeps mirrored CI guardrail test changes eligible for public mirror checks", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: ["test/scripts/ci-guardrails.test.ts"],
			}),
		).toMatchObject({
			coverage: false,
			lightPrChecks: true,
			prChecks: true,
			publicMirror: true,
			rustHostedConformance: false,
		});
	});

	it("skips coverage for colocated package test-only changes", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [
					"packages/web/src/components/composer-a2a-cockpit-panel.test.ts",
					"packages/slack-agent/src/tools-status.spec.ts",
				],
			}),
		).toMatchObject({
			coverage: false,
			prChecks: true,
		});
	});

	it("routes codegen utility-only PR checks to the light runner lane", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [
					".github/workflows/ci.yml",
					"scripts/codegen-utils.mjs",
					"scripts/plan-ci-checks.mjs",
					"test/scripts/ci-guardrails.test.ts",
					"test/scripts/codegen-utils.test.ts",
				],
			}),
		).toMatchObject({
			codegenUtilityOnly: true,
			coverage: false,
			lightPrChecks: true,
			prChecks: true,
			publicMirror: true,
			rustHostedConformance: false,
		});
	});

	it("skips coverage and Rust conformance for proof-harness-only changes", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [
					"docs/protocols/a2a-fleet-delegation.md",
					"scripts/smoke-maestro-a2a-local-swarm.ts",
				],
			}),
		).toMatchObject({
			ciInfrastructureOnly: false,
			coverage: false,
			lightPrChecks: false,
			proofHarnessOnly: true,
			prChecks: true,
			publicMirror: true,
			rustHostedConformance: false,
		});
	});

	it("skips coverage for VS Code extension-only leaf changes", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [
					"packages/vscode-extension/src/extension.ts",
					"packages/vscode-extension/test/extension.test.ts",
				],
			}),
		).toMatchObject({
			ciInfrastructureOnly: false,
			coverage: false,
			prChecks: true,
			publicMirror: true,
			rustHostedConformance: false,
		});
	});

	it("keeps coverage conservative for shared runtime and verifier surfaces", () => {
		for (const changedPath of [
			"packages/contracts/src/index.ts",
			"src/agent/providers/openai-codex-session.ts",
			"src/telemetry/pricing.ts",
			"scripts/verify-platform-a2a-live-evidence.ts",
		]) {
			expect(
				planCiChecks({
					eventName: "pull_request",
					changedFiles: [changedPath],
				}).coverage,
			).toBe(true);
		}
	});

	it("keeps package manifests out of proof-harness-only skips", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [
					"docs/protocols/a2a-fleet-delegation.md",
					"package.json",
					"scripts/smoke-maestro-a2a-local-swarm.ts",
				],
			}),
		).toMatchObject({
			ciInfrastructureOnly: false,
			coverage: false,
			lightPrChecks: false,
			proofHarnessOnly: false,
			prChecks: true,
			publicMirror: true,
			rustHostedConformance: false,
		});
	});

	it("keeps PR queue and public mirror helper scripts on the guardrail lane", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [
					"scripts/maestro-merge-queue-status.mjs",
					"scripts/pr-latest-head-checks.mjs",
					"scripts/run-prepared-public-mirror-guardrails.mjs",
					"scripts/sync-public-companion-branch.mjs",
					"scripts/update-behind-auto-merge-prs.mjs",
					"test/scripts/ci-guardrails.test.ts",
				],
			}),
		).toMatchObject({
			ciInfrastructureOnly: true,
			coverage: false,
			lightPrChecks: true,
			prChecks: true,
			publicMirror: true,
			rustHostedConformance: false,
		});
	});

	it("runs public mirror checks for mirror config inputs", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [".github/release-mirror-manifest.json"],
			}).publicMirror,
		).toBe(true);
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [".github/public-release-mirror.exclude"],
			}).publicMirror,
		).toBe(true);
	});

	it("skips public mirror for internal-only release operations files", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				changedFiles: [
					".github/workflows/ci.yml",
					"docs/internal/operator-note.md",
					"scripts/run-scenario-replay-gate.mjs",
					"scripts/sync-public-companion-branch.mjs",
					"scripts/update-behind-auto-merge-prs.mjs",
					"scripts/validate-public-package-deps.js",
					"test/scripts/validate-public-package-deps.test.ts",
				],
			}).publicMirror,
		).toBe(false);
	});

	it("lets targeted labels force one expensive check", () => {
		expect(
			planCiChecks({
				eventName: "pull_request",
				labels: "run-coverage",
				changedFiles: ["docs/release-ops.md"],
			}),
		).toMatchObject({ coverage: true, publicMirror: false });
		expect(
			planCiChecks({
				eventName: "pull_request",
				labels: "run-public-mirror",
				changedFiles: ["docs/release-ops.md"],
			}),
		).toMatchObject({ coverage: false, publicMirror: true });
	});
});

describe("ci workflow guardrails", () => {
	it("recognizes public validation workflows by source identity and runner lane", () => {
		const publicWorkflow = {
			jobs: {
				coverage: {
					"runs-on":
						"${{ vars.PUBLIC_PR_VALIDATION_RUNNER || 'ubuntu-latest' }}",
				},
				"pr-checks": {
					"runs-on":
						"${{ vars.PUBLIC_PR_VALIDATION_RUNNER || 'ubuntu-latest' }}",
				},
			},
		} satisfies Workflow;

		const publicTreeIdentity = {
			hasInternalReleaseMirrorManifest: false,
		};

		expect(isPublicValidationWorkflow(publicWorkflow, publicTreeIdentity)).toBe(
			true,
		);
		expect(
			isPublicValidationWorkflow(
				{
					jobs: {
						...publicWorkflow.jobs,
						"public-release-mirror": {},
					},
				},
				publicTreeIdentity,
			),
		).toBe(false);
	});

	it("keeps public validation detection tied to release mirror source identity", () => {
		const publicRunnerWorkflow = {
			jobs: {
				coverage: {
					"runs-on":
						"${{ vars.PUBLIC_PR_VALIDATION_RUNNER || 'ubuntu-latest' }}",
				},
				"pr-checks": {
					"runs-on":
						"${{ vars.PUBLIC_PR_VALIDATION_RUNNER || 'ubuntu-latest' }}",
				},
			},
		} satisfies Workflow;
		expect(
			isPublicValidationWorkflow(publicRunnerWorkflow, {
				hasInternalReleaseMirrorManifest: true,
			}),
		).toBe(false);
	});

	it("runs shell CI guardrails for workflow file changes", () => {
		const script = readFileSync(
			new URL("../../scripts/ci-nx-tests.sh", import.meta.url),
			{ encoding: "utf8" },
		);
		const triggerPattern = script.match(
			/run_ci_guardrail_tests\(\) \{[\s\S]*?changed_files_match '([^']+)'/,
		)?.[1];

		expect(triggerPattern).toBeDefined();
		const regex = new RegExp(triggerPattern ?? "");
		expect(regex.test(".github/workflows/ci.yml")).toBe(true);
		expect(regex.test("scripts/ci-nx-tests.sh")).toBe(true);
		expect(regex.test("scripts/check-smoke-scripts.mjs")).toBe(true);
		expect(regex.test("scripts/summarize-nx-profile.mjs")).toBe(true);
	});

	it("runs selected infrastructure tests directly instead of the root Nx target", () => {
		const script = readFileSync(
			new URL("../../scripts/ci-nx-tests.sh", import.meta.url),
			{ encoding: "utf8" },
		);

		expect(script).toContain("direct_vitest_tests_only");
		expect(script).toContain(
			"Selected infrastructure test files are handled directly by Vitest.",
		);
		expect(script).toContain("node ./scripts/run-vitest.js --run");
		expect(script).toContain("test/scripts/deprecate-release.test.ts");
		expect(script).toContain("test/scripts/release-impact-filter.test.ts");
		expect(script).toContain(
			"test/scripts/release-surface-conformance.test.ts",
		);
		expect(script).toContain("test/scripts/smoke-published-replay-e2e.test.ts");
		expect(script).toContain("test/scripts/workspace-utils.test.ts");
		expect(script).toContain("test/workflows/*.test.ts");
		expect(script).toContain("rg -q --regexp");
		expect(script).toContain(
			"Skipping Nx profile summary for direct Vitest run.",
		);
	});

	it("bounds the optional Docker availability probe used by the full suite", () => {
		const source = readFileSync(
			new URL("../slack-agent/sandbox.test.ts", import.meta.url),
			{ encoding: "utf8" },
		);
		const dockerProbe =
			source.match(/spawnSync\("docker", \["info"\], \{[\s\S]*?\}\);/)?.[0] ??
			"";

		expect(dockerProbe).not.toBe("");
		expect(dockerProbe).toContain("timeout: 5_000");
		expect(dockerProbe).toContain('killSignal: "SIGKILL"');
	});

	it("builds dist before the runtime dependency validator", () => {
		const script = readFileSync(
			new URL("../../scripts/ci-nx-tests.sh", import.meta.url),
			{ encoding: "utf8" },
		);
		const runtimeValidatorBody =
			script.match(
				/run_runtime_package_validators\(\) \{([\s\S]*?)\n\}/,
			)?.[1] ?? "";

		expect(runtimeValidatorBody).not.toBe("");
		expect(runtimeValidatorBody).toContain("--runtime-package-validators");
		expect(runtimeValidatorBody.indexOf("npm run build")).toBeLessThan(
			runtimeValidatorBody.indexOf("node scripts/check-runtime-deps.js"),
		);
	});

	it("filters deleted smoke scripts before static checks", () => {
		const script = readFileSync(
			new URL("../../scripts/ci-nx-tests.sh", import.meta.url),
			{ encoding: "utf8" },
		);
		const smokeStaticChecksBody =
			script.match(
				/run_smoke_script_static_checks\(\) \{([\s\S]*?)\n\}/,
			)?.[1] ?? "";

		expect(smokeStaticChecksBody).not.toBe("");
		expect(smokeStaticChecksBody).toContain('[[ -f "$file" ]] || continue');
		expect(
			smokeStaticChecksBody.indexOf('[[ -f "$file" ]] || continue'),
		).toBeLessThan(smokeStaticChecksBody.indexOf('smoke_scripts+=("$file")'));
	});

	it("hard-bounds long-running Nx and coverage phases", () => {
		const workflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;
		const script = readFileSync(
			new URL("../../scripts/ci-nx-tests.sh", import.meta.url),
			{ encoding: "utf8" },
		);
		const prCheckTimeouts = new Map(
			(workflow.jobs?.["pr-checks"]?.steps ?? []).map((step) => [
				step.name,
				step["timeout-minutes"],
			]),
		);
		const coverageTimeouts = new Map(
			(workflow.jobs?.coverage?.steps ?? []).map((step) => [
				step.name,
				step["timeout-minutes"],
			]),
		);

		expect(prCheckTimeouts.get("Test (Nx affected)")).toBe(60);
		if (!isPublicValidationWorkflow(workflow)) {
			expect(prCheckTimeouts.get("Release helper package smoke")).toBe(15);
		}
		expect(workflow.jobs?.coverage?.["timeout-minutes"]).toBe(75);
		expect(coverageTimeouts.get("Run tests with coverage")).toBe(60);
		expect(script).toContain("NX_TEST_POST_SUCCESS_IDLE_FINAL_PATTERN");
		expect(script).toContain("--success-idle-final-pattern");
		expect(script).toContain(
			'[[ "${cmd[0]}" == "npx" && "${cmd[1]}" == "nx" ]]',
		);
	});

	it("runs root lint as a first-class CI job", () => {
		const workflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;
		if (isPublicValidationWorkflow(workflow)) {
			expect(workflow.jobs?.lint).toBeUndefined();
			return;
		}
		const lintJob = workflow.jobs?.lint;
		const lintStep = lintJob?.steps?.find((step) => step.name === "Lint");

		expect(lintJob).toBeDefined();
		expect(lintJob?.needs).toBe("changes");
		expect(lintStep?.run).toBe("npx nx run maestro:lint");
	});

	it("uploads machine-readable Nx attempt summaries with test logs", () => {
		const workflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;
		const prCheckSteps = workflow.jobs?.["pr-checks"]?.steps ?? [];
		const uploadLogsStep = prCheckSteps.find(
			(step) => step.name === "Upload Nx test logs (if any)",
		);
		const script = readFileSync(
			new URL("../../scripts/ci-nx-tests.sh", import.meta.url),
			{ encoding: "utf8" },
		);

		expect(script).toContain("--summary-json");
		expect(script).toContain("nx-tests-attempt-${attempt}.json");
		expect(script).toContain("#### Attempt summaries");
		if (isPublicValidationWorkflow(workflow)) {
			expect(String(uploadLogsStep?.if ?? "")).toContain(
				"nx-tests-attempt-*.log",
			);
			expect(uploadLogsStep?.with?.path).toContain("nx-tests-attempt-*.log");
			return;
		}
		expect(String(uploadLogsStep?.if ?? "")).toContain(
			"nx-tests-attempt-*.json",
		);
		expect(uploadLogsStep?.uses).toBe("./.github/actions/gcs-artifacts");
		expect(uploadLogsStep?.with).toMatchObject({
			mode: "upload",
			"if-missing": "ignore",
			prefix:
				"maestro-internal/ci/${{ github.run_id }}/${{ github.run_attempt }}/nx-tests-logs",
		});
		expect(uploadLogsStep?.with?.["workload-identity-provider"]).toContain(
			"GCP_WORKLOAD_IDENTITY_PROVIDER",
		);
		expect(String(uploadLogsStep?.with?.paths ?? "")).toContain(
			"nx-tests-attempt-*.json",
		);
	});

	it("routes expensive pull-request jobs to the intended runner lanes", () => {
		const workflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;
		const prChecksRunsOn = String(
			workflow.jobs?.["pr-checks"]?.["runs-on"] ?? "",
		);
		const coverageRunsOn = String(workflow.jobs?.coverage?.["runs-on"] ?? "");

		if (isPublicValidationWorkflow(workflow)) {
			expect(prChecksRunsOn).toContain("ubuntu-latest");
			expect(prChecksRunsOn).toContain("PUBLIC_PR_VALIDATION_RUNNER");
			expect(coverageRunsOn).toContain("ubuntu-latest");
			expect(coverageRunsOn).toContain("PUBLIC_PR_VALIDATION_RUNNER");
			return;
		}

		expect(prChecksRunsOn).toContain("ubuntu-latest");
		expect(prChecksRunsOn).toContain("light_pr_checks");
		// Light PR lane: PR_CHECKS_RUNNER -> evalops-internal
		// Heavy PR lane: evalops-private-heavy
		// (Blacksmith retired 2026-07-20; GitHub-hosted Actions spend is
		// budget-blocked on this private repo, so ubuntu-latest above is only
		// reachable for fork PRs, which must never land on a self-hosted
		// runner regardless of budget.)
		expect(prChecksRunsOn).toContain("PR_CHECKS_RUNNER");
		expect(prChecksRunsOn).not.toContain("BLACKSMITH");
		expect(prChecksRunsOn).not.toContain("blacksmith");
		expect(prChecksRunsOn).toContain("evalops-private-heavy");
		expect(prChecksRunsOn).toContain("INTERNAL_CONFIRMATION_RUNNER");
		expect(prChecksRunsOn).toContain("evalops-internal");
		expect(coverageRunsOn).toContain("ubuntu-latest");
		expect(coverageRunsOn).toContain("PR_RUST_RUNNER");
		expect(coverageRunsOn).toContain("PR_CHECKS_RUNNER");
		expect(coverageRunsOn).not.toContain("BLACKSMITH");
		expect(coverageRunsOn).not.toContain("blacksmith");
		expect(coverageRunsOn).not.toContain("evalops-private-heavy");
		expect(coverageRunsOn).toContain("INTERNAL_CONFIRMATION_RUNNER");
		expect(coverageRunsOn).toContain("evalops-internal");
	});

	it("runs workflow footgun guardrails in the CI infrastructure smoke lane", () => {
		const workflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;
		const prCheckSteps = workflow.jobs?.["pr-checks"]?.steps ?? [];
		const setupBunStep = prCheckSteps.find(
			(step) => step.uses === "./.github/actions/setup-bun-nx",
		);
		const smokeStep = prCheckSteps.find(
			(step) => step.name === "Release readiness script smoke",
		);

		expect(smokeStep?.if).toContain("ci_infrastructure_only == 'true'");
		expect(setupBunStep).toBeDefined();
		expect(String(setupBunStep?.if ?? "")).not.toContain(
			"ci_infrastructure_only != 'true'",
		);
		expect(smokeStep?.run).toContain(
			"node --check scripts/check-workflow-footguns.mjs",
		);
		expect(smokeStep?.run).toContain("npm run check:workflow-footguns");
		expect(smokeStep?.run).toContain(
			"node ./scripts/run-vitest.js --run test/scripts/workflow-footguns.test.ts",
		);
	});

	it("uses targeted release helper package smoke instead of duplicate release readiness", () => {
		const workflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;
		const changesOutputs = workflow.jobs?.changes?.outputs ?? {};
		const prCheckSteps = workflow.jobs?.["pr-checks"]?.steps ?? [];
		const helperSmokeStep = prCheckSteps.find(
			(step) => step.name === "Release helper package smoke",
		);
		const releaseReadinessStep = prCheckSteps.find(
			(step) => step.name === "Release readiness (CI mode)",
		);

		if (isPublicValidationWorkflow(workflow)) {
			expect(changesOutputs).not.toHaveProperty("release_helper_only");
			expect(helperSmokeStep).toBeUndefined();
			expect(releaseReadinessStep?.if).toContain("proof_harness_only");
			return;
		}

		expect(changesOutputs).toHaveProperty("release_helper_only");
		expect(helperSmokeStep?.if).toContain("release_helper_only == 'true'");
		expect(helperSmokeStep?.["timeout-minutes"]).toBe(15);
		expect(helperSmokeStep?.run).toContain(
			"node --check scripts/release-readiness.js",
		);
		expect(helperSmokeStep?.run).toContain(
			"node --check scripts/release-observability-query-contract.js",
		);
		expect(helperSmokeStep?.run).toContain(
			"node --check scripts/smoke-published-replay-e2e.js",
		);
		expect(helperSmokeStep?.run).toContain(
			"node --check scripts/smoke-registry-install.js",
		);
		expect(helperSmokeStep?.run).toContain(
			"node --check scripts/published-replay-evidence-gate.js",
		);
		expect(helperSmokeStep?.run).toContain(
			"node --check scripts/verify-published-replay-evidence.js",
		);
		expect(helperSmokeStep?.run).toContain(
			"node --check scripts/deprecate-release.js",
		);
		expect(helperSmokeStep?.run).toContain(
			"node --check scripts/release-impact-filter.mjs",
		);
		expect(helperSmokeStep?.run).toContain(
			"node --check scripts/configure-npm-trusted-publisher.mjs",
		);
		expect(helperSmokeStep?.run).toContain(
			"node --check scripts/check-package-cutover-readiness.js",
		);
		expect(helperSmokeStep?.run).toContain(
			"node --check scripts/check-release-surface-conformance.mjs",
		);
		expect(helperSmokeStep?.run).toContain(
			"test/scripts/release-observability-query-contract.test.ts",
		);
		expect(helperSmokeStep?.run).toContain(
			"test/scripts/release-surface-conformance.test.ts",
		);
		expect(helperSmokeStep?.run).toContain(
			"test/scripts/deprecate-release.test.ts",
		);
		expect(helperSmokeStep?.run).toContain(
			"test/scripts/verify-published-replay-evidence.test.ts",
		);
		expect(helperSmokeStep?.run).toContain(
			"MAESTRO_SKIP_INSTALL_AUDIT=1 MAESTRO_SKIP_BUN_INSTALL_SMOKE=1",
		);
		expect(helperSmokeStep?.run).toContain(
			"node scripts/release-readiness.js pack-smoke",
		);
		expect(helperSmokeStep?.run).toContain("npm run build");
		const trustedPublisherScript = readFileSync(
			new URL(
				"../../scripts/configure-npm-trusted-publisher.mjs",
				import.meta.url,
			),
			{ encoding: "utf8" },
		);
		expect(trustedPublisherScript).toContain("getNpxCommand");
		expect(trustedPublisherScript).not.toContain('spawnSync("npx"');
		expect(trustedPublisherScript).toContain('"--allow-publish"');
		expect(trustedPublisherScript).toContain('"--allow-stage-publish"');
		expect(releaseReadinessStep?.if).toContain("release_helper_only != 'true'");
	});

	it("formats version-generated package manifests before release checks", () => {
		const script = readFileSync(
			new URL("../../scripts/version.js", import.meta.url),
			{ encoding: "utf8" },
		);
		const formatCall = "formatPackageJsonFiles([";

		expect(script).toContain("execFileSync");
		expect(script).toContain('"bunx"');
		expect(script).toContain('"biome"');
		expect(script).toContain('"format"');
		expect(script).toContain('"--write"');
		expect(script).toContain("quoteWindowsShellArg");
		expect(script).toContain('process.platform === "win32"');
		expect(script).not.toContain('shell: process.platform === "win32"');
		expect(script).toContain(formatCall);
		expect(script.indexOf(formatCall)).toBeGreaterThan(
			script.indexOf("writePackageJson(pkg.path, pkg.data);"),
		);
		expect(script.indexOf(formatCall)).toBeLessThan(
			script.indexOf("updateChangelog(newVersion"),
		);
	});

	it("keeps public registry smoke install helper exports", async () => {
		const helpers = (await import(
			"../../scripts/install-smoke-utils.js"
		)) as Record<string, unknown>;

		for (const exportName of [
			"assertInstallablePackageMetadata",
			"getBunCommand",
			"getNpmCommand",
			"getNpxCommand",
			"readInstalledPackageJson",
			"runBunRuntimeCliSmoke",
			"runBunxCliSmoke",
			"runInstalledCliSmoke",
			"runInstalledPackageAudit",
		]) {
			expect(helpers[exportName]).toEqual(expect.any(Function));
		}
	});

	it("keeps trusted-publisher setup on platform-aware npx resolution", () => {
		const script = readFileSync(
			new URL(
				"../../scripts/configure-npm-trusted-publisher.mjs",
				import.meta.url,
			),
			{ encoding: "utf8" },
		);

		expect(script).toContain("getNpxCommand");
		expect(script).toContain("const npxCommand = getNpxCommand();");
		expect(script).toContain("spawnSync(npxCommand, npmArgs");
		expect(script).not.toContain('spawnSync("npx"');
	});

	it("keeps GitHub App token actions on the Node24-compatible pin", () => {
		const workflowsDir = new URL("../../.github/workflows/", import.meta.url);
		const workflowFiles = readdirSync(workflowsDir)
			.filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
			.sort();
		const legacyPins: string[] = [];

		for (const file of workflowFiles) {
			const workflowText = readFileSync(new URL(file, workflowsDir), {
				encoding: "utf8",
			});
			const matches = [
				...workflowText.matchAll(/actions\/create-github-app-token@[^\s"']+/g),
			].map((match) => match[0]);
			for (const actionRef of matches) {
				if (actionRef !== node24CreateGitHubAppTokenPin) {
					legacyPins.push(`${file}: ${actionRef}`);
				}
			}
		}

		expect(legacyPins).toEqual([]);
	});

	it("authenticates deprecate-release through the effective npm config", () => {
		const workflowPath = new URL(
			"../../.github/workflows/deprecate-release.yml",
			import.meta.url,
		);
		if (!existsSync(workflowPath)) {
			return;
		}
		const workflowText = readFileSync(workflowPath, { encoding: "utf8" });

		expect(workflowText).toContain(
			'npm_userconfig="${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}"',
		);
		expect(workflowText).toContain('> "$npm_userconfig"');
		expect(workflowText).toContain("npm whoami");
		expect(workflowText).toContain(
			"NPM_TOKEN is present but npm whoami failed",
		);
	});

	it("keeps the deprecate-release default message package-aware and versionless", () => {
		const workflowPath = new URL(
			"../../.github/workflows/deprecate-release.yml",
			import.meta.url,
		);
		if (!existsSync(workflowPath)) {
			return;
		}
		const workflow = parse(
			readFileSync(workflowPath, { encoding: "utf8" }),
		) as {
			on?: {
				workflow_dispatch?: {
					inputs?: {
						message?: {
							default?: string;
						};
					};
				};
			};
		};
		const defaultMessage =
			workflow.on?.workflow_dispatch?.inputs?.message?.default ?? "";

		expect(defaultMessage).toBe("");
	});

	it("keeps packed CLI smoke aligned with registry install validation", () => {
		const script = readFileSync(
			new URL("../../scripts/smoke-packed-cli.js", import.meta.url),
			{ encoding: "utf8" },
		);

		expect(script).toContain("assertInstallablePackageMetadata");
		expect(script).toContain("runInstalledCliSmoke");
		expect(script).toContain("runBunxCliSmoke");
		expect(script).toContain("runBunRuntimeCliSmoke");
		expect(script).toContain("getBunCommand");
		expect(script).toContain("runNpmInstallSmoke();");
		expect(script).toContain("runBunInstallSmoke();");

		const smokeUtils = readFileSync(
			new URL("../../scripts/install-smoke-utils.js", import.meta.url),
			{ encoding: "utf8" },
		);
		expect(smokeUtils).toContain('["openai", "status"]');
		expect(smokeUtils).toContain("buildNativeInstallSmokeEnv");
		expect(smokeUtils).toContain("delete env.MAESTRO_TUI_BIN");
		expect(smokeUtils).toContain('["/usr/bin", "/bin"]');
		expect(smokeUtils).toContain("MAESTRO_HOME:");
		expect(script).toContain("MAESTRO_REQUIRE_PACKAGED_TUI");
	});

	it("builds every packaged Rust TUI target on an owned or (gap-flagged) GitHub-hosted runner", () => {
		const workflowPath = new URL(
			"../../.github/workflows/release.yml",
			import.meta.url,
		);
		const workflow = readFileSync(workflowPath, { encoding: "utf8" });
		const parsedWorkflow = parse(workflow) as Workflow;
		if (
			isPublicValidationWorkflow(parsedWorkflow) &&
			!workflow.includes("release-tui-binaries:")
		) {
			// The public-owned publishing workflow lands in its downstream PR after
			// the internal source change; mirror validation must permit that ordering.
			return;
		}

		// linux-x64 has an owned Hetzner equivalent, so it must not sit on
		// GitHub-hosted spend. macos-15 and ubuntu-24.04-arm are a known,
		// explicitly flagged gap (no owned macOS or arm64 runner exists yet)
		// and stay GitHub-hosted -- and therefore budget-blocked -- until an
		// owned runner is provisioned or the Actions budget resets.
		for (const runner of [
			"macos-15",
			"evalops-private-heavy",
			"ubuntu-24.04-arm",
		]) {
			expect(workflow).toContain(runner);
		}
		expect(workflow).not.toContain("blacksmith");
		expect(workflow).not.toContain("Blacksmith");
		expect(workflow).toContain("release-tui-binaries:");
		expect(workflow).toContain(
			"build --release --locked --bin maestro-tui --target",
		);
		expect(workflow).toContain('strip -x "$dest"');
		expect(workflow).toContain('strip "$dest"');
		// Standalone bun binary smoke must resolve native maestro-tui.
		expect(workflow).toContain(
			'export MAESTRO_TUI_BIN="$PWD/packages/tui-rs/target/release/maestro-tui"',
		);
		expect(workflow).toContain("smoke-release-binary.mjs");
		// Isolated rust for smoke must not precede build:all (breaks rustfmt contracts).
		const releaseBinariesSection = workflow.slice(
			workflow.indexOf("release-binaries:"),
			workflow.indexOf("\n  notify:"),
		);
		const buildAllAt = releaseBinariesSection.indexOf("npm run build:all");
		const setupRustAt = releaseBinariesSection.indexOf(
			"./.github/actions/setup-rust",
		);
		expect(buildAllAt).toBeGreaterThan(-1);
		expect(setupRustAt).toBeGreaterThan(buildAllAt);
		expect(releaseBinariesSection).toContain("components: rustfmt");
	});

	it("runs published replay E2E for npm and Bun registry installs", () => {
		const script = readFileSync(
			new URL("../../scripts/smoke-registry-install.js", import.meta.url),
			{ encoding: "utf8" },
		);

		const replayCalls = [...script.matchAll(/runPublishedReplayE2E\(/g)];
		expect(replayCalls).toHaveLength(2);
		expect(script.indexOf("await runPublishedReplayE2E({")).toBeGreaterThan(
			script.indexOf('npmCommand, ["install", packageSpec]'),
		);
		expect(script.lastIndexOf("await runPublishedReplayE2E({")).toBeGreaterThan(
			script.indexOf('bunCommand, ["add", packageSpec]'),
		);
		expect(script).toContain(
			"const installMetadata = assertInstalledMetadata(",
		);
		expect(script).toContain("installMetadata,");
		expect(script).toContain(
			"const bunInstallMetadata = assertInstalledMetadata(",
		);
		expect(script).toContain("runBunxCliSmoke");
		expect(script).toContain("runBunRuntimeCliSmoke");
		expect(script).toContain("installMetadata: bunInstallMetadata");
		expect(script).toContain("validatePublishedReplayEvidenceSet");
		expect(script).toContain('"published-replay-evidence"');
		expect(script).toContain("Bun registry install smoke is release-blocking");
		expect(script).toContain("MAESTRO_ALLOW_REGISTRY_BUN_INSTALL_SMOKE_SKIP");
		expect(script).toContain(
			'validatePublishedReplayEvidenceOutputs(["npm"]);',
		);
		expect(script).toContain(
			'validatePublishedReplayEvidenceOutputs(["npm", "bun"]);',
		);
	});

	it("blocks tag-release when an unpublished package version tag points at another commit", () => {
		const action = parse(
			readFileSync(
				new URL(
					"../../.github/actions/release-context/action.yml",
					import.meta.url,
				),
				{ encoding: "utf8" },
			),
		) as {
			outputs?: Record<string, unknown>;
			runs?: { steps?: WorkflowStep[] };
		};
		const workflow = parse(
			readFileSync(
				new URL("../../.github/workflows/tag-release.yml", import.meta.url),
				{ encoding: "utf8" },
			),
		) as Workflow;
		const releaseImpactFilter = readFileSync(
			new URL("../../scripts/release-impact-filter.mjs", import.meta.url),
			{ encoding: "utf8" },
		);
		const contextStep = action.runs?.steps?.find(
			(step) => step.id === "context",
		);
		const steps = workflow.jobs?.["tag-current-version"]?.steps ?? [];
		const mismatchGuard = steps.find(
			(step) => step.name === "Require version bump for existing release tag",
		);

		expect(action.outputs).toHaveProperty("tag_matches_head");
		expect(action.outputs).toHaveProperty("package_changed_since_tag");
		expect(contextStep?.run).toContain('["rev-parse", "HEAD"]');
		expect(contextStep?.run).toContain("^{commit}");
		expect(contextStep?.run).toContain("scripts/release-impact-filter.mjs");
		expect(contextStep?.run).toContain("packageChangedSinceReleaseTag");
		expect(releaseImpactFilter).toContain('"diff", "--name-only"');
		expect(releaseImpactFilter).toContain('path.startsWith("src/")');
		expect(releaseImpactFilter).toContain('path.startsWith("packages/")');
		expect(releaseImpactFilter).toContain('path.startsWith("proto/")');
		expect(releaseImpactFilter).toContain('path.startsWith("types/")');
		expect(releaseImpactFilter).toContain('"tsconfig.base.json"');
		expect(releaseImpactFilter).toContain('"scripts/codegen-utils.mjs"');
		expect(releaseImpactFilter).toContain('"scripts/runtime-workspaces.mjs"');
		expect(releaseImpactFilter).toContain('"scripts/workspace-utils.js"');
		expect(mismatchGuard?.if).toContain(
			"github.repository == 'evalops/maestro'",
		);
		expect(mismatchGuard?.if).toContain(
			"steps.registry-release.outputs.published != 'true'",
		);
		expect(mismatchGuard?.if).toContain("steps.release.outputs.tag_exists");
		expect(mismatchGuard?.if).toContain(
			"steps.release.outputs.tag_matches_head != 'true'",
		);
		expect(mismatchGuard?.if).toContain(
			"steps.release.outputs.package_changed_since_tag == 'true'",
		);
		expect(mismatchGuard?.run).toContain("package.json version");
		expect(mismatchGuard?.run).toContain(
			"already has a semver tag at another commit",
		);
	});

	it("keeps published replay canaries portable on hosted Linux", () => {
		const script = readFileSync(
			new URL("../../scripts/smoke-published-replay-e2e.js", import.meta.url),
			{ encoding: "utf8" },
		);
		const releaseWorkflow = parse(
			readFileSync(
				new URL("../../.github/workflows/release.yml", import.meta.url),
				{ encoding: "utf8" },
			),
		) as Workflow;
		const canarySteps =
			releaseWorkflow.jobs?.["post-publish-canary"]?.steps ?? [];
		const canaryIndex = canarySteps.findIndex(
			(step) => step.name === "Verify published package from npm",
		);
		const canaryStep = canarySteps[canaryIndex];
		const evidenceStep = releaseWorkflow.jobs?.[
			"post-publish-canary"
		]?.steps?.find(
			(step) => step.name === "Validate published replay evidence",
		);
		const verifyWorkflowPath = new URL(
			"../../.github/workflows/verify-published-package.yml",
			import.meta.url,
		);
		const hasPublicVerifyWorkflow = existsSync(verifyWorkflowPath);

		const sandboxArgs = [
			...script.matchAll(/"--sandbox",\s*replaySandboxMode/g),
		];
		expect(script).toContain("MAESTRO_PUBLISHED_REPLAY_SANDBOX_MODE");
		expect(script).toContain("Invalid MAESTRO_PUBLISHED_REPLAY_SANDBOX_MODE");
		expect(script).toMatch(
			/process\.env\.MAESTRO_PUBLISHED_REPLAY_SANDBOX_MODE\?\.trim\(\)\s*\|\|\s*"workspace-write"/,
		);
		expect(script).toContain('"local"');
		expect(script).toContain("replaySandboxModes");
		expect(script).toContain("replaySandboxMode");
		expect(sandboxArgs.length).toBeGreaterThanOrEqual(2);
		expect(script).not.toMatch(/"--sandbox",\s*"workspace-write"/);
		if (isPublicValidationWorkflow(releaseWorkflow)) {
			expect(canaryIndex).toBeGreaterThanOrEqual(0);
			expectRegistryInstallSmokeIsReleaseBlocking(
				canaryStep,
				[
					releaseWorkflow.env,
					releaseWorkflow.jobs?.["post-publish-canary"]?.env,
				],
				{
					containingJob: releaseWorkflow.jobs?.["post-publish-canary"],
					precedingSteps: canarySteps.slice(0, canaryIndex),
				},
			);
			expect(canaryStep?.run).toBe("node scripts/smoke-registry-install.js");
			expect(canaryStep?.env).toMatchObject({
				MAESTRO_INSTALL_AUDIT_LEVEL: "critical",
				MAESTRO_PUBLISHED_REPLAY_SANDBOX_MODE: "local",
				MAESTRO_REGISTRY_POLL_ATTEMPTS: "120",
				MAESTRO_REGISTRY_POLL_DELAY_MS: "5000",
				MAESTRO_REGISTRY_SMOKE_EVIDENCE_DIR: "published-replay-evidence",
			});
			expect(evidenceStep?.run).toBe(
				"node scripts/verify-published-replay-evidence.js --evidence-dir published-replay-evidence",
			);
			expect(hasPublicVerifyWorkflow).toBe(true);
			const verifyWorkflow = parse(
				readFileSync(verifyWorkflowPath, { encoding: "utf8" }),
			) as Workflow;
			const verifySteps = verifyWorkflow.jobs?.verify?.steps ?? [];
			const verifyIndex = verifySteps.findIndex(
				(step) => step.name === "Verify published package from npm",
			);
			const verifyStep = verifySteps[verifyIndex];
			expect(verifyIndex).toBeGreaterThanOrEqual(0);
			expectRegistryInstallSmokeIsReleaseBlocking(
				verifyStep,
				[verifyWorkflow.env, verifyWorkflow.jobs?.verify?.env],
				{
					containingJob: verifyWorkflow.jobs?.verify,
					precedingSteps: verifySteps.slice(0, verifyIndex),
				},
			);
			expect(verifyStep?.run).toContain(
				"node scripts/smoke-registry-install.js",
			);
			expect(verifyStep?.env).toMatchObject({
				MAESTRO_INSTALL_AUDIT_LEVEL: "critical",
				MAESTRO_PUBLISHED_REPLAY_SANDBOX_MODE: "local",
				MAESTRO_REGISTRY_POLL_ATTEMPTS: "120",
				MAESTRO_REGISTRY_POLL_DELAY_MS: "5000",
				MAESTRO_REGISTRY_SMOKE_EVIDENCE_DIR: "published-replay-evidence",
			});
		} else {
			expect(canaryStep).toBeUndefined();
			expect(hasPublicVerifyWorkflow).toBe(false);
		}
	});

	it("authenticates Hopper release metadata sync before GitHub CLI calls", () => {
		const workflow = parse(
			readFileSync(
				new URL("../../.github/workflows/release.yml", import.meta.url),
				{ encoding: "utf8" },
			),
		) as Workflow;
		const hopperStep = workflow.jobs?.publish?.steps?.find(
			(step) => step.name === "Sync Hopper version metadata",
		);
		const run = hopperStep?.run ?? "";

		expect(hopperStep).toBeDefined();
		expect(run).toContain('export GH_TOKEN="$HOPPER_PUSH_TOKEN"');
		expect(run.indexOf('export GH_TOKEN="$HOPPER_PUSH_TOKEN"')).toBeLessThan(
			run.indexOf("gh api user"),
		);
		expect(run).not.toContain("gh auth status");
		expect(run).not.toContain("gh auth setup-git");
		expect(run).not.toContain("gh auth refresh");
	});

	it("publishes release version metadata to GCS through workload identity", () => {
		const workflow = parse(
			readFileSync(
				new URL("../../.github/workflows/release.yml", import.meta.url),
				{ encoding: "utf8" },
			),
		) as Workflow;
		const canaryJob = workflow.jobs?.["post-publish-canary"];
		const steps = canaryJob?.steps ?? [];
		const validateIndex = steps.findIndex(
			(step) => step.name === "Validate published replay evidence",
		);
		const metadataIndex = steps.findIndex(
			(step) => step.name === "Generate version metadata",
		);
		const authIndex = steps.findIndex(
			(step) =>
				step.name === "Authenticate to Google Cloud for release metadata",
		);
		const authStep = steps.find(
			(step) =>
				step.name === "Authenticate to Google Cloud for release metadata",
		);
		const gcsIndex = steps.findIndex(
			(step) => step.name === "Sync GCS version metadata",
		);
		const gcsStep = steps[gcsIndex];
		const run = gcsStep?.run ?? "";

		if (!isPublicValidationWorkflow(workflow)) {
			expect(canaryJob).toBeUndefined();
			return;
		}

		expect(canaryJob).toBeDefined();
		expect(canaryJob?.needs).toContain("publish");
		expect(canaryJob?.permissions?.["id-token"]).toBe("write");
		expect(validateIndex).toBeGreaterThan(-1);
		expect(metadataIndex).toBeGreaterThan(validateIndex);
		expect(authIndex).toBeGreaterThan(metadataIndex);
		expect(gcsIndex).toBeGreaterThan(metadataIndex);
		expect(gcsIndex).toBeGreaterThan(authIndex);
		expect(authStep).toBeDefined();
		expect(authStep?.uses).toContain("google-github-actions/auth@");
		expect(gcsStep).toBeDefined();
		expect(gcsStep?.if).toContain(
			"MAESTRO_RELEASE_GCP_WORKLOAD_IDENTITY_PROVIDER",
		);
		expect(run).toContain("gcloud storage cp");
		expect(run).toContain("dist/version.json");
		expect(run).toContain("/version.json");
	});

	it("loads dotenv configuration before startup refresh", () => {
		const source = readFileSync(new URL("../../src/cli.ts", import.meta.url), {
			encoding: "utf8",
		});
		const loadEnvImportIndex = source.indexOf('"./load-env.js"');
		const loadEnvIndex = source.indexOf(
			"loadAndFinalizeEnv()",
			loadEnvImportIndex,
		);
		const refreshIndex = source.indexOf(
			"await refreshInstalledCliOnStartup(args, loadedEnvKeys)",
		);

		expect(loadEnvImportIndex).toBeGreaterThan(-1);
		expect(loadEnvIndex).toBeGreaterThan(loadEnvImportIndex);
		expect(refreshIndex).toBeGreaterThan(loadEnvIndex);
	});

	it("keeps packed CLI smoke enabled independently of package-lock management", () => {
		const script = readFileSync(
			new URL("../../scripts/release-readiness.js", import.meta.url),
			{ encoding: "utf8" },
		);
		const ciChecksIndex = script.indexOf("function runCiChecks()");
		const releaseChecksIndex = script.indexOf("function runReleaseChecks()");

		expect(script).not.toContain(
			"Skipping packed CLI smoke test (package is not npm-installable from a tarball in this repo)",
		);
		expect(script.indexOf("runPackSmoke();", ciChecksIndex)).toBeGreaterThan(
			ciChecksIndex,
		);
		expect(
			script.indexOf("runPackSmoke();", releaseChecksIndex),
		).toBeGreaterThan(releaseChecksIndex);
		expect(script).toContain("MAESTRO_INSTALL_AUDIT_LEVEL");
		expect(script).toContain(
			'process.env.MAESTRO_INSTALL_AUDIT_LEVEL ?? "critical"',
		);
		expect(script).toContain("removeStandaloneBinaryArtifacts();");
		expect(script).toContain("function ensurePackedCliArtifacts()");
		expect(script).toContain("Building package before packed CLI smoke");
		expect(script.indexOf("ensurePackedCliArtifacts();")).toBeGreaterThan(
			script.indexOf("removeStandaloneBinaryArtifacts();"),
		);
		expect(script).toContain('case "pack-smoke":');
	});

	it("records and uploads Nx timing data", () => {
		const script = readFileSync(
			new URL("../../scripts/ci-nx-tests.sh", import.meta.url),
			{ encoding: "utf8" },
		);
		const workflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;
		const uploadStep = workflow.jobs?.["pr-checks"]?.steps?.find(
			(step) => step.name === "Upload CI timing data (if any)",
		);

		expect(script).toContain(
			'ci_timing_file="${CI_TIMING_FILE:-ci-timing.jsonl}"',
		);
		expect(script).toContain('--timing-file "$ci_timing_file"');
		expect(script).toContain("#### CI timings");
		if (isPreparedPublicMirror) {
			expect(uploadStep?.uses).toContain("actions/upload-artifact@");
			expect(uploadStep?.with).toMatchObject({
				path: "ci-timing.jsonl",
				"retention-days": 7,
			});
		} else {
			expect(uploadStep?.uses).toBe("./.github/actions/gcs-artifacts");
			expect(uploadStep?.with).toMatchObject({
				mode: "upload",
				"if-missing": "ignore",
				prefix:
					"maestro-internal/ci/${{ github.run_id }}/${{ github.run_attempt }}/ci-timing",
				paths: "ci-timing.jsonl",
			});
			expect(uploadStep?.with?.["workload-identity-provider"]).toContain(
				"GCP_WORKLOAD_IDENTITY_PROVIDER",
			);
		}
	});

	it("uses dynamic integration service ports on shared runners", () => {
		const workflow = parse(
			readFileSync(
				new URL("../../.github/workflows/integration.yml", import.meta.url),
				{
					encoding: "utf8",
				},
			),
		) as Workflow;
		const job = workflow.jobs?.["integration-tests"];
		const runStep = job?.steps?.find(
			(step) => step.name === "Run integration tests",
		);
		const setupBunStep = job?.steps?.find(
			(step) => step.uses === "./.github/actions/setup-bun-nx",
		);

		expect(job?.services?.redis?.ports).toEqual(["6379/tcp"]);
		expect(job?.services?.postgres?.ports).toEqual(["5432/tcp"]);
		expect(workflow.env).toMatchObject({
			HEADLESS_PROTOCOL_RUSTFMT: "off",
			SESSION_WIRE_FORMAT_RUSTFMT: "off",
		});
		expect(setupBunStep?.with).toMatchObject({ "ensure-rustfmt": "false" });
		expect(runStep?.env).toMatchObject({
			MAESTRO_REDIS_URL:
				"redis://localhost:${{ job.services.redis.ports['6379'] }}",
			MAESTRO_DATABASE_URL:
				"postgresql://maestro@localhost:${{ job.services.postgres.ports['5432'] }}/maestro",
		});
	});

	it("gives evals workflow test shards enough time to finish", () => {
		const workflow = parse(
			readFileSync(
				new URL("../../.github/workflows/evals.yml", import.meta.url),
				{
					encoding: "utf8",
				},
			),
		) as Workflow;
		const steps = workflow.jobs?.["run-evals"]?.steps ?? [];
		const timeouts = new Map(
			steps.map((step) => [step.name, step["timeout-minutes"]]),
		);
		const checkout = steps.find(
			(step) =>
				typeof step.uses === "string" &&
				step.uses.startsWith("actions/checkout@"),
		);
		const semgrepInstall = steps.find(
			(step) => step.name === "Install Semgrep CLI",
		);
		const uvInstall = steps.find((step) => step.name === "Install uv");
		const guardianStep = steps.find((step) => step.name === "Maestro Guardian");

		expect(checkout?.with).toMatchObject({ "fetch-depth": 0 });
		expect(uvInstall?.if).toBe("${{ matrix.chunkIndex == 1 }}");
		expect(semgrepInstall?.if).toBe("${{ matrix.chunkIndex == 1 }}");
		expect(semgrepInstall?.run).toContain("uv tool install --force");
		expect(guardianStep?.if).toBe("${{ matrix.chunkIndex == 1 }}");
		expect(guardianStep?.env).toMatchObject({
			MAESTRO_GUARDIAN_TOOL_TIMEOUT_MS: "600000",
		});
		expect(timeouts.get("Run tests")).toBeGreaterThanOrEqual(20);
		expect(timeouts.get("Run evals chunk")).toBe(45);
	});

	it("runs PR evals for sensitive changes before auto-labeling catches up", () => {
		const ciWorkflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;
		if (isPublicValidationWorkflow(ciWorkflow)) {
			return;
		}
		const workflow = parse(
			readFileSync(
				new URL("../../.github/workflows/evals.yml", import.meta.url),
				{
					encoding: "utf8",
				},
			),
		) as Workflow;
		const pullRequest = workflow.on?.pull_request as
			| { types?: string[] }
			| undefined;
		const detectJob = workflow.jobs?.["detect-pr-evals"];
		const detectStep = detectJob?.steps?.find((step) => step.id === "detect");
		const detectScript = detectStep?.with?.script;

		expect(pullRequest?.types).toEqual(
			expect.arrayContaining([
				"opened",
				"reopened",
				"ready_for_review",
				"labeled",
				"synchronize",
			]),
		);
		expect(workflow.permissions).toMatchObject({
			contents: "read",
			"pull-requests": "read",
		});
		expect(detectJob?.outputs).toMatchObject({
			should_run: "${{ steps.detect.outputs.result }}",
		});
		expect(detectJob?.["runs-on"]).toContain("PUBLIC_PR_VALIDATION_RUNNER");
		expect(detectJob?.["runs-on"]).not.toContain("BLACKSMITH");
		expect(detectJob?.["runs-on"]).not.toContain("blacksmith");
		expect(detectJob?.["runs-on"]).toContain("ubuntu-latest");
		expect(detectStep?.uses).toBe(
			"actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea",
		);
		expect(detectStep?.with?.["result-encoding"]).toBe("string");
		expect(detectScript).toContain('context.eventName !== "pull_request"');
		expect(detectScript).toContain('labels.has("run-evals")');
		expect(detectScript).toContain("github.rest.pulls.listFiles");
		expect(detectScript).toContain("src/agent/");
		expect(detectScript).toContain("src/models/");
		expect(detectScript).toContain("src/prompts/");
		expect(detectScript).toContain("src/providers/");
		expect(workflow.jobs?.["run-evals"]?.if).toBe(
			"${{ needs.detect-pr-evals.outputs.should_run == 'true' }}",
		);
	});

	it("keeps live evals out of the Nx cache", () => {
		const nxConfig = JSON.parse(
			readFileSync(new URL("../../nx.json", import.meta.url), {
				encoding: "utf8",
			}),
		) as {
			targetDefaults?: Record<string, { dependsOn?: string[] }>;
			tasksRunnerOptions?: {
				default?: { options?: { cacheableOperations?: string[] } };
			};
		};

		expect(
			nxConfig.tasksRunnerOptions?.default?.options?.cacheableOperations ?? [],
		).not.toContain("evals");
		expect(nxConfig.targetDefaults?.evals).toMatchObject({
			dependsOn: ["build"],
		});
	});

	it("auto-labels eval-sensitive pull requests without checking out PR code", () => {
		const ciWorkflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;
		if (isPublicValidationWorkflow(ciWorkflow)) {
			return;
		}
		const workflow = parse(
			readFileSync(
				new URL("../../.github/workflows/eval-label.yml", import.meta.url),
				{
					encoding: "utf8",
				},
			),
		) as Workflow;
		const labelJob = workflow.jobs?.["label-run-evals"];
		const steps = labelJob?.steps ?? [];
		const scriptStep = steps.find(
			(step) => step.name === "Label eval-sensitive PRs",
		);
		const script = scriptStep?.with?.script;

		expect(workflow.on).toHaveProperty("pull_request_target");
		expect(workflow.permissions).toMatchObject({
			issues: "write",
			"pull-requests": "read",
		});
		expect(labelJob?.["runs-on"]).toContain("PUBLIC_PR_VALIDATION_RUNNER");
		expect(labelJob?.["runs-on"]).not.toContain("BLACKSMITH");
		expect(labelJob?.["runs-on"]).not.toContain("blacksmith");
		expect(labelJob?.["runs-on"]).toContain("ubuntu-latest");
		expect(
			steps.some((step) => step.uses?.startsWith("actions/checkout@")),
		).toBe(false);
		expect(scriptStep?.uses).toBe(
			"actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea",
		);
		expect(script).toContain("github.rest.pulls.listFiles");
		expect(script).toContain("github.rest.issues.listLabelsOnIssue");
		expect(script).toContain("github.rest.issues.addLabels");
		expect(script).toContain("run-evals");
		expect(script).toContain("src/agent/");
		expect(script).toContain("src/models/");
		expect(script).toContain("src/prompts/");
		expect(script).toContain("src/providers/");
	});

	it("sets up Java before Nx can run Gradle-backed tests", () => {
		const workflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;
		const steps = workflow.jobs?.["pr-checks"]?.steps ?? [];
		const setupJavaIndex = steps.findIndex(
			(step) =>
				step.name === "Setup Java for Gradle Nx tasks" &&
				step.uses?.startsWith("actions/setup-java@"),
		);
		const nxTestIndex = steps.findIndex(
			(step) => step.name === "Test (Nx affected)",
		);

		expect(setupJavaIndex).toBeGreaterThanOrEqual(0);
		expect(nxTestIndex).toBeGreaterThan(setupJavaIndex);
		expect(steps[setupJavaIndex]?.with).toMatchObject({
			distribution: "temurin",
			"java-version": "21",
		});
		expect(steps[setupJavaIndex]?.with).not.toHaveProperty("cache");
	});

	it("uses targeted codegen checks instead of Nx for codegen utility-only changes", () => {
		const workflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;
		const changesOutputs = workflow.jobs?.changes?.outputs ?? {};
		const steps = workflow.jobs?.["pr-checks"]?.steps ?? [];
		const codegenStep = steps.find(
			(step) => step.name === "Test codegen utilities",
		);
		const nxStep = steps.find((step) => step.name === "Test (Nx affected)");
		const releaseReadinessStep = steps.find(
			(step) => step.name === "Release readiness (CI mode)",
		);
		const isPublicMirrorPrChecks = isPublicValidationWorkflow(workflow);

		if (isPublicMirrorPrChecks) {
			expect(changesOutputs).not.toHaveProperty("codegen_utility_only");
			expect(codegenStep).toBeUndefined();
			expect(nxStep).toBeDefined();
			return;
		}

		expect(changesOutputs).toHaveProperty("codegen_utility_only");
		expect(codegenStep?.if).toContain("codegen_utility_only == 'true'");
		expect(codegenStep?.run).toContain("test/scripts/codegen-utils.test.ts");
		expect(codegenStep?.run).toContain("MAESTRO_RUSTFMT=");
		expect(nxStep?.if).toContain("codegen_utility_only != 'true'");
		expect(releaseReadinessStep?.if).toContain(
			"codegen_utility_only != 'true'",
		);
	});

	it("keeps dedicated JetBrains Java setup lightweight", () => {
		const workflow = parse(
			readFileSync(
				new URL(
					"../../.github/workflows/jetbrains-plugin.yml",
					import.meta.url,
				),
				{
					encoding: "utf8",
				},
			),
		) as Workflow;
		const steps = workflow.jobs?.check?.steps ?? [];
		const setupJava = steps.find((step) =>
			step.uses?.startsWith("actions/setup-java@"),
		);

		expect(setupJava?.with).toMatchObject({
			distribution: "temurin",
			"java-version": "21",
		});
		expect(setupJava?.with).not.toHaveProperty("cache");
	});

	it("does not self-build the root project before PR tests", () => {
		const project = JSON.parse(
			readFileSync(new URL("../../project.json", import.meta.url), {
				encoding: "utf8",
			}),
		) as ProjectConfig;

		expect(project.targets?.test?.dependsOn ?? []).not.toContain("build");
	});

	it("skips Rust setup for CI-infrastructure/proof-harness PR checks", () => {
		const workflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;
		const isInternalReleaseMirrorSource = existsSync(
			new URL("../../.github/release-mirror-manifest.json", import.meta.url),
		);
		const prChecksJob = workflow.jobs?.["pr-checks"];
		const setupRustStep = prChecksJob?.steps?.find(
			(step) => step.uses === "./.github/actions/setup-rust",
		);
		const isPublicMirrorPrChecks = isPublicValidationWorkflow(workflow);

		if (!setupRustStep) {
			expect(isPublicMirrorPrChecks).toBe(true);
			const rustHostedSteps =
				workflow.jobs?.["rust-hosted-conformance"]?.steps ?? [];
			expect(
				rustHostedSteps.some(
					(step) => step.uses === "./.github/actions/setup-rust",
				),
			).toBe(true);
			return;
		}

		if (isInternalReleaseMirrorSource) {
			expect(workflow.jobs?.changes).toBeDefined();
			expect(workflow.jobs?.["public-release-mirror"]).toBeDefined();
		}
		const proofHarnessSkipCondition =
			"${{ github.event_name != 'pull_request' || (needs.changes.outputs.ci_infrastructure_only != 'true' && needs.changes.outputs.codegen_utility_only != 'true' && needs.changes.outputs.proof_harness_only != 'true' && needs.changes.outputs.release_helper_only != 'true') }}";
		expect(setupRustStep?.if).toBe(proofHarnessSkipCondition);
		expect(
			prChecksJob?.steps?.find(
				(step) => step.name === "Setup Java for Gradle Nx tasks",
			)?.if,
		).toBe(proofHarnessSkipCondition);
		expect(
			prChecksJob?.steps?.find(
				(step) => step.name === "Release readiness (CI mode)",
			)?.if,
		).toBe(proofHarnessSkipCondition);
	});

	it("isolates the Rust toolchain home across workflow runs", () => {
		const action = readFileSync(
			new URL("../../.github/actions/setup-rust/action.yml", import.meta.url),
			{
				encoding: "utf8",
			},
		);

		expect(action).toContain(
			"/maestro-rust/${safe_repo}/${safe_job}/${safe_toolchain}",
		);
		expect(action).toContain('safe_run="${GITHUB_RUN_ID:-local}"');
		expect(action).toContain('safe_attempt="${GITHUB_RUN_ATTEMPT:-0}"');
		expect(action).toContain(
			'root="$base/run-${safe_run}-attempt-${safe_attempt}"',
		);
		expect(action).toContain(
			'find "$base" -mindepth 1 -maxdepth 1 -type d -mmin +360 -exec rm -rf {} + || true',
		);
		expect(action).toContain("Ensure Rustup tool proxies");
		expect(action).toContain(
			"for proxy in cargo rustc rustdoc rustfmt cargo-fmt cargo-clippy clippy-driver",
		);
	});

	it("embeds and validates public mirror source metadata before opening PRs", () => {
		const workflowPath = new URL(
			"../../.github/workflows/sync-public-release-mirror.yml",
			import.meta.url,
		);
		if (!existsSync(workflowPath)) {
			const ciWorkflow = parse(
				readFileSync(
					new URL("../../.github/workflows/ci.yml", import.meta.url),
					{
						encoding: "utf8",
					},
				),
			) as Workflow;
			expect(isPublicValidationWorkflow(ciWorkflow)).toBe(true);
			return;
		}
		const workflow = readFileSync(workflowPath, { encoding: "utf8" });

		expect(workflow).toContain("scripts/public-mirror-source.mjs marker");
		expect(workflow).toContain("scripts/public-mirror-source.mjs validate");
		expect(workflow).toContain("source_marker");
		expect(workflow).toContain("${source_marker}");
	});

	it("serializes public mirror branch updates and runs generated-tree guardrails before PR updates", () => {
		const workflowPath = new URL(
			"../../.github/workflows/sync-public-release-mirror.yml",
			import.meta.url,
		);
		if (!existsSync(workflowPath)) {
			const ciWorkflow = parse(
				readFileSync(
					new URL("../../.github/workflows/ci.yml", import.meta.url),
					{
						encoding: "utf8",
					},
				),
			) as Workflow;
			expect(isPublicValidationWorkflow(ciWorkflow)).toBe(true);
			return;
		}
		const workflowText = readFileSync(workflowPath, { encoding: "utf8" });
		const workflow = parse(workflowText) as Workflow;
		const steps = workflow.jobs?.sync?.steps ?? [];
		const stepNames = steps.map((step) => step.name ?? "");
		const smokeIndex = stepNames.indexOf("Smoke prepared public mirror tree");
		const setupBunIndex = stepNames.indexOf(
			"Setup Bun for prepared public mirror guardrails",
		);
		const guardrailIndex = stepNames.indexOf(
			"Run prepared public mirror CI guardrails",
		);
		const openPrIndex = stepNames.indexOf("Open or update public sync PR");
		const setupBunStep = steps[setupBunIndex];
		const guardrailStep = steps[guardrailIndex];

		expect(workflow.concurrency).toMatchObject({
			"cancel-in-progress": false,
			group:
				"${{ github.workflow }}-${{ github.event.inputs.mirror_scope || 'public-tree' }}",
		});
		expect(smokeIndex).toBeGreaterThanOrEqual(0);
		expect(setupBunIndex).toBeGreaterThan(smokeIndex);
		expect(guardrailIndex).toBeGreaterThan(setupBunIndex);
		expect(guardrailIndex).toBeLessThan(openPrIndex);
		expect(setupBunStep?.uses).toBe("./.github/actions/setup-bun-nx");
		expect(guardrailStep?.run).toContain(
			"scripts/run-prepared-public-mirror-guardrails.mjs",
		);
	});

	it("prepares public companion branches before release mirror validation", () => {
		const workflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;
		if (isPublicValidationWorkflow(workflow)) {
			expect(workflow.jobs?.["public-release-mirror"]).toBeUndefined();
			return;
		}
		const steps = workflow.jobs?.["public-release-mirror"]?.steps ?? [];
		const stepNames = steps.map((step) => step.name ?? step.id ?? "");
		const authStep = steps.find((step) => step.id === "public-companion-auth");
		const appTokenStep = steps.find(
			(step) => step.name === "Mint public companion GitHub App token",
		);
		const syncIndex = stepNames.indexOf("Sync public companion branch");
		const resolveIndex = stepNames.indexOf("Resolve public mirror ref");
		const syncStep = steps[syncIndex];

		expect(authStep?.if).toBe(
			"${{ github.event_name == 'push' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.id == github.event.repository.id) }}",
		);
		expect(appTokenStep?.uses).toBe(node24CreateGitHubAppTokenPin);
		expect(syncIndex).toBeGreaterThanOrEqual(0);
		expect(syncIndex).toBeLessThan(resolveIndex);
		expect(syncStep?.env?.PUBLIC_MIRROR_TOKEN).toBe(
			"${{ steps.public-companion-app-token.outputs.token || secrets.PUBLIC_REPO_SYNC_TOKEN || secrets.PUBLIC_REPO_TOKEN }}",
		);
		expect(syncStep?.run).toContain("scripts/sync-public-companion-branch.mjs");
	});

	it("runs prepared public mirror guardrails during PR mirror validation", () => {
		const workflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;
		if (isPublicValidationWorkflow(workflow)) {
			expect(workflow.jobs?.["public-release-mirror"]).toBeUndefined();
			return;
		}
		const steps = workflow.jobs?.["public-release-mirror"]?.steps ?? [];
		const stepNames = steps.map((step) => step.name ?? step.id ?? "");
		const verifyIndex = stepNames.indexOf(
			"Verify mirrored release files match public repo",
		);
		const prepareIndex = stepNames.indexOf(
			"Prepare public mirror tree for guardrails",
		);
		const syncIndex = stepNames.indexOf(
			"Sync release manifest files into prepared public tree",
		);
		const smokeIndex = stepNames.indexOf("Smoke prepared public mirror tree");
		const setupBunIndex = stepNames.indexOf(
			"Setup Bun for prepared public mirror guardrails",
		);
		const guardrailIndex = stepNames.indexOf(
			"Run prepared public mirror CI guardrails",
		);

		expect(verifyIndex).toBeGreaterThanOrEqual(0);
		expect(prepareIndex).toBeGreaterThan(verifyIndex);
		expect(syncIndex).toBeGreaterThan(prepareIndex);
		expect(smokeIndex).toBeGreaterThan(syncIndex);
		expect(setupBunIndex).toBeGreaterThan(smokeIndex);
		expect(guardrailIndex).toBeGreaterThan(setupBunIndex);
		expect(steps[prepareIndex]?.run).toContain(
			"scripts/prepare-public-release-mirror.mjs",
		);
		expect(steps[syncIndex]?.run).toContain("scripts/sync-release-mirror.mjs");
		expect(steps[smokeIndex]?.run).toContain(
			"scripts/check-prepared-public-mirror-tree.mjs",
		);
		expect(steps[setupBunIndex]?.uses).toBe("./.github/actions/setup-bun-nx");
		expect(steps[guardrailIndex]?.run).toContain(
			"scripts/run-prepared-public-mirror-guardrails.mjs",
		);
	});

	it("registry-smokes real public release mirror fallback publishes", () => {
		const workflow = parse(
			readFileSync(
				new URL(
					"../../.github/workflows/public-release-mirror.yml",
					import.meta.url,
				),
				{ encoding: "utf8" },
			),
		) as Workflow;
		const steps = workflow.jobs?.["mirror-release"]?.steps ?? [];
		const stepNames = steps.map((step) => step.name ?? step.id ?? "");
		const publishIndex = stepNames.indexOf(
			"Publish public npm package fallback",
		);
		const verifyIndex = stepNames.indexOf(
			"Verify manual npm fallback from registry",
		);
		const verifyStep = steps[verifyIndex];
		const uploadStep = steps.find((step) =>
			isPreparedPublicMirror
				? step.name === "Upload manual fallback replay evidence"
				: step.name === "Upload manual fallback replay evidence to GCS",
		);

		expect(publishIndex).toBeGreaterThanOrEqual(0);
		expect(verifyIndex).toBeGreaterThan(publishIndex);
		expect(verifyStep?.if).toContain(
			"github.event.inputs.publish_npm == 'true'",
		);
		expect(verifyStep?.if).toContain("npm_dry_run == 'true'");
		expect(verifyStep?.["working-directory"]).toBe("public-mirror");
		expectRegistryInstallSmokeIsReleaseBlocking(
			verifyStep,
			[workflow.env, workflow.jobs?.["mirror-release"]?.env],
			{
				containingJob: workflow.jobs?.["mirror-release"],
				precedingSteps: steps.slice(0, verifyIndex),
			},
		);
		expect(verifyStep?.run).toBe("node scripts/smoke-registry-install.js");
		expect(verifyStep?.env).toMatchObject({
			MAESTRO_INSTALL_AUDIT_LEVEL: "critical",
			MAESTRO_PUBLISHED_REPLAY_SANDBOX_MODE: "local",
			MAESTRO_REGISTRY_SMOKE_EVIDENCE_DIR: "fallback-published-replay-evidence",
		});
		expect(String(uploadStep?.if ?? "")).toContain(
			"fallback-published-replay-evidence",
		);
		if (isPreparedPublicMirror) {
			expect(uploadStep?.uses).toContain("actions/upload-artifact@");
			expect(uploadStep?.with?.path).toBe(
				"public-mirror/fallback-published-replay-evidence/*.json",
			);
		} else {
			expect(uploadStep?.uses).toBe("./.github/actions/gcs-artifacts");
			expect(uploadStep?.with).toMatchObject({
				mode: "upload",
				"if-missing": "ignore",
				prefix:
					"maestro-internal/public-release-mirror/${{ github.run_id }}/${{ github.run_attempt }}/fallback-published-replay-evidence",
				paths: "public-mirror/fallback-published-replay-evidence/*.json",
			});
			expect(uploadStep?.with?.["workload-identity-provider"]).toContain(
				"GCP_WORKLOAD_IDENTITY_PROVIDER",
			);
		}
	});

	it("syncs release mirror helpers before validating public release mirrors", () => {
		const workflow = parse(
			readFileSync(
				new URL(
					"../../.github/workflows/public-release-mirror.yml",
					import.meta.url,
				),
				{ encoding: "utf8" },
			),
		) as Workflow;
		const steps = workflow.jobs?.["mirror-release"]?.steps ?? [];
		const stepNames = steps.map((step) => step.name ?? step.id ?? "");
		const prepareIndex = stepNames.indexOf(
			"Prepare sanitized public release tree",
		);
		const syncIndex = stepNames.indexOf("Sync release mirror helper files");
		const validateIndex = stepNames.indexOf("Validate mirrored public tree");
		const syncStep = steps[syncIndex];

		expect(prepareIndex).toBeGreaterThanOrEqual(0);
		expect(syncIndex).toBeGreaterThan(prepareIndex);
		expect(validateIndex).toBeGreaterThan(syncIndex);
		expect(syncStep?.run).toContain("scripts/sync-release-mirror.mjs");
		expect(syncStep?.run).toContain(
			'--target "$GITHUB_WORKSPACE/public-mirror"',
		);
	});

	it("uses token-backed release PR pushes and formats generated release metadata", () => {
		const workflowPath = new URL(
			"../../.github/workflows/version-bump.yml",
			import.meta.url,
		);
		if (!existsSync(workflowPath)) {
			const ciWorkflow = parse(
				readFileSync(
					new URL("../../.github/workflows/ci.yml", import.meta.url),
					{
						encoding: "utf8",
					},
				),
			) as Workflow;
			expect(isPublicValidationWorkflow(ciWorkflow)).toBe(true);
			return;
		}
		const workflowText = readFileSync(workflowPath, { encoding: "utf8" });
		const workflow = parse(workflowText) as Workflow;
		const steps = workflow.jobs?.["version-bump"]?.steps ?? [];
		const formatStep = steps.find(
			(step) => step.name === "Format generated release files",
		);
		const commitStep = steps.find(
			(step) => step.name === "Commit release branch",
		);
		const prStep = steps.find(
			(step) => step.name === "Open or reuse release PR",
		);

		expect(
			steps.some((step) => step.name === "Mint release PR GitHub App token"),
		).toBe(true);
		expect(formatStep?.run).toContain("@biomejs/biome@1.9.4 format --write");
		expect(commitStep?.env?.RELEASE_PR_TOKEN).toBe(
			"${{ steps.release-app-token.outputs.token || secrets.RELEASE_PR_SYNC_TOKEN || secrets.RELEASE_PR_TOKEN }}",
		);
		expect(commitStep?.run).toContain(
			"https://x-access-token:${RELEASE_PR_TOKEN}@github.com/${GITHUB_REPOSITORY}.git",
		);
		expect(prStep?.env?.GH_TOKEN).toBe(
			"${{ steps.release-app-token.outputs.token || secrets.RELEASE_PR_SYNC_TOKEN || secrets.RELEASE_PR_TOKEN }}",
		);
		expect(prStep?.run).toContain("## Test Plan");
		expect(prStep?.run).toContain("## Rollback");
	});

	it("updates only behind same-repo auto-merge pull requests with non-GITHUB_TOKEN auth", () => {
		const workflowPath = new URL(
			"../../.github/workflows/pr-auto-update.yml",
			import.meta.url,
		);
		if (!existsSync(workflowPath)) {
			expectPublicValidationWorkflow();
			return;
		}
		const workflowText = readFileSync(workflowPath, { encoding: "utf8" });
		const workflow = parse(workflowText) as Workflow;
		const steps = workflow.jobs?.update?.steps ?? [];
		const updateStep = steps.find(
			(step) => step.name === "Update behind auto-merge PRs",
		);

		expect(workflowText).toContain("push:");
		expect(workflowText).toContain("- main");
		expect(
			steps.some(
				(step) => step.name === "Mint PR auto-update GitHub App token",
			),
		).toBe(true);
		expect(updateStep?.env?.GH_TOKEN).toBe(
			"${{ steps.auto-update-app-token.outputs.token || secrets.PR_AUTO_UPDATE_TOKEN || secrets.RELEASE_PR_SYNC_TOKEN || secrets.RELEASE_PR_TOKEN }}",
		);
		expect(updateStep?.env?.GH_TOKEN).not.toContain("github.token");
		expect(updateStep?.run).toContain(
			"scripts/update-behind-auto-merge-prs.mjs",
		);
	});

	it("keeps setup-bun-nx rustfmt home stable across workflow runs", () => {
		const action = readFileSync(
			new URL("../../.github/actions/setup-bun-nx/action.yml", import.meta.url),
			{
				encoding: "utf8",
			},
		);

		expect(action).toContain(
			"/maestro-rust/${safe_repo}/${safe_job}/stable-rustfmt",
		);
		expect(action).not.toContain("GITHUB_RUN_ID");
	});

	it("installs ripgrep before CI jobs that run search-backed tests", () => {
		const workflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;

		for (const jobName of [
			"pr-checks",
			"coverage",
			"rust-hosted-conformance",
		]) {
			const setupBunStep = workflow.jobs?.[jobName]?.steps?.find(
				(step) => step.uses === "./.github/actions/setup-bun-nx",
			);

			expect(setupBunStep?.with).toMatchObject({ "ensure-ripgrep": "true" });
		}
	});

	it("shares CI ripgrep installation through the composite helper", () => {
		const setupBunNx = parse(
			readFileSync(
				new URL(
					"../../.github/actions/setup-bun-nx/action.yml",
					import.meta.url,
				),
				{ encoding: "utf8" },
			),
		) as { runs?: { steps?: WorkflowStep[] } };
		const setupRust = parse(
			readFileSync(
				new URL("../../.github/actions/setup-rust/action.yml", import.meta.url),
				{ encoding: "utf8" },
			),
		) as { runs?: { steps?: WorkflowStep[] } };
		const ensureRipgrep = parse(
			readFileSync(
				new URL(
					"../../.github/actions/ensure-ripgrep/action.yml",
					import.meta.url,
				),
				{ encoding: "utf8" },
			),
		) as { runs?: { steps?: WorkflowStep[] } };
		const setupBunStep = setupBunNx.runs?.steps?.find(
			(step) => step.name === "Ensure ripgrep",
		);
		const setupRustStep = setupRust.runs?.steps?.find(
			(step) => step.name === "Ensure ripgrep",
		);
		const ensureScript =
			ensureRipgrep.runs?.steps?.find((step) => step.name === "Ensure ripgrep")
				?.run ?? "";

		expect(setupBunStep?.uses).toBe("./.github/actions/ensure-ripgrep");
		expect(setupRustStep?.uses).toBe("./.github/actions/ensure-ripgrep");
		expect(ensureScript).toContain("rg --version");
		expect(ensureScript).toContain("sudo apt-get update");
		expect(ensureScript).toContain("brew install ripgrep");
		expect(ensureScript).toContain("neither rg, apt-get, nor Homebrew");
	});

	it("uses dynamic host ports for integration service containers", () => {
		const workflowText = readFileSync(
			new URL("../../.github/workflows/integration.yml", import.meta.url),
			{
				encoding: "utf8",
			},
		);
		const workflow = parse(workflowText) as Workflow;
		const job = workflow.jobs?.["integration-tests"];
		const runStep = job?.steps?.find(
			(step) => step.name === "Run integration tests",
		);
		const normalizeServicePorts = (ports: unknown[] | undefined) =>
			ports?.map((port) => String(port).replace(/\/tcp$/u, ""));

		expect(normalizeServicePorts(job?.services?.redis?.ports)).toEqual([
			"6379",
		]);
		expect(normalizeServicePorts(job?.services?.postgres?.ports)).toEqual([
			"5432",
		]);
		expect(workflowText).not.toContain("6379:6379");
		expect(workflowText).not.toContain("5432:5432");
		expect(runStep?.env?.MAESTRO_REDIS_URL).toBe(
			"redis://localhost:${{ job.services.redis.ports['6379'] }}",
		);
		expect(runStep?.env?.MAESTRO_DATABASE_URL).toBe(
			"postgresql://maestro@localhost:${{ job.services.postgres.ports['5432'] }}/maestro",
		);
	});

	it("sets up Java exactly once before Nx tests", () => {
		const workflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;
		const steps = workflow.jobs?.["pr-checks"]?.steps ?? [];
		const javaSteps = steps.filter((step) =>
			step.uses?.startsWith("actions/setup-java@"),
		);
		const setupBunIndex = steps.findIndex(
			(step) => step.uses === "./.github/actions/setup-bun-nx",
		);
		const javaIndex = steps.findIndex(
			(step) => step.name === "Setup Java for Gradle Nx tasks",
		);
		const nxTestIndex = steps.findIndex(
			(step) => step.name === "Test (Nx affected)",
		);

		expect(javaSteps).toHaveLength(1);
		expect(javaSteps[0]?.with).toMatchObject({
			distribution: "temurin",
			"java-version": "21",
		});
		expect(javaSteps[0]?.with).not.toHaveProperty("cache");
		expect(javaIndex).toBeGreaterThan(setupBunIndex);
		expect(javaIndex).toBeLessThan(nxTestIndex);
	});

	it("records Nx resolved targets and per-target timing profiles", () => {
		const script = readFileSync(
			new URL("../../scripts/ci-nx-tests.sh", import.meta.url),
			{ encoding: "utf8" },
		);

		expect(script).toContain("nx-resolved-targets.log");
		expect(script).toContain("--withTarget test");
		expect(script).toContain('NX_PROFILE="$profile_file"');
		expect(script).toContain("scripts/summarize-nx-profile.mjs");
		expect(script).toContain("nx-target-timings-attempt-${attempt}.log");
	});

	it("uploads Nx timing and resolved-target artifacts", () => {
		const workflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;
		const uploadStep = workflow.jobs?.["pr-checks"]?.steps?.find(
			(step) => step.name === "Upload Nx test logs (if any)",
		);

		expect(uploadStep?.if).toContain("nx-tests-attempt-*.log");
		if (isPublicValidationWorkflow(workflow)) {
			expect(String(uploadStep?.with?.path ?? "")).toContain(
				"nx-tests-attempt-*.log",
			);
			return;
		}

		expect(uploadStep?.if).toContain("nx-target-timings-*.log");
		expect(uploadStep?.uses).toBe("./.github/actions/gcs-artifacts");
		expect(String(uploadStep?.with?.paths ?? "")).toContain(
			"nx-resolved-targets.log",
		);
		expect(String(uploadStep?.with?.paths ?? "")).toContain(
			"nx-target-timings-*.log",
		);
		expect(String(uploadStep?.with?.paths ?? "")).toContain(
			"nx-profile-*.json",
		);
	});

	it("cancels stale review-thread guard runs for the same PR", () => {
		const workflow = parse(
			readFileSync(
				new URL(
					"../../.github/workflows/review-thread-guard.yml",
					import.meta.url,
				),
				{
					encoding: "utf8",
				},
			),
		) as Workflow;

		expect(workflow.concurrency?.group).toBe(
			"${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
		);
		expect(workflow.concurrency?.["cancel-in-progress"]).toBe(true);
	});

	it("keeps the Rust release cache unless repairing dep-info corruption", () => {
		const workflow = parse(
			readFileSync(
				new URL("../../.github/workflows/rust.yml", import.meta.url),
				{ encoding: "utf8" },
			),
		) as Workflow;
		const buildStep = workflow.jobs?.build?.steps?.find(
			(step) => step.name === "Build",
		);
		const buildScript = buildStep?.run ?? "";

		expect(buildScript).toContain("could not parse/generate dep info");
		expect(buildScript).toContain('"$cargo_bin" build --release 2>&1 | tee');
		expect(buildScript.indexOf('"$cargo_bin" clean --release')).toBeGreaterThan(
			buildScript.indexOf('"$cargo_bin" build --release'),
		);
	});

	it("runs the Nix hash updater on a hosted sudo-capable runner", () => {
		const workflow = parse(
			readFileSync(
				new URL("../../.github/workflows/update-nix-hash.yml", import.meta.url),
				{ encoding: "utf8" },
			),
		) as Workflow;
		const job = workflow.jobs?.["update-hash"];
		const installNixStep = job?.steps?.find((step) =>
			step.uses?.startsWith("cachix/install-nix-action@"),
		);

		expect([
			"ubuntu-latest",
			"${{ vars.PUBLIC_PR_VALIDATION_RUNNER || 'ubuntu-latest' }}",
		]).toContain(job?.["runs-on"]);
		expect(installNixStep?.with).toMatchObject({
			enable_kvm: false,
			nix_path: "nixpkgs=channel:nixos-unstable",
		});
	});
});

describe("rust workflow guardrails", () => {
	it("gives hosted Rust conformance enough time for cold private runners", () => {
		const workflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;

		expect(
			workflow.jobs?.["rust-hosted-conformance"]?.["timeout-minutes"],
		).toBe(60);
	});

	it("hard-bounds expensive Rust TUI phases", () => {
		const workflow = parse(
			readFileSync(
				new URL("../../.github/workflows/rust.yml", import.meta.url),
				{
					encoding: "utf8",
				},
			),
		) as Workflow;
		const steps = workflow.jobs?.build?.steps ?? [];
		const timeoutByStep = new Map(
			steps.map((step) => [step.name, step["timeout-minutes"]]),
		);

		expect(timeoutByStep.get("Run clippy")).toBe(30);
		expect(timeoutByStep.get("Build")).toBe(45);
		expect(timeoutByStep.get("Run all tests")).toBe(30);
		expect(timeoutByStep.get("Run hook integration tests")).toBe(15);
		expect(timeoutByStep.get("Test summary")).toBe(5);
		expect(steps.find((step) => step.name === "Build")?.run).toContain(
			'"$cargo_bin" clean --release',
		);
		expect(steps.find((step) => step.name === "Run all tests")?.run).toContain(
			'cargo_bin="${CARGO_HOME:-$HOME/.cargo}/bin/cargo"',
		);
	});

	it("routes Rust TUI pull-request jobs to the expected runner lane", () => {
		const workflow = parse(
			readFileSync(
				new URL("../../.github/workflows/rust.yml", import.meta.url),
				{
					encoding: "utf8",
				},
			),
		) as Workflow;
		const buildRunsOn = String(workflow.jobs?.build?.["runs-on"] ?? "");
		const hooksCoverageRunsOn = String(
			workflow.jobs?.["hooks-coverage"]?.["runs-on"] ?? "",
		);

		expectRustTuiRunnerLane(buildRunsOn);
		expectRustTuiRunnerLane(hooksCoverageRunsOn);
	});
});

describe("hosted static workflow guardrails", () => {
	it("keeps actionlint and shellcheck on the configured owned runner", () => {
		const expectedRunner = isPreparedPublicMirror
			? "${{ vars.PUBLIC_PR_VALIDATION_RUNNER || 'ubuntu-latest' }}"
			: "${{ vars.PUBLIC_PR_VALIDATION_RUNNER || 'evalops-internal' }}";
		for (const workflowName of ["actionlint.yml", "shellcheck.yml"]) {
			const workflow = parse(
				readFileSync(
					new URL(`../../.github/workflows/${workflowName}`, import.meta.url),
					{ encoding: "utf8" },
				),
			) as Workflow;
			const onlyJob = Object.values(workflow.jobs ?? {})[0];
			expect(String(onlyJob?.["runs-on"] ?? "")).toBe(expectedRunner);
		}
	});

	it("keeps ShellCheck install portable across runner architectures", () => {
		const workflow = parse(
			readFileSync(
				new URL("../../.github/workflows/shellcheck.yml", import.meta.url),
				{ encoding: "utf8" },
			),
		) as Workflow;
		const installStep = workflow.jobs?.shellcheck?.steps?.find(
			(step) => step.name === "Install shellcheck",
		);

		expect(installStep?.run).toContain(
			'Linux-aarch64 | Linux-arm64) shellcheck_platform="linux.aarch64"',
		);
		expect(installStep?.run).toContain("sudo apt-get install -y shellcheck");
		expect(installStep?.run).toContain(
			"Unsupported ShellCheck install platform",
		);
	});
});

describe("planNxTestCommand", () => {
	const basePackage = {
		dependencies: { "@evalops/contracts": "1.0.0" },
		name: "@example/root",
		scripts: { test: "vitest" },
	};

	it("keeps dependency-affecting package changes on the full test matrix", () => {
		expect(
			planNxTestCommand({
				basePackage,
				changedFiles: ["package.json", "src/index.ts"],
				headPackage: {
					...basePackage,
					dependencies: { "@evalops/contracts": "1.0.1" },
				},
			}),
		).toEqual({ files: [], mode: "all" });
	});

	it("uses affected files when root project only removes self-build", () => {
		expect(
			planNxTestCommand({
				basePackage,
				changedFiles: ["project.json"],
				headPackage: basePackage,
				rootProjectJsonOnlyRemovesTestSelfBuild: true,
			}),
		).toEqual({ files: ["project.json"], mode: "affected-files" });
	});

	it("uses explicit affected files for root package script-only changes", () => {
		expect(
			planNxTestCommand({
				basePackage,
				changedFiles: [
					"package.json",
					"scripts/smoke-platform-a2a-delegation-live.ts",
					"test/platform/a2a-platform-delegation-live.test.ts",
				],
				headPackage: {
					...basePackage,
					scripts: {
						...basePackage.scripts,
						"platform:a2a-delegation-live":
							"tsx scripts/smoke-platform-a2a-delegation-live.ts",
					},
				},
			}),
		).toEqual({
			files: ["test/platform/a2a-platform-delegation-live.test.ts"],
			mode: "affected-files",
		});
	});

	it("skips Nx for docs plus proof smoke script changes", () => {
		expect(
			planNxTestCommand({
				basePackage,
				changedFiles: [
					"docs/protocols/a2a-fleet-delegation.md",
					"package.json",
					"scripts/smoke-maestro-a2a-local-swarm.ts",
				],
				headPackage: {
					...basePackage,
					scripts: {
						...basePackage.scripts,
						"smoke:a2a-local-swarm":
							"tsx scripts/smoke-maestro-a2a-local-swarm.ts",
					},
				},
			}),
		).toEqual({ files: [], mode: "none" });
	});

	it("filters release metadata package manifests from affected files", () => {
		expect(
			planNxTestCommand({
				basePackage,
				changedFiles: [
					".github/workflows/ci.yml",
					"CHANGELOG.md",
					"openapi.json",
					"package.json",
					"packages/contracts/package.json",
					"packages/slack-agent/test/tools-status.test.ts",
					"scripts/ci-nx-tests.sh",
					"scripts/check-runtime-deps.js",
					"scripts/plan-nx-test-command.mjs",
					"scripts/runtime-workspaces.mjs",
					"scripts/summarize-nx-profile.mjs",
					"test/scripts/ci-guardrails.test.ts",
				],
				handledOutsideNxFiles: [
					".github/workflows/ci.yml",
					"scripts/ci-nx-tests.sh",
					"scripts/check-runtime-deps.js",
					"scripts/plan-nx-test-command.mjs",
					"scripts/runtime-workspaces.mjs",
					"scripts/summarize-nx-profile.mjs",
					"test/scripts/ci-guardrails.test.ts",
				],
				headPackage: {
					...basePackage,
					version: "1.0.1",
				},
				packageJsonMetadataOnlyFiles: [
					"package.json",
					"packages/contracts/package.json",
				],
				releaseMetadataOnlyFiles: ["CHANGELOG.md", "openapi.json"],
			}),
		).toEqual({
			files: ["packages/slack-agent/test/tools-status.test.ts"],
			mode: "affected-files",
		});
	});

	it("keeps release package helper scripts out of Nx affected tests", () => {
		expect(
			planNxTestCommand({
				basePackage,
				changedFiles: [
					"scripts/check-package-cutover-readiness.js",
					"scripts/configure-npm-trusted-publisher.mjs",
					"scripts/deprecate-release.js",
					"scripts/install-smoke-utils.js",
					"scripts/plan-ci-checks.mjs",
					"scripts/published-replay-evidence-gate.js",
					"scripts/release-impact-filter.mjs",
					"scripts/release-observability-query-contract.js",
					"scripts/release-readiness.js",
					"scripts/smoke-packed-cli.js",
					"scripts/smoke-published-replay-e2e.js",
					"scripts/smoke-registry-install.js",
					"scripts/workspace-utils.js",
					"test/scripts/ci-guardrails.test.ts",
				],
				headPackage: basePackage,
			}),
		).toEqual({ files: [], mode: "none" });
	});

	it("keeps release package helper tests in Nx affected tests", () => {
		expect(
			planNxTestCommand({
				basePackage,
				changedFiles: [
					"scripts/install-smoke-utils.js",
					"scripts/workspace-utils.js",
					"test/scripts/deprecate-release.test.ts",
					"test/scripts/release-impact-filter.test.ts",
					"test/scripts/workspace-utils.test.ts",
				],
				headPackage: basePackage,
			}),
		).toEqual({
			files: [
				"test/scripts/deprecate-release.test.ts",
				"test/scripts/release-impact-filter.test.ts",
				"test/scripts/workspace-utils.test.ts",
			],
			mode: "affected-files",
		});
	});

	it("keeps release surface conformance docs and helper out of Nx affected tests", () => {
		expect(
			planNxTestCommand({
				basePackage,
				changedFiles: [
					"docs/protocols/release-surface-conformance.json",
					"docs/protocols/release-surface-conformance.md",
					"package.json",
					"scripts/check-package-cutover-readiness.js",
					"scripts/check-release-surface-conformance.mjs",
					"test/scripts/release-surface-conformance.test.ts",
				],
				headPackage: {
					...basePackage,
					scripts: {
						...basePackage.scripts,
						"check:release-surface":
							"node scripts/check-release-surface-conformance.mjs",
					},
				},
			}),
		).toEqual({
			files: ["test/scripts/release-surface-conformance.test.ts"],
			mode: "affected-files",
		});
	});

	it("keeps workflow unit tests as explicit affected files", () => {
		expect(
			planNxTestCommand({
				basePackage,
				changedFiles: [
					".github/workflows/tag-release.yml",
					"test/scripts/ci-guardrails.test.ts",
					"test/workflows/tag-release.test.ts",
				],
				headPackage: basePackage,
			}),
		).toEqual({
			files: ["test/workflows/tag-release.test.ts"],
			mode: "affected-files",
		});
	});

	it("skips Nx when package scripts are the only changed files", () => {
		expect(
			planNxTestCommand({
				basePackage,
				changedFiles: ["package.json"],
				headPackage: {
					...basePackage,
					scripts: {
						...basePackage.scripts,
						"platform:a2a-evidence-verify":
							"tsx scripts/verify-platform-a2a-live-evidence.ts",
					},
				},
			}),
		).toEqual({ files: [], mode: "none" });
	});

	it("skips runtime package validators for script-only package changes", () => {
		expect(
			runtimePackageValidatorsRequired({
				basePackage,
				changedFiles: [
					"package.json",
					"scripts/smoke-platform-a2a-delegation-live.ts",
				],
				headPackage: {
					...basePackage,
					scripts: {
						...basePackage.scripts,
						"platform:a2a-delegation-live":
							"tsx scripts/smoke-platform-a2a-delegation-live.ts",
					},
				},
			}),
		).toBe(false);
	});

	it("skips runtime package validators for release helper test and CI-only changes", () => {
		expect(
			runtimePackageValidatorsRequired({
				basePackage,
				changedFiles: [
					"scripts/plan-ci-checks.mjs",
					"scripts/plan-nx-test-command.mjs",
					"test/scripts/ci-guardrails.test.ts",
					"test/scripts/deprecate-release.test.ts",
					"test/scripts/workspace-utils.test.ts",
				],
				headPackage: basePackage,
			}),
		).toBe(false);
	});

	it("requires runtime package validators for release helper script changes", () => {
		expect(
			runtimePackageValidatorsRequired({
				basePackage,
				changedFiles: [
					"scripts/install-smoke-utils.js",
					"scripts/release-readiness.js",
					"scripts/smoke-packed-cli.js",
					"scripts/smoke-published-replay-e2e.js",
					"scripts/workspace-utils.js",
				],
				headPackage: basePackage,
			}),
		).toBe(true);
	});

	it("requires runtime package validators for dependency-affecting changes", () => {
		expect(
			runtimePackageValidatorsRequired({
				basePackage,
				changedFiles: ["package.json"],
				headPackage: {
					...basePackage,
					dependencies: {
						...basePackage.dependencies,
						"left-pad": "^1.3.0",
					},
				},
			}),
		).toBe(true);
		expect(
			runtimePackageValidatorsRequired({
				basePackage,
				changedFiles: ["scripts/check-runtime-deps.js"],
				headPackage: basePackage,
			}),
		).toBe(true);
	});

	it("treats runtime workspace package metadata as release metadata", () => {
		expect(
			packageManifestReleaseMetadataOnlyChanged({
				allowedRootDependencyNames: ["@bufbuild/protobuf"],
				basePackage: {
					...basePackage,
					bundleDependencies: ["@evalops/contracts"],
					version: "1.0.0",
				},
				headPackage: {
					...basePackage,
					dependencies: {
						...basePackage.dependencies,
						"@bufbuild/protobuf": "^2.11.0",
					},
					maestroRuntimeWorkspaces: ["@evalops/contracts"],
					version: "1.0.1",
				},
				isRootPackage: true,
			}),
		).toBe(true);
	});

	it("keeps non-runtime root dependency additions on the full matrix", () => {
		expect(
			packageManifestReleaseMetadataOnlyChanged({
				allowedRootDependencyNames: ["@bufbuild/protobuf"],
				basePackage,
				headPackage: {
					...basePackage,
					dependencies: {
						...basePackage.dependencies,
						"left-pad": "^1.3.0",
					},
				},
				isRootPackage: true,
			}),
		).toBe(false);
	});
});

describe("summarizeNxProfile", () => {
	it("formats Nx task profile rows by slowest target first", async () => {
		const timingModule = (await import(
			"../../scripts/summarize-nx-profile.mjs"
		)) as {
			formatNxTargetTimingSummary: (
				rows: NxTargetTimingRow[],
				options?: { expectedTargets?: string[] },
			) => string;
			summarizeNxProfile: (profile: unknown) => NxTargetTimingRow[];
		};

		const rows = timingModule.summarizeNxProfile([
			{
				args: { name: "Group #1" },
				name: "thread_name",
				ph: "M",
			},
			{
				args: {
					status: "local-cache",
					target: { project: "tui", target: "test" },
				},
				dur: 250_000,
				name: "tui:test",
				ph: "X",
			},
			{
				args: {
					status: "success",
					target: { project: "maestro", target: "test" },
				},
				dur: 1_500_000,
				name: "maestro:test",
				ph: "X",
			},
		]);

		expect(rows).toEqual([
			{ durationMs: 1500, status: "success", target: "maestro:test" },
			{ durationMs: 250, status: "local-cache", target: "tui:test" },
		]);

		expect(
			timingModule.formatNxTargetTimingSummary(rows, {
				expectedTargets: ["maestro:test", "tui:test", "vscode-extension:test"],
			}),
		).toContain("vscode-extension:test | not-profiled");
	});
});

describe("public mirror ref resolution", () => {
	it("tries internal branch aliases before falling back to main", () => {
		expect(publicMirrorRefCandidates("codex/internal-release-foo")).toEqual([
			"codex/internal-release-foo",
			"internal-release-foo",
			"codex/release-foo",
			"release-foo",
		]);
		expect(publicMirrorRefCandidates("internal-release-foo")).toEqual([
			"internal-release-foo",
			"release-foo",
		]);
		expect(
			publicMirrorRefCandidates("codex/published-canary-sandbox-fix"),
		).toEqual([
			"codex/published-canary-sandbox-fix",
			"published-canary-sandbox-fix",
		]);
	});

	it("reports the matched public branch source", () => {
		const resolved = resolvePublicMirrorRef({
			headExistsFn: (_repo, ref) => ref === "codex/release-foo",
			internalRef: "codex/internal-release-foo",
			publicRepo: "https://github.com/evalops/maestro.git",
		});

		expect(resolved).toMatchObject({
			ref: "codex/release-foo",
			source: "matched-public-branch",
		});
	});
});

describe("public companion branch sync", () => {
	it("derives companion branches from internal ref aliases", async () => {
		const scriptPath = new URL(
			"../../scripts/sync-public-companion-branch.mjs",
			import.meta.url,
		);
		if (!existsSync(scriptPath)) {
			expectPublicValidationWorkflow();
			return;
		}
		const { companionBranchForInternalRef, publicBranchHeadRef } = await import(
			scriptPath.href
		);

		expect(companionBranchForInternalRef("codex/internal-release-foo")).toBe(
			"codex/internal-release-foo",
		);
		expect(companionBranchForInternalRef("internal-release-foo")).toBe(
			"internal-release-foo",
		);
		expect(publicBranchHeadRef("codex/internal-release-foo")).toBe(
			"refs/heads/codex/internal-release-foo",
		);
	});

	it("injects GitHub tokens only for GitHub HTTPS remotes", async () => {
		const scriptPath = new URL(
			"../../scripts/sync-public-companion-branch.mjs",
			import.meta.url,
		);
		if (!existsSync(scriptPath)) {
			expectPublicValidationWorkflow();
			return;
		}
		const { tokenizedGitHubUrl } = await import(scriptPath.href);

		expect(
			tokenizedGitHubUrl("https://github.com/evalops/maestro.git", "token-123"),
		).toBe("https://x-access-token:token-123@github.com/evalops/maestro.git");
		expect(
			tokenizedGitHubUrl("git@github.com:evalops/maestro.git", "token-123"),
		).toBe("git@github.com:evalops/maestro.git");
	});
});

describe("behind auto-merge PR updates", () => {
	const eligiblePr = {
		autoMergeRequest: { enabledAt: "2026-05-23T00:00:00Z" },
		baseRefName: "main",
		headRefName: "codex/example",
		isCrossRepository: false,
		headRepositoryOwner: { login: "evalops" },
		isDraft: false,
		mergeStateStatus: "BEHIND",
		number: 123,
		state: "OPEN",
		title: "example",
	};

	it("selects only open same-repo auto-merge PRs that are behind main", async () => {
		const scriptPath = new URL(
			"../../scripts/update-behind-auto-merge-prs.mjs",
			import.meta.url,
		);
		if (!existsSync(scriptPath)) {
			expectPublicValidationWorkflow();
			return;
		}
		const { shouldUpdatePr } = await import(scriptPath.href);

		expect(shouldUpdatePr(eligiblePr, { base: "main", owner: "evalops" })).toBe(
			true,
		);
		for (const patch of [
			{ autoMergeRequest: null },
			{ baseRefName: "release/v1" },
			{ headRepositoryOwner: { login: "contributor" } },
			{ isCrossRepository: true },
			{ isDraft: true },
			{ mergeStateStatus: "CLEAN" },
			{ state: "CLOSED" },
		]) {
			expect(
				shouldUpdatePr(
					{ ...eligiblePr, ...patch },
					{
						base: "main",
						owner: "evalops",
					},
				),
			).toBe(false);
		}
	});

	it("summarizes the update queue without mutating skipped PRs", async () => {
		const scriptPath = new URL(
			"../../scripts/update-behind-auto-merge-prs.mjs",
			import.meta.url,
		);
		if (!existsSync(scriptPath)) {
			expectPublicValidationWorkflow();
			return;
		}
		const { summarizeUpdateQueue } = await import(scriptPath.href);

		const queue = summarizeUpdateQueue(
			[
				eligiblePr,
				{ ...eligiblePr, autoMergeRequest: null, number: 124 },
				{ ...eligiblePr, mergeStateStatus: "CLEAN", number: 125 },
			],
			{ base: "main", repo: "evalops/maestro-internal" },
		);
		expect(queue.selected.map((pr) => pr.number)).toEqual([123]);
		expect(queue.skipped.map((pr) => pr.number)).toEqual([124, 125]);
	});
});

describe("maestro merge queue status", () => {
	it("summarizes pending and failing checks", () => {
		expect(
			summarizeChecks([
				{
					__typename: "CheckRun",
					conclusion: "SUCCESS",
					name: "coverage",
					status: "COMPLETED",
				},
				{
					__typename: "CheckRun",
					conclusion: "",
					name: "pr-checks",
					status: "IN_PROGRESS",
				},
				{
					__typename: "StatusContext",
					context: "external/review",
					state: "FAILURE",
				},
				{
					__typename: "StatusContext",
					context: "external/pending-review",
					state: "PENDING",
				},
				{
					__typename: "StatusContext",
					context: "external/expected-review",
					state: "EXPECTED",
				},
			]),
		).toMatchObject({
			failing: ["external/review (FAILURE)"],
			passing: 1,
			pending: [
				"pr-checks",
				"external/pending-review",
				"external/expected-review",
			],
			total: 5,
		});
	});

	it("ignores superseded duplicate status checks", () => {
		expect(
			summarizeChecks([
				{
					__typename: "CheckRun",
					completedAt: "2026-05-22T13:38:45Z",
					conclusion: "CANCELLED",
					name: "build-and-publish",
					startedAt: "2026-05-22T13:38:44Z",
					status: "COMPLETED",
				},
				{
					__typename: "CheckRun",
					completedAt: "2026-05-22T13:38:59Z",
					conclusion: "SUCCESS",
					name: "build-and-publish",
					startedAt: "2026-05-22T13:38:48Z",
					status: "COMPLETED",
				},
				{
					__typename: "CheckRun",
					completedAt: "2026-05-22T13:35:14Z",
					conclusion: "CANCELLED",
					name: "unresolved-review-threads / unresolved-review-threads",
					startedAt: "2026-05-22T13:34:50Z",
					status: "COMPLETED",
				},
				{
					__typename: "CheckRun",
					completedAt: "0001-01-01T00:00:00Z",
					conclusion: "",
					name: "unresolved-review-threads / unresolved-review-threads",
					startedAt: "2026-05-22T13:38:47Z",
					status: "IN_PROGRESS",
				},
				{
					__typename: "StatusContext",
					context: "evalops-pr-lens/meta-review",
					startedAt: "2026-05-22T13:16:49Z",
					state: "FAILURE",
				},
				{
					__typename: "StatusContext",
					context: "evalops-pr-lens/meta-review",
					startedAt: "2026-05-22T13:39:07Z",
					state: "SUCCESS",
				},
			]),
		).toMatchObject({
			failing: [],
			passing: 2,
			pending: ["unresolved-review-threads / unresolved-review-threads"],
			total: 3,
		});
	});

	it("keeps same-named checks from different workflows", () => {
		expect(
			summarizeChecks([
				{
					__typename: "CheckRun",
					completedAt: "2026-05-22T13:38:59Z",
					conclusion: "SUCCESS",
					name: "build",
					startedAt: "2026-05-22T13:38:48Z",
					status: "COMPLETED",
					workflowName: "release",
				},
				{
					__typename: "CheckRun",
					completedAt: "2026-05-22T13:39:04Z",
					conclusion: "FAILURE",
					name: "build",
					startedAt: "2026-05-22T13:38:49Z",
					status: "COMPLETED",
					workflowName: "ci",
				},
			]),
		).toMatchObject({
			failing: ["build (FAILURE)"],
			passing: 1,
			pending: [],
			total: 2,
		});
	});

	it("uses createdAt for status context supersession", () => {
		expect(
			summarizeChecks([
				{
					__typename: "StatusContext",
					context: "external/review",
					createdAt: "2026-05-22T13:16:49Z",
					state: "FAILURE",
				},
				{
					__typename: "StatusContext",
					context: "external/review",
					createdAt: "2026-05-22T13:39:07Z",
					state: "SUCCESS",
				},
			]),
		).toMatchObject({
			failing: [],
			passing: 1,
			pending: [],
			total: 1,
		});
	});

	it("uses rollup order when duplicate checks have no timestamps", () => {
		expect(
			summarizeChecks([
				{
					__typename: "CheckRun",
					conclusion: "FAILURE",
					name: "metadata",
					status: "COMPLETED",
					workflowName: "ci",
				},
				{
					__typename: "CheckRun",
					conclusion: "SUCCESS",
					name: "metadata",
					status: "COMPLETED",
					workflowName: "ci",
				},
			]),
		).toMatchObject({
			failing: [],
			passing: 1,
			pending: [],
			total: 1,
		});
	});

	it("builds latest-head-only PR check summaries from the latest commit rollup", () => {
		expect(LATEST_HEAD_CHECKS_QUERY).toContain("commits(last:1)");
		expect(LATEST_HEAD_CHECKS_QUERY).toContain("checkSuite");
		const page = extractLatestHeadCheckPage({
			data: {
				repository: {
					pullRequest: {
						baseRefName: "main",
						commits: {
							nodes: [
								{
									commit: {
										oid: "abc1234567890",
										statusCheckRollup: {
											contexts: {
												nodes: [
													{
														__typename: "CheckRun",
														checkSuite: {
															workflowRun: {
																workflow: {
																	name: "CI",
																},
															},
														},
														conclusion: "SUCCESS",
														name: "pr-checks",
														status: "COMPLETED",
													},
													{
														__typename: "CheckRun",
														conclusion: "FAILURE",
														name: "build-and-publish",
														status: "COMPLETED",
														workflowName: "GHCR Publish",
													},
												],
												pageInfo: {
													endCursor: "",
													hasNextPage: false,
												},
											},
										},
									},
								},
							],
						},
						headRefName: "release/v1.2.3",
						headRefOid: "abc1234567890",
						number: 123,
						title: "Release v1.2.3",
						url: "https://github.com/evalops/maestro-internal/pull/123",
					},
				},
			},
		});

		const report = formatLatestHeadCheckReport({
			...page.pr,
			checks: page.checks,
			repo: "evalops/maestro-internal",
		});

		expect(page.checks).toHaveLength(2);
		expect(report).toContain("Latest head: release/v1.2.3@abc123456789");
		expect(report).toContain("Checks: 1/2 pass, 1 failing");
		expect(report).toContain("build-and-publish (FAILURE)");
	});

	it("reports merged PRs as terminal instead of actionable", () => {
		const mergedPr = {
			autoMergeRequest: {},
			baseRefName: "main",
			isDraft: false,
			state: "MERGED",
		};
		const checkSummary = {
			failing: [],
			passing: 0,
			pending: ["coverage"],
			total: 1,
		};

		expect(autoMergeText(mergedPr)).toBe("merged");
		expect(
			nextAction({
				checkSummary,
				pr: mergedPr,
				unresolvedThreads: [{ id: "thread-1" }],
			}),
		).toBe("merged");
	});

	it("does not recommend auto-merge for stacked pull requests", () => {
		const stackedPr = {
			autoMergeRequest: null,
			baseRefName: "codex/native-a2a-pairing-20260515",
			isDraft: false,
			state: "OPEN",
		};
		const checkSummary = {
			failing: [],
			passing: 12,
			pending: [],
			total: 12,
		};

		expect(
			nextAction({
				checkSummary,
				pr: stackedPr,
				unresolvedThreads: [],
			}),
		).toBe(
			"stacked on codex/native-a2a-pairing-20260515: wait for parent or retarget",
		);
	});

	it("prioritizes stale branch updates before pending checks", () => {
		const stalePr = {
			autoMergeRequest: {},
			baseRefName: "main",
			isDraft: false,
			mergeStateStatus: "BEHIND",
			state: "OPEN",
		};
		const checkSummary = {
			failing: [],
			passing: 8,
			pending: ["coverage"],
			total: 9,
		};

		expect(
			nextAction({
				checkSummary,
				pr: stalePr,
				unresolvedThreads: [],
			}),
		).toBe("update branch from base");
	});

	it("renders a compact action checklist", () => {
		expect(
			markdownChecklist([
				{ nextAction: "merged", number: 1 },
				{ nextAction: "auto-merge armed", number: 2 },
				{ nextAction: "update branch from base", number: 3 },
				{ nextAction: "resolve review threads", number: 4 },
			]),
		).toBe(
			[
				"- [ ] #3: update branch from base",
				"- [ ] #4: resolve review threads",
			].join("\n"),
		);
	});
});

describe("prFeedbackAudit", () => {
	it("collects internal and public PR inputs into explicit audit targets", () => {
		const args = parseFeedbackAuditArgs([
			"--repo",
			"evalops/maestro-internal",
			"--also-public",
			"366",
			"1851",
		]);

		expect(
			collectFeedbackAuditTargets(args, "evalops/maestro-internal"),
		).toEqual([
			{ number: 1851, owner: "evalops", repo: "maestro-internal" },
			{ number: 366, owner: "evalops", repo: "maestro" },
		]);
	});

	it("accepts recent review-hygiene reports without explicit PR inputs", () => {
		const args = parseFeedbackAuditArgs([
			"--repo",
			"evalops/maestro-internal",
			"--recent-days",
			"3",
			"--limit",
			"50",
			"--check",
		]);

		expect(args.recentDays).toBe(3);
		expect(args.limit).toBe(50);
		expect(args.check).toBe(true);
		expect(args.prs).toEqual([]);
	});

	it("does not cap recent review-hygiene reports when --limit is omitted", () => {
		const args = parseFeedbackAuditArgs([
			"--repo",
			"evalops/maestro-internal",
			"--recent-days",
			"3",
			"--check",
		]);

		expect(args.recentDays).toBe(3);
		expect(args.limit).toBe(Number.MAX_SAFE_INTEGER);
		expect(args.check).toBe(true);
		expect(args.prs).toEqual([]);
	});

	it("keeps the package review-hygiene script uncapped for recent ships", () => {
		const packageJson = JSON.parse(
			readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
		) as { scripts?: Record<string, string> };
		const script = packageJson.scripts?.["review:unresolved-threads"] ?? "";

		expect(script).toContain("--recent-days 3");
		expect(script).not.toMatch(/--limit\b/);
		expect(script).toContain("--check");
		expect(script).toContain("--min-severity none");
	});

	it("keeps review-hygiene GitHub reads buffered for busy recent windows", () => {
		expect(GH_OUTPUT_MAX_BUFFER_BYTES).toBeGreaterThanOrEqual(64 * 1024 * 1024);
	});

	it("keeps the local pre-commit hook focused on staged checks", () => {
		const hook = readFileSync(
			new URL("../../.husky/pre-commit", import.meta.url),
			"utf8",
		);

		expect(hook).toContain("guardian.sh");
		expect(hook).toContain("git diff --cached --name-only");
		expect(hook).toContain("bunx biome check");
		// Comment may mention mapfile; ban actual bash-4 mapfile/readarray usage.
		expect(hook).not.toMatch(/(?:^|[\s;|&])mapfile(?:\s|$)/m);
		expect(hook).not.toMatch(/(?:^|[\s;|&])readarray(?:\s|$)/m);
		expect(hook).not.toContain("bun run build");
		expect(hook).not.toContain("bun run bun:compile");
	});

	it("classifies review feedback severity like the shared review-thread guard", () => {
		expect(reviewFeedbackSeverity("**High Severity**\nFix this")).toBe("high");
		expect(reviewFeedbackSeverity("P1: do not merge")).toBe("p1");
		expect(reviewFeedbackSeverity("📝 Info: optional follow-up")).toBe("none");
	});

	it("blocks review feedback audit only for unresolved severity at or above the threshold", () => {
		const infoThread = {
			comments: {
				nodes: [
					{
						author: { login: "devin-ai-integration" },
						body: "📝 **Info:** optional consideration",
					},
				],
			},
			isResolved: false,
		};
		const highThread = {
			comments: {
				nodes: [{ body: "🚩 **High Severity**\nFix before merge" }],
			},
			isResolved: false,
		};
		const unlabeledThread = {
			comments: {
				nodes: [{ body: "This should be addressed before merging." }],
			},
			isResolved: false,
		};

		expect(reviewThreadSeverity(infoThread)).toBe("none");
		expect(threadBlocksFeedbackAudit(infoThread)).toBe(false);
		expect(threadBlocksFeedbackAudit(infoThread, "none")).toBe(false);
		expect(reviewThreadSeverity(unlabeledThread)).toBe("none");
		expect(threadBlocksFeedbackAudit(unlabeledThread)).toBe(false);
		expect(threadBlocksFeedbackAudit(unlabeledThread, "none")).toBe(true);
		expect(threadBlocksFeedbackAudit(highThread)).toBe(true);
		expect(threadBlocksFeedbackAudit(highThread, "none")).toBe(true);
		expect(threadBlocksFeedbackAudit(highThread, "p1")).toBe(false);
	});

	it("ignores informational review summaries before computing blocking severity", () => {
		const informationalThread = {
			comments: {
				nodes: [
					{
						author: { login: "devin-ai-integration[bot]" },
						body: "## PR Summary\n\n**High Severity** appears in a summary sentence.",
					},
				],
			},
			isResolved: false,
		};

		expect(
			informationalReviewFeedback(
				informationalThread.comments.nodes[0].body,
				informationalThread.comments.nodes[0].author.login,
			),
		).toBe(true);
		expect(reviewThreadSeverity(informationalThread)).toBe("none");
		expect(threadBlocksFeedbackAudit(informationalThread)).toBe(false);
	});

	it("deduplicates explicit and recent review-hygiene targets", () => {
		expect(
			dedupeFeedbackAuditTargets([
				{ number: 2786, owner: "evalops", repo: "maestro-internal" },
				{ number: 2786, owner: "evalops", repo: "maestro-internal" },
				{ number: 781, owner: "evalops", repo: "maestro" },
			]),
		).toEqual([
			{ number: 2786, owner: "evalops", repo: "maestro-internal" },
			{ number: 781, owner: "evalops", repo: "maestro" },
		]);
	});

	it("paginates recent review-hygiene targets until the cutoff window", () => {
		const pageCalls: number[] = [];
		const perPageCalls: number[] = [];
		const recentIso = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
		const oldIso = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		const recentPulls = (start: number, count: number) =>
			Array.from({ length: count }, (_, offset) => ({
				number: start + offset,
				state: "open",
				updated_at: recentIso,
			}));
		const stubGhJson = (args: string[]) => {
			const route = args[3] ?? "";
			const pageMatch = route.match(/[?&]page=(\d+)/);
			const page = Number(pageMatch?.[1] ?? "1");
			const perPageMatch = route.match(/[?&]per_page=(\d+)/);
			perPageCalls.push(Number(perPageMatch?.[1] ?? "0"));
			pageCalls.push(page);
			switch (page) {
				case 1:
					return recentPulls(101, 100);
				case 2:
					return recentPulls(201, 100);
				case 3:
					return [
						{ number: 301, state: "closed", updated_at: oldIso },
						{ number: 302, state: "open", updated_at: oldIso },
					];
				default:
					return [];
			}
		};

		const targets = fetchRecentPullTargets(
			"evalops",
			"maestro-internal",
			3,
			250,
			stubGhJson,
		);

		expect(targets).toHaveLength(200);
		expect(targets[0]).toEqual({
			number: 101,
			owner: "evalops",
			repo: "maestro-internal",
		});
		expect(targets[199]).toEqual({
			number: 300,
			owner: "evalops",
			repo: "maestro-internal",
		});
		expect(pageCalls).toEqual([1, 2, 3]);
		expect(perPageCalls).toEqual([100, 100, 100]);
	});

	it("honors the recent review-hygiene limit as a total target cap", () => {
		const pageCalls: number[] = [];
		const perPageCalls: number[] = [];
		const recentIso = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
		const stubGhJson = (args: string[]) => {
			const route = args[3] ?? "";
			const pageMatch = route.match(/[?&]page=(\d+)/);
			const page = Number(pageMatch?.[1] ?? "1");
			const perPageMatch = route.match(/[?&]per_page=(\d+)/);
			perPageCalls.push(Number(perPageMatch?.[1] ?? "0"));
			pageCalls.push(page);
			return [
				{ number: page * 10 + 1, state: "open", updated_at: recentIso },
				{ number: page * 10 + 2, state: "open", updated_at: recentIso },
				{ number: page * 10 + 3, state: "open", updated_at: recentIso },
			];
		};

		expect(
			fetchRecentPullTargets("evalops", "maestro-internal", 3, 3, stubGhJson),
		).toEqual([
			{ number: 11, owner: "evalops", repo: "maestro-internal" },
			{ number: 12, owner: "evalops", repo: "maestro-internal" },
			{ number: 13, owner: "evalops", repo: "maestro-internal" },
		]);
		expect(pageCalls).toEqual([1]);
		expect(perPageCalls).toEqual([3]);
	});

	it("stops paginating when a full page yields no usable recent targets", () => {
		const pageCalls: number[] = [];
		const recentIso = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
		const stubGhJson = (args: string[]) => {
			const route = args[3] ?? "";
			const pageMatch = route.match(/[?&]page=(\d+)/);
			const page = Number(pageMatch?.[1] ?? "1");
			pageCalls.push(page);
			switch (page) {
				case 1:
					return Array.from({ length: 100 }, (_, offset) => ({
						number: 401 + offset,
						state: "open",
						updated_at: recentIso,
					}));
				case 2:
					return Array.from({ length: 100 }, (_, offset) => ({
						number: 501 + offset,
						state: "open",
						updated_at: "not-a-date",
					}));
				default:
					throw new Error("unexpected page request");
			}
		};

		const targets = fetchRecentPullTargets(
			"evalops",
			"maestro-internal",
			3,
			250,
			stubGhJson,
		);

		expect(targets).toHaveLength(100);
		expect(targets[0]).toEqual({
			number: 401,
			owner: "evalops",
			repo: "maestro-internal",
		});
		expect(targets[99]).toEqual({
			number: 500,
			owner: "evalops",
			repo: "maestro-internal",
		});
		expect(pageCalls).toEqual([1, 2]);
	});
});

describe("review feedback dashboard", () => {
	it("summarizes unresolved review debt by author, path, and staleness", () => {
		const summary = summarizeReviewFeedbackDashboard(
			[
				{
					target: { number: 2793, owner: "evalops", repo: "maestro-internal" },
					threads: [
						{
							id: "thread-old",
							isOutdated: false,
							isResolved: false,
							path: "src/runtime/env.ts",
							comments: {
								nodes: [
									{
										author: { login: "reviewer-a" },
										createdAt: "2026-06-16T00:00:00.000Z",
										url: "https://github.test/thread-old",
									},
								],
							},
						},
						{
							id: "thread-outdated",
							isOutdated: true,
							isResolved: false,
							path: "src/runtime/env.ts",
							comments: {
								nodes: [
									{
										author: { login: "reviewer-b" },
										createdAt: "2026-06-17T20:00:00.000Z",
										url: "https://github.test/thread-outdated",
									},
								],
							},
						},
						{
							id: "thread-resolved",
							isOutdated: false,
							isResolved: true,
							path: "README.md",
							comments: {
								nodes: [
									{
										author: { login: "reviewer-a" },
										createdAt: "2026-06-17T21:00:00.000Z",
									},
								],
							},
						},
					],
				},
			],
			{ now: new Date("2026-06-18T12:00:00.000Z"), staleHours: 24 },
		);

		expect(summary).toMatchObject({
			outdatedUnresolvedThreads: 1,
			pullRequests: 1,
			resolvedThreads: 1,
			totalThreads: 3,
			unresolvedThreads: 2,
		});
		expect(summary.topAuthors).toEqual([
			{ count: 1, key: "reviewer-a" },
			{ count: 1, key: "reviewer-b" },
		]);
		expect(summary.topPaths).toEqual([{ count: 2, key: "src/runtime/env.ts" }]);
		expect(summary.staleThreads).toHaveLength(1);

		const dashboard = formatReviewFeedbackDashboard(summary);
		expect(dashboard).toContain("# Review Feedback Dashboard");
		expect(dashboard).toContain("Threads: 3 total, 2 unresolved, 1 resolved");
		expect(dashboard).toContain("src/runtime/env.ts: 2 threads");
		expect(dashboard).toContain("evalops/maestro-internal#2793");
	});

	it("keeps the recent review dashboard available as a package script", () => {
		const packageJson = JSON.parse(
			readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
		) as { scripts?: Record<string, string> };

		expect(packageJson.scripts?.["review:feedback-dashboard"]).toContain(
			"pr-feedback-dashboard.mjs",
		);
		expect(packageJson.scripts?.["review:feedback-dashboard"]).toContain(
			"--recent-days 3",
		);
		expect(packageJson.scripts?.["review:feedback-dashboard"]).toContain(
			"--limit 50",
		);
	});

	it("caps recent dashboard discovery and exposes check thresholds", () => {
		const parsed = parseReviewFeedbackDashboardArgs([
			"--repo",
			"evalops/maestro-internal",
			"--recent-days",
			"3",
			"--check",
			"--max-unresolved",
			"1",
			"--max-stale",
			"0",
			"--max-outdated",
			"0",
			"--stale-hours",
			"12",
		]);

		expect(parsed.args.limit).toBe(50);
		expect(parsed.args.check).toBe(true);
		expect(parsed.staleHours).toBe(12);
		expect(parsed.thresholds).toEqual({
			maxOutdated: 0,
			maxStale: 0,
			maxUnresolved: 1,
		});

		expect(
			parseReviewFeedbackDashboardArgs([
				"--repo",
				"evalops/maestro-internal",
				"--recent-days",
				"3",
				"--limit",
				"7",
			]).args.limit,
		).toBe(7);
	});

	it("reports threshold failures for dashboard check mode", () => {
		const failures = evaluateReviewFeedbackDashboardThresholds(
			{
				outdatedUnresolvedThreads: 1,
				staleThreads: [{ id: "thread-old" }],
				unresolvedThreads: 2,
			},
			{ maxOutdated: 0, maxStale: 0, maxUnresolved: 1 },
		);

		expect(failures).toEqual([
			"unresolved review threads 2 exceeds 1",
			"stale review threads 1 exceeds 0",
			"outdated unresolved review threads 1 exceeds 0",
		]);
	});
});

describe("guardrail regression suite", () => {
	it("allows the native TUI install guide to name the root package", () => {
		const cutoverCheck = readFileSync(
			"scripts/check-package-cutover-readiness.js",
			"utf8",
		);

		expect(cutoverCheck).toContain(
			'"packages/tui-rs/docs/user-guide/01-getting-started.md"',
		);
	});

	it("keeps follow-up bug classes under a CI-wired manifest", () => {
		const packageJson = JSON.parse(
			readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
		) as { scripts?: Record<string, string> };
		const manifest = loadGuardrailManifest();
		const result = evaluateGuardrailManifest(manifest);

		expect(result.failures).toEqual([]);
		expect(result.guardrailCount).toBeGreaterThanOrEqual(5);
		expect(
			manifest.guardrails.map((entry: { id: string }) => entry.id),
		).toEqual(
			expect.arrayContaining([
				"runtime-env-semantic-scanner",
				"composed-skill-trust-boundary",
				"release-dispatch-idempotency",
				"opaque-git-parser-state",
				"bounded-output-and-json-repair",
				"a2a-ledger-evidence-parity",
			]),
		);
		expect(packageJson.scripts?.["lint:evals"]).toContain(
			"check:guardrail-regression-suite",
		);
	});

	it("fails when manifest evidence points at missing code", () => {
		const result = evaluateGuardrailManifest({
			schemaVersion: 1,
			guardrails: [
				{
					bugClass: "test",
					evidence: [
						{
							contains: ["definitely-not-present"],
							path: "package.json",
						},
					],
					id: "missing-evidence",
					owner: "test",
					title: "Missing evidence",
					why: "Prove negative path",
				},
			],
		});

		expect(result.ok).toBe(false);
		expect(result.failures.join("\n")).toContain("definitely-not-present");
	});

	it("fails when the manifest drops a required guardrail id", () => {
		const result = evaluateGuardrailManifest({
			schemaVersion: 1,
			guardrails: [
				{
					bugClass: "module-scope eager runtime snapshots",
					evidence: [
						{
							contains: ["runtime-env-semantic-scanner"],
							path: "scripts/guardrail-regression-suite.json",
						},
					],
					id: "runtime-env-semantic-scanner",
					owner: "runtime",
					title: "Semantic runtime-env snapshot scanner",
					why: "Keep one valid entry while proving the suite cannot shrink",
				},
			],
		});

		expect(result.ok).toBe(false);
		expect(result.failures).toEqual(
			expect.arrayContaining([
				"manifest is missing required guardrail id composed-skill-trust-boundary",
				"manifest is missing required guardrail id release-dispatch-idempotency",
				"manifest is missing required guardrail id opaque-git-parser-state",
				"manifest is missing required guardrail id bounded-output-and-json-repair",
				"manifest is missing required guardrail id a2a-ledger-evidence-parity",
			]),
		);
	});

	it("fails when manifest evidence allows forbidden or missing typed anchors", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-guardrail-manifest-"));
		writeFileSync(join(dir, "fixture.ts"), "const value = 'old-pattern';\n");
		const result = evaluateGuardrailManifest(
			{
				schemaVersion: 1,
				guardrails: [
					{
						bugClass: "test",
						evidence: [
							{
								matches: ["new-pattern"],
								notContains: ["old-pattern"],
								path: "fixture.ts",
							},
						],
						id: "typed-evidence",
						owner: "test",
						title: "Typed evidence",
						why: "Prove typed evidence failures",
					},
				],
			},
			{ root: dir },
		);

		expect(result.ok).toBe(false);
		expect(result.failures.join("\n")).toContain(
			'must not contain "old-pattern"',
		);
		expect(result.failures.join("\n")).toContain(
			'does not match "new-pattern"',
		);
	});
});

describe("runtime env snapshot hygiene", () => {
	const scanRuntimeEnvFixture = (lines: string[]) => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-runtime-env-corpus-"));
		writeFileSync(
			join(dir, "fixture.ts"),
			[
				'import { defaultRuntimeEnv } from "./runtime/env.js";',
				'import type { RuntimeEnv } from "./runtime/env.js";',
				...lines,
			].join("\n"),
			"utf8",
		);
		return scanRuntimeEnvSnapshotHygiene(dir).map(({ line, text }) => ({
			line,
			text,
		}));
	};

	it("blocks module-scope defaultRuntimeEnv snapshots", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-runtime-env-hygiene-"));
		mkdirSync(join(dir, "runtime"), { recursive: true });
		writeFileSync(
			join(dir, "telemetry.ts"),
			[
				'import { defaultRuntimeEnv } from "./runtime/env.js";',
				'import type { RuntimeEnv } from "./runtime/env.js";',
				"const exporterRuntimeEnv = defaultRuntimeEnv();",
				"const typedRuntimeEnv: RuntimeEnv = defaultRuntimeEnv();",
				"const { telemetryEnabled } = defaultRuntimeEnv();",
				"const {",
				"\ttelemetrySampleRate,",
				"} = defaultRuntimeEnv();",
				"configureRuntime(defaultRuntimeEnv());",
				"if (shouldConfigureRuntime) {",
				"\tconst runtimeMarker = /}/;",
				"\tconfigureRuntime();",
				"\tdefaultRuntimeEnv();",
				"}",
				"configureWrappedRuntime(",
				"\tdefaultRuntimeEnv(),",
				");",
				"class RuntimeBase extends makeBase(defaultRuntimeEnv()) {",
				"}",
				"class WrappedRuntimeBase extends makeBase(",
				"\tdefaultRuntimeEnv(),",
				") {",
				"}",
				"class ObjectRuntimeBase extends makeBase({",
				"\tenv: defaultRuntimeEnv(),",
				"}) {",
				"}",
				"export enum RuntimeEnum {",
				"\tFlag = defaultRuntimeEnv().telemetryEnabled ? 1 : 0,",
				"}",
				"class RuntimeSnapshotHolder {",
				'\tstatic stringMarker = "}";',
				"\tstatic templateMarker = `}`;",
				"\tstatic regexMarker = /}/;",
				"\tstatic env = defaultRuntimeEnv();",
				"\tstatic wrapped =",
				"\t\tdefaultRuntimeEnv();",
				"\tstatic {",
				"\t\tconfigureRuntime();",
				"\t\tdefaultRuntimeEnv();",
				"\t}",
				"\tstatic readEnv = () => defaultRuntimeEnv();",
				"\tstatic typedReadEnv: () => RuntimeEnv = () => defaultRuntimeEnv();",
				"\tstatic iifeEnv = (() => defaultRuntimeEnv())();",
				"\tstatic functionIifeEnv = function readEnv() { return defaultRuntimeEnv(); }();",
				'\tstatic [defaultRuntimeEnv().telemetryEnabled ? "enabled" : "disabled"]() {}',
				'\tstatic ["lazyReadEnv"]() { return defaultRuntimeEnv(); }',
				"\tstatic later() {",
				"\t\treturn defaultRuntimeEnv();",
				"\t}",
				"}",
				"function later() {",
				"\tclass LocalRuntimeSnapshotHolder {",
				"\t\tstatic env = defaultRuntimeEnv();",
				"\t}",
				"\tenum LocalRuntimeEnum {",
				"\t\tFlag = defaultRuntimeEnv().telemetryEnabled ? 1 : 0,",
				"\t}",
				"\tconst env = defaultRuntimeEnv();",
				"\treturn env;",
				"}",
				"export const readRuntimeEnv = (): RuntimeEnv => {",
				"\treturn defaultRuntimeEnv();",
				"};",
				"const iifeRuntimeEnv = (() => defaultRuntimeEnv())();",
				"const functionIifeRuntimeEnv = function readRuntimeEnvImmediately() {",
				"\treturn defaultRuntimeEnv();",
				"}();",
				"const memoizedReader = (() => {",
				'\treturn () => "ok";',
				"})();",
				"export const runtimeHelpers = {",
				"\treadEnv: () => defaultRuntimeEnv(),",
				"\tblockReadEnv: () => {",
				"\t\treturn defaultRuntimeEnv();",
				"\t},",
				"};",
				"export const runtimeHelperList = [() => defaultRuntimeEnv()];",
				"export const eagerRuntimeHelper = { env: defaultRuntimeEnv() };",
				"export const eagerRuntimeHelperIife = { env: (() => defaultRuntimeEnv())() };",
				"abstract class LazyAbstractRuntimeHolder {",
				"\tstatic readEnv() {",
				"\t\treturn defaultRuntimeEnv();",
				"\t}",
				"}",
			].join("\n"),
			"utf8",
		);

		expect(scanRuntimeEnvSnapshotHygiene(dir)).toEqual([
			expect.objectContaining({
				line: 3,
				text: "const exporterRuntimeEnv = defaultRuntimeEnv();",
			}),
			expect.objectContaining({
				line: 4,
				text: "const typedRuntimeEnv: RuntimeEnv = defaultRuntimeEnv();",
			}),
			expect.objectContaining({
				line: 5,
				text: "const { telemetryEnabled } = defaultRuntimeEnv();",
			}),
			expect.objectContaining({
				line: 6,
				text: "const { telemetrySampleRate, } = defaultRuntimeEnv();",
			}),
			expect.objectContaining({
				line: 9,
				text: "configureRuntime(defaultRuntimeEnv());",
			}),
			expect.objectContaining({
				line: 10,
				text: "if (shouldConfigureRuntime) { const runtimeMarker = /}/; configureRuntime(); defaultRuntimeEnv(); }",
			}),
			expect.objectContaining({
				line: 15,
				text: "configureWrappedRuntime( defaultRuntimeEnv(), );",
			}),
			expect.objectContaining({
				line: 18,
				text: "class RuntimeBase extends makeBase(defaultRuntimeEnv()) {",
			}),
			expect.objectContaining({
				line: 20,
				text: "class WrappedRuntimeBase extends makeBase( defaultRuntimeEnv(), ) {",
			}),
			expect.objectContaining({
				line: 24,
				text: "class ObjectRuntimeBase extends makeBase({ env: defaultRuntimeEnv(), }) {",
			}),
			expect.objectContaining({
				line: 28,
				text: "export enum RuntimeEnum { Flag = defaultRuntimeEnv().telemetryEnabled ? 1 : 0, }",
			}),
			expect.objectContaining({
				line: 35,
				text: "static env = defaultRuntimeEnv();",
			}),
			expect.objectContaining({
				line: 36,
				text: "static wrapped = defaultRuntimeEnv();",
			}),
			expect.objectContaining({
				line: 38,
				text: "static { configureRuntime(); defaultRuntimeEnv(); }",
			}),
			expect.objectContaining({
				line: 44,
				text: "static iifeEnv = (() => defaultRuntimeEnv())();",
			}),
			expect.objectContaining({
				line: 45,
				text: "static functionIifeEnv = function readEnv() { return defaultRuntimeEnv(); }();",
			}),
			expect.objectContaining({
				line: 46,
				text: 'static [defaultRuntimeEnv().telemetryEnabled ? "enabled" : "disabled"]() {}',
			}),
			expect.objectContaining({
				line: 65,
				text: "const iifeRuntimeEnv = (() => defaultRuntimeEnv())();",
			}),
			expect.objectContaining({
				line: 66,
				text: "const functionIifeRuntimeEnv = function readRuntimeEnvImmediately() { return defaultRuntimeEnv(); }();",
			}),
			expect.objectContaining({
				line: 79,
				text: "export const eagerRuntimeHelper = { env: defaultRuntimeEnv() };",
			}),
			expect.objectContaining({
				line: 80,
				text: "export const eagerRuntimeHelperIife = { env: (() => defaultRuntimeEnv())() };",
			}),
		]);
	});

	it("classifies eager and lazy runtime-env fixture corpus", () => {
		const cases: Array<{
			expected: Array<{ line: number; text: string }>;
			lines: string[];
			name: string;
		}> = [
			{
				name: "top-level export default",
				lines: ["export default defaultRuntimeEnv();"],
				expected: [{ line: 3, text: "export default defaultRuntimeEnv();" }],
			},
			{
				name: "top-level tagged template expression",
				lines: [
					"const telemetryLabel = `enabled:${defaultRuntimeEnv().telemetryEnabled}`;",
				],
				expected: [
					{
						line: 3,
						text: "const telemetryLabel = `enabled:${defaultRuntimeEnv().telemetryEnabled}`;",
					},
				],
			},
			{
				name: "top-level object computed key",
				lines: [
					'const keyedRuntime = { [defaultRuntimeEnv().telemetryEnabled ? "on" : "off"]: true };',
				],
				expected: [
					{
						line: 3,
						text: 'const keyedRuntime = { [defaultRuntimeEnv().telemetryEnabled ? "on" : "off"]: true };',
					},
				],
			},
			{
				name: "namespace defaultRuntimeEnv call",
				lines: [
					'import * as runtimeEnv from "./runtime/env.js";',
					"const env = runtimeEnv.defaultRuntimeEnv();",
				],
				expected: [
					{
						line: 4,
						text: "const env = runtimeEnv.defaultRuntimeEnv();",
					},
				],
			},
			{
				name: "instance computed class member name",
				lines: [
					"class RuntimeSnapshotHolder {",
					'\t[defaultRuntimeEnv().telemetryEnabled ? "enabled" : "disabled"]() {}',
					"}",
				],
				expected: [
					{
						line: 4,
						text: '[defaultRuntimeEnv().telemetryEnabled ? "enabled" : "disabled"]() {}',
					},
				],
			},
			{
				name: "eager static block iife",
				lines: [
					"class RuntimeSnapshotHolder {",
					"\tstatic {",
					"\t\t(() => defaultRuntimeEnv())();",
					"\t}",
					"}",
				],
				expected: [
					{
						line: 4,
						text: "static { (() => defaultRuntimeEnv())(); }",
					},
				],
			},
			{
				name: "iife default parameter snapshot",
				lines: [
					"const env = ((snapshot = defaultRuntimeEnv()) => snapshot)();",
				],
				expected: [
					{
						line: 3,
						text: "const env = ((snapshot = defaultRuntimeEnv()) => snapshot)();",
					},
				],
			},
			{
				name: "function call iife snapshot",
				lines: [
					"const env = (function readNow() { return defaultRuntimeEnv(); }).call(undefined);",
				],
				expected: [
					{
						line: 3,
						text: "const env = (function readNow() { return defaultRuntimeEnv(); }).call(undefined);",
					},
				],
			},
			{
				name: "arrow apply iife snapshot",
				lines: ["const env = (() => defaultRuntimeEnv()).apply(undefined);"],
				expected: [
					{
						line: 3,
						text: "const env = (() => defaultRuntimeEnv()).apply(undefined);",
					},
				],
			},
			{
				name: "eagerly constructed class expression instance field",
				lines: [
					"const holder = new (class {",
					"\tfield = defaultRuntimeEnv();",
					"})();",
				],
				expected: [
					{
						line: 4,
						text: "field = defaultRuntimeEnv();",
					},
				],
			},
			{
				name: "eagerly constructed class expression constructor parameter",
				lines: [
					"const holder = new (class {",
					"\tconstructor(env = defaultRuntimeEnv()) {",
					"\t\tvoid env;",
					"\t}",
					"})();",
				],
				expected: [
					{
						line: 4,
						text: "constructor(env = defaultRuntimeEnv()) { void env; }",
					},
				],
			},
			{
				name: "eagerly constructed class expression constructor body",
				lines: [
					"const holder = new (class {",
					"\tconstructor() {",
					"\t\tdefaultRuntimeEnv();",
					"\t}",
					"})();",
				],
				expected: [
					{
						line: 4,
						text: "constructor() { defaultRuntimeEnv(); }",
					},
				],
			},
			{
				name: "eagerly constructed function expression default parameter",
				lines: [
					"const holder = new (function RuntimeSnapshotHolder(",
					"\tenv = defaultRuntimeEnv(),",
					") {",
					"\tvoid env;",
					"})();",
				],
				expected: [
					{
						line: 3,
						text: "function RuntimeSnapshotHolder( env = defaultRuntimeEnv(), ) { void env; }",
					},
				],
			},
			{
				name: "eagerly constructed function expression body",
				lines: [
					"const holder = new (function RuntimeSnapshotHolder() {",
					"\tdefaultRuntimeEnv();",
					"})();",
				],
				expected: [
					{
						line: 3,
						text: "function RuntimeSnapshotHolder() { defaultRuntimeEnv(); }",
					},
				],
			},
			{
				name: "eagerly constructed class expression nested static field",
				lines: [
					"const holder = new (class {",
					"\tnested = class {",
					"\t\tstatic env = defaultRuntimeEnv();",
					"\t};",
					"})();",
				],
				expected: [
					{
						line: 5,
						text: "static env = defaultRuntimeEnv();",
					},
				],
			},
			{
				name: "lazy module and class readers",
				lines: [
					"export const readRuntimeEnv = (): RuntimeEnv => defaultRuntimeEnv();",
					"const runtimeHelpers = {",
					"\treadEnv: () => defaultRuntimeEnv(),",
					"\tblockReadEnv: () => {",
					"\t\treturn defaultRuntimeEnv();",
					"\t},",
					"};",
					"class RuntimeSnapshotHolder {",
					"\tstatic readEnv() {",
					"\t\treturn defaultRuntimeEnv();",
					"\t}",
					"\tstatic {",
					"\t\tconst later = () => defaultRuntimeEnv();",
					"\t\tvoid later;",
					"\t}",
					"}",
					"class LazyInstanceHolder {",
					"\tfield = defaultRuntimeEnv();",
					"}",
				],
				expected: [],
			},
			{
				name: "module-scope new inline class instance field",
				lines: [
					"const runtimeEnvHolder = new (class RuntimeSnapshotHolder {",
					"\tenv = defaultRuntimeEnv();",
					"})();",
				],
				expected: [
					{
						line: 4,
						text: "env = defaultRuntimeEnv();",
					},
				],
			},
		];

		for (const testCase of cases) {
			expect(scanRuntimeEnvFixture(testCase.lines), testCase.name).toEqual(
				testCase.expected,
			);
		}
	});

	it("keeps the runtime-env guardrail AST-backed and CI-wired", () => {
		const packageJson = JSON.parse(
			readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
		) as { scripts?: Record<string, string> };
		const scanner = readFileSync(
			new URL(
				"../../scripts/check-runtime-env-snapshot-hygiene.mjs",
				import.meta.url,
			),
			"utf8",
		);
		const runtimeEnvTests = readFileSync(
			new URL("../../test/runtime/env.test.ts", import.meta.url),
			"utf8",
		);

		expect(scanner).toContain('from "typescript"');
		expect(scanner).toContain("ts.createSourceFile");
		expect(scanner).not.toContain("DEFAULT_RUNTIME_ENV_CALL_PATTERN");
		expect(packageJson.scripts?.["lint:evals"]).toContain(
			"check:runtime-env-snapshot-hygiene",
		);
		expect(runtimeEnvTests).toContain("MAESTRO_RUNTIME_ENV_STRICT_BOOTSTRAP");
		expect(runtimeEnvTests).toContain(
			"defaultRuntimeEnv() was read before loadAndFinalizeEnv() completed",
		);
	});
});

describe("evaluateReadiness", () => {
	const cleanPr = {
		headRefOid: "abc123",
		isDraft: false,
		mergeStateStatus: "CLEAN",
		mergeable: "MERGEABLE",
		state: "OPEN",
		statusCheckRollup: [
			{
				__typename: "CheckRun",
				conclusion: "SUCCESS",
				name: "ci",
				status: "COMPLETED",
			},
			{
				__typename: "CheckRun",
				conclusion: "SKIPPED",
				name: "optional-evals",
				status: "COMPLETED",
			},
			{
				__typename: "StatusContext",
				context: "legacy/status",
				state: "SUCCESS",
			},
		],
	};

	it("accepts clean PR state", () => {
		expect(
			evaluateReadiness({
				pr: cleanPr,
				reviewThreads: [{ id: "thread-1", isResolved: true }],
				expectedHeadSha: "abc123",
			}).ready,
		).toBe(true);
	});

	it("rejects unresolved review threads", () => {
		const result = evaluateReadiness({
			pr: cleanPr,
			reviewThreads: [
				{
					comments: { nodes: [{ url: "https://example.test/thread" }] },
					id: "thread-1",
					isResolved: false,
					line: 12,
					path: "src/file.ts",
				},
			],
		});
		expect(result.ready).toBe(false);
		expect(result.failures.join("\n")).toContain(
			"Unresolved review thread thread-1",
		);
	});

	it("accepts a thread Bugbot Autofix resolved as a false positive", () => {
		const result = evaluateReadiness({
			pr: cleanPr,
			reviewThreads: [
				{
					comments: {
						nodes: [
							{
								author: { login: "cursor[bot]" },
								body: "### Finding\n\n**High Severity**\n",
								url: "https://example.test/thread",
							},
							{
								author: { login: "cursor[bot]" },
								body: "[Bugbot Autofix](https://cursor.com/docs/bugbot#autofix) determined this is a false positive.",
							},
						],
					},
					id: "thread-1",
					isResolved: false,
					line: 12,
					path: "src/file.ts",
				},
			],
		});
		expect(result.ready).toBe(true);
	});

	it("accepts a thread Bugbot Autofix resolved by an applied-fix disposition", () => {
		const result = evaluateReadiness({
			pr: cleanPr,
			reviewThreads: [
				{
					comments: {
						nodes: [
							{
								author: { login: "cursor[bot]" },
								body: "### Cancel guard ignores canonical states\n\n**High Severity**\n",
								url: "https://example.test/thread",
							},
						],
					},
					id: "thread-1",
					isResolved: false,
					line: 88,
					path: "packages/control-plane-rs/src/a2a/tasks.rs",
				},
			],
			bugbotFixedTitles: new Set(["Cancel guard ignores canonical states"]),
		});
		expect(result.ready).toBe(true);
	});

	it("still rejects a finding whose title is not in the applied-fix set", () => {
		const result = evaluateReadiness({
			pr: cleanPr,
			reviewThreads: [
				{
					comments: {
						nodes: [
							{
								author: { login: "cursor[bot]" },
								body: "### Some other bug\n\n**High Severity**\n",
								url: "https://example.test/thread",
							},
						],
					},
					id: "thread-1",
					isResolved: false,
					line: 88,
					path: "src/file.ts",
				},
			],
			bugbotFixedTitles: new Set(["Cancel guard ignores canonical states"]),
		});
		expect(result.ready).toBe(false);
	});

	it("rejects stale heads and pending or failed checks", () => {
		const result = evaluateReadiness({
			pr: {
				...cleanPr,
				headRefOid: "new-head",
				statusCheckRollup: [
					{
						__typename: "CheckRun",
						conclusion: "",
						name: "coverage",
						status: "IN_PROGRESS",
					},
					{
						__typename: "StatusContext",
						context: "security",
						state: "FAILURE",
					},
				],
			},
			reviewThreads: [],
			expectedHeadSha: "old-head",
			strictStatusChecks: true,
		});
		expect(result.ready).toBe(false);
		expect(result.failures).toContain(
			"PR head is new-head, expected old-head.",
		);
		expect(result.failures).toContain("coverage: in_progress");
		expect(result.failures).toContain("security: failure");
	});

	it("warns instead of failing optional checks when required metadata is unavailable", () => {
		const result = evaluateReadiness({
			pr: {
				...cleanPr,
				statusCheckRollup: [
					{
						__typename: "CheckRun",
						conclusion: "",
						name: "Cursor Bugbot",
						status: "IN_PROGRESS",
					},
				],
			},
			requiredStatusChecks: null,
			reviewThreads: [],
		});
		expect(result.ready).toBe(true);
		expect(result.warnings.join("\n")).toContain(
			"Required status-check metadata was unavailable",
		);
		expect(result.warnings.join("\n")).toContain("Cursor Bugbot: in_progress");
	});

	it("warns on optional pending checks when required checks pass", () => {
		const result = evaluateReadiness({
			pr: {
				...cleanPr,
				mergeStateStatus: "UNSTABLE",
				statusCheckRollup: [
					{
						__typename: "CheckRun",
						conclusion: "SUCCESS",
						name: "coverage",
						status: "COMPLETED",
					},
					{
						__typename: "CheckRun",
						conclusion: "",
						name: "Cursor Bugbot",
						status: "IN_PROGRESS",
					},
				],
			},
			requiredStatusChecks: ["coverage"],
			reviewThreads: [],
		});
		expect(result.ready).toBe(true);
		expect(result.warnings.join("\n")).toContain("Cursor Bugbot: in_progress");
	});

	it("loads all paginated review-thread pages", () => {
		const calls: string[][] = [];
		const pages = [
			{
				data: {
					repository: {
						pullRequest: {
							reviewThreads: {
								nodes: [{ id: "thread-1", isResolved: true }],
								pageInfo: { endCursor: "cursor-1", hasNextPage: true },
							},
						},
					},
				},
			},
			{
				data: {
					repository: {
						pullRequest: {
							reviewThreads: {
								nodes: [{ id: "thread-2", isResolved: false }],
								pageInfo: { endCursor: null, hasNextPage: false },
							},
						},
					},
				},
			},
		];

		const threads = fetchReviewThreads(
			"evalops",
			"maestro-internal",
			1775,
			(args) => {
				calls.push(args);
				return pages[calls.length - 1];
			},
		);

		expect(threads.map((thread) => thread.id)).toEqual([
			"thread-1",
			"thread-2",
		]);
		expect(calls).toHaveLength(2);
		expect(calls[0]).not.toContain("after=cursor-1");
		expect(calls[1]).toContain("after=cursor-1");
	});

	it("encodes protected branch names before fetching required checks", () => {
		const calls: string[][] = [];
		const checks = fetchRequiredStatusChecks(
			"evalops/maestro",
			"release/2026.05",
			(args) => {
				calls.push(args);
				return {
					checks: [{ context: "CI" }],
					contexts: ["legacy/status"],
				};
			},
		);

		expect(checks).toEqual(["legacy/status", "CI"]);
		expect(calls[0]).toContain(
			"repos/evalops/maestro/branches/release%2F2026.05/protection/required_status_checks",
		);
	});

	it("normalizes gh repo arguments before API calls", () => {
		expect(parseRepoSpec("evalops/maestro")).toEqual({
			host: "",
			name: "maestro",
			nameWithOwner: "evalops/maestro",
			owner: "evalops",
		});
		expect(parseRepoSpec("github.example.com/evalops/maestro")).toEqual({
			host: "github.example.com",
			name: "maestro",
			nameWithOwner: "evalops/maestro",
			owner: "evalops",
		});
		expect(() => parseRepoSpec("evalops")).toThrow(
			"Expected repo as [host/]owner/name",
		);
		expect(() => parseRepoSpec("a/b/c/d")).toThrow(
			"Expected repo as [host/]owner/name",
		);
	});

	it("parses only bare PR numbers or canonical pull request URLs", () => {
		expect(prNumberFromInput("1775")).toBe(1775);
		expect(
			prNumberFromInput("https://github.com/evalops/maestro/pull/325"),
		).toBe(325);
		expect(
			prNumberFromInput("https://github.com/evalops/maestro/pull/325/files"),
		).toBe(325);
		expect(() =>
			prNumberFromInput("https://github.com/evalops/maestro/issues/99"),
		).toThrow("Could not parse pull request number");
		expect(() => prNumberFromInput("1775/files")).toThrow(
			"Could not parse pull request number",
		);
		expect(() =>
			prNumberFromInput("https://example.test/2026/pull/not-a-pr"),
		).toThrow("Could not parse pull request number");
	});
});

describe("public mirror review debt gate", () => {
	it("allows missing generated mirror PRs", () => {
		expect(
			evaluatePublicMirrorReviewDebt({
				pulls: [],
				reviewThreadsByPr: new Map(),
			}).ok,
		).toBe(true);
	});

	it("blocks stale public mirror branch updates when review threads are unresolved", () => {
		const result = evaluatePublicMirrorReviewDebt({
			pulls: [
				{
					html_url: "https://github.com/evalops/maestro/pull/123",
					number: 123,
					title: "chore: sync public mirror from internal",
				},
			],
			reviewThreadsByPr: new Map([
				[
					123,
					[
						{
							comments: {
								nodes: [
									{
										url: "https://github.com/evalops/maestro/pull/123#discussion_r1",
									},
								],
							},
							id: "thread-1",
							isResolved: false,
							path: "src/tools/apply-patch.ts",
						},
					],
				],
			]),
		});

		expect(result.ok).toBe(false);
		expect(result.failures.join("\n")).toContain(
			"evalops/maestro#123 has 1 unresolved review thread",
		);
		expect(result.failures.join("\n")).toContain(
			"https://github.com/evalops/maestro/pull/123#discussion_r1",
		);
	});

	it("parses public mirror pull API responses", () => {
		expect(
			parsePublicMirrorPulls([
				{
					html_url: "https://github.com/evalops/maestro/pull/456",
					number: 456,
					title: "sync",
				},
			]),
		).toEqual([
			{
				html_url: "https://github.com/evalops/maestro/pull/456",
				number: 456,
				title: "sync",
			},
		]);
	});

	const bugbotFinding = {
		author: { login: "cursor[bot]" },
		body: "### Guardrail CLI entry never runs\n\n**High Severity**\n",
		url: "https://github.com/evalops/maestro/pull/792#discussion_r1",
	};
	const bugbotFalsePositive = {
		author: { login: "cursor[bot]" },
		body: "[Bugbot Autofix](https://cursor.com/docs/bugbot#autofix) determined this is a false positive.\n\nVerified that the guard still runs.",
		url: "https://github.com/evalops/maestro/pull/792#discussion_r2",
	};

	it("does not block when Bugbot Autofix resolved its own finding as a false positive", () => {
		const result = evaluatePublicMirrorReviewDebt({
			pulls: [
				{
					html_url: "https://github.com/evalops/maestro/pull/792",
					number: 792,
					title: "chore: sync public mirror from internal",
				},
			],
			reviewThreadsByPr: new Map([
				[
					792,
					[
						{
							comments: { nodes: [bugbotFinding, bugbotFalsePositive] },
							id: "PRRT_1",
							isResolved: false,
							path: "scripts/check-guardrail-regression-suite.mjs",
						},
					],
				],
			]),
		});

		expect(result.ok).toBe(true);
		expect(result.failures).toEqual([]);
	});

	it("still blocks when a human replied after the Bugbot false-positive disposition", () => {
		const humanReply = {
			author: { login: "haasonsaas" },
			body: "No, this is still broken on my end.",
			url: "https://github.com/evalops/maestro/pull/792#discussion_r3",
		};
		const result = evaluatePublicMirrorReviewDebt({
			pulls: [
				{
					html_url: "https://github.com/evalops/maestro/pull/792",
					number: 792,
					title: "chore: sync public mirror from internal",
				},
			],
			reviewThreadsByPr: new Map([
				[
					792,
					[
						{
							comments: {
								nodes: [bugbotFinding, bugbotFalsePositive, humanReply],
							},
							id: "PRRT_1",
							isResolved: false,
							path: "scripts/check-guardrail-regression-suite.mjs",
						},
					],
				],
			]),
		});

		expect(result.ok).toBe(false);
		expect(result.failures.join("\n")).toContain(
			"evalops/maestro#792 has 1 unresolved review thread",
		);
	});

	it("still blocks a Bugbot finding that was not marked a false positive", () => {
		const appliedFix = {
			author: { login: "cursor[bot]" },
			body: "[Bugbot Autofix](https://cursor.com/docs/bugbot#autofix) applied a fix.",
			url: "https://github.com/evalops/maestro/pull/792#discussion_r2",
		};
		const result = evaluatePublicMirrorReviewDebt({
			pulls: [
				{
					html_url: "https://github.com/evalops/maestro/pull/792",
					number: 792,
					title: "chore: sync public mirror from internal",
				},
			],
			reviewThreadsByPr: new Map([
				[
					792,
					[
						{
							comments: { nodes: [bugbotFinding, appliedFix] },
							id: "PRRT_1",
							isResolved: false,
							path: "scripts/check-guardrail-regression-suite.mjs",
						},
					],
				],
			]),
		});

		expect(result.ok).toBe(false);
	});

	it("does not block when Bugbot Autofix prepared a fix for the finding by title", () => {
		const finding = {
			author: { login: "cursor[bot]" },
			body: "### Cancel guard ignores canonical states\n\n**High Severity**\n",
			url: "https://github.com/evalops/maestro/pull/791#discussion_r1",
		};
		const result = evaluatePublicMirrorReviewDebt({
			pulls: [
				{
					html_url: "https://github.com/evalops/maestro/pull/791",
					number: 791,
					title: "chore: sync public mirror from internal",
				},
			],
			reviewThreadsByPr: new Map([
				[
					791,
					[
						{
							comments: { nodes: [finding] },
							id: "PRRT_1",
							isResolved: false,
							path: "packages/control-plane-rs/src/a2a/tasks.rs",
						},
					],
				],
			]),
			bugbotFixedTitlesByPr: new Map([
				[791, new Set(["Cancel guard ignores canonical states"])],
			]),
		});

		expect(result.ok).toBe(true);
		expect(result.failures).toEqual([]);
	});
});

describe("isBugbotAutofixFalsePositive", () => {
	it("recognizes a Bugbot false-positive disposition as the last comment", () => {
		expect(
			isBugbotAutofixFalsePositive({
				comments: {
					nodes: [
						{
							author: { login: "cursor" },
							body: "[Bugbot Autofix](x) determined this is a false positive.",
						},
					],
				},
			}),
		).toBe(true);
	});

	it("accepts both cursor and cursor[bot] author logins", () => {
		for (const login of ["cursor", "cursor[bot]", "Cursor", "Cursor[bot]"]) {
			expect(
				isBugbotAutofixFalsePositive({
					comments: {
						nodes: [
							{ author: { login }, body: "Bugbot Autofix: false-positive" },
						],
					},
				}),
			).toBe(true);
		}
	});

	it("is false when the last comment is a human reply", () => {
		expect(
			isBugbotAutofixFalsePositive({
				comments: {
					nodes: [
						{
							author: { login: "cursor[bot]" },
							body: "Bugbot Autofix determined this is a false positive.",
						},
						{ author: { login: "haasonsaas" }, body: "still broken" },
					],
				},
			}),
		).toBe(false);
	});

	it("is false for a Bugbot applied-fix disposition that is not a false positive", () => {
		expect(
			isBugbotAutofixFalsePositive({
				comments: {
					nodes: [
						{
							author: { login: "cursor[bot]" },
							body: "[Bugbot Autofix](x) applied a fix in commit abc.",
						},
					],
				},
			}),
		).toBe(false);
	});

	it("is false when there are no comments", () => {
		expect(isBugbotAutofixFalsePositive({ comments: { nodes: [] } })).toBe(
			false,
		);
		expect(isBugbotAutofixFalsePositive(undefined)).toBe(false);
	});
});

describe("Bugbot Autofix applied-fix disposition", () => {
	const multiFixComment = {
		body: "<!-- BUGBOT_AUTOFIX_COMMENT -->\n<!-- BACKGROUND_AGENT_BC_ID:bc-x -->\n[Bugbot Autofix](https://cursor.com/docs/bugbot#autofix) prepared fixes for both issues found in the latest run.\n\n- ✅ Fixed: **Cancel guard ignores canonical states**\n  - desc\n- ✅ Fixed: **Compound secret keys not redacted**\n  - desc\n",
	};

	describe("parseBugbotAutofixFixedTitles", () => {
		it("extracts every ✅ Fixed title from applied-fix comments", () => {
			const titles = parseBugbotAutofixFixedTitles([
				multiFixComment,
				{ body: "a human comment" },
				{
					body: "<!-- BUGBOT_AUTOFIX_COMMENT -->\n[Bugbot Autofix](x) prepared a fix for the issue found in the latest run.\n\n- ✅ Fixed: **Learner reload reapplies transient patterns**\n",
				},
			]);
			expect(titles).toEqual(
				new Set([
					"Cancel guard ignores canonical states",
					"Compound secret keys not redacted",
					"Learner reload reapplies transient patterns",
				]),
			);
		});

		it("ignores non-Bugbot comments and false-positive dispositions", () => {
			expect(
				parseBugbotAutofixFixedTitles([
					{ body: "regular review comment" },
					{
						body: "[Bugbot Autofix](x) determined this is a false positive.\n- ✅ Fixed: **should not match**\n",
					},
				]),
			).toEqual(new Set());
		});

		it("is empty for null/undefined input", () => {
			expect(parseBugbotAutofixFixedTitles(undefined)).toEqual(new Set());
			expect(parseBugbotAutofixFixedTitles(null)).toEqual(new Set());
		});
	});

	describe("reviewThreadFindingTitle", () => {
		it("extracts the heading title from a finding comment", () => {
			expect(
				reviewThreadFindingTitle({
					comments: {
						nodes: [
							{
								body: "### Release dispatch count misses new runs\n\n**Medium**",
							},
						],
					},
				}),
			).toBe("Release dispatch count misses new runs");
		});

		it("returns null when the first comment has no heading", () => {
			expect(
				reviewThreadFindingTitle({
					comments: { nodes: [{ body: "looks good to me" }] },
				}),
			).toBeNull();
			expect(reviewThreadFindingTitle(undefined)).toBeNull();
		});
	});

	describe("isBugbotAutofixResolvedByFix", () => {
		const fixed = new Set(["Cancel guard ignores canonical states"]);
		const thread = (title) => ({
			comments: { nodes: [{ body: `### ${title}\n\n**High**` }] },
		});

		it("is true when the finding title was reported fixed", () => {
			expect(
				isBugbotAutofixResolvedByFix(
					thread("Cancel guard ignores canonical states"),
					fixed,
				),
			).toBe(true);
		});

		it("is false for an unmatched finding", () => {
			expect(
				isBugbotAutofixResolvedByFix(thread("Some other bug"), fixed),
			).toBe(false);
		});

		it("is false when there are no fixed titles", () => {
			expect(
				isBugbotAutofixResolvedByFix(
					thread("Cancel guard ignores canonical states"),
					new Set(),
				),
			).toBe(false);
			expect(
				isBugbotAutofixResolvedByFix(
					thread("Cancel guard ignores canonical states"),
					undefined,
				),
			).toBe(false);
		});
	});

	describe("threadBlocksAfterBugbotDisposition", () => {
		const fixed = new Set(["Fixed bug"]);
		const finding = (title) => ({
			isResolved: false,
			comments: { nodes: [{ body: `### ${title}\n\n**High**` }] },
		});

		it("does not block a GitHub-resolved thread", () => {
			expect(
				threadBlocksAfterBugbotDisposition({ isResolved: true }, fixed),
			).toBe(false);
		});

		it("does not block a false-positive thread", () => {
			expect(
				threadBlocksAfterBugbotDisposition(
					{
						isResolved: false,
						comments: {
							nodes: [
								{ author: { login: "cursor[bot]" }, body: "finding" },
								{
									author: { login: "cursor[bot]" },
									body: "Bugbot Autofix determined this is a false positive.",
								},
							],
						},
					},
					fixed,
				),
			).toBe(false);
		});

		it("does not block an applied-fix thread matched by title", () => {
			expect(
				threadBlocksAfterBugbotDisposition(finding("Fixed bug"), fixed),
			).toBe(false);
		});

		it("blocks an unrelated unresolved finding", () => {
			expect(
				threadBlocksAfterBugbotDisposition(finding("Other bug"), fixed),
			).toBe(true);
		});
	});
});
