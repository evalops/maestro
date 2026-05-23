import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	evaluatePublicMirrorReviewDebt,
	parsePublicMirrorPulls,
} from "../../scripts/check-public-mirror-review-debt.mjs";
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
	collectFeedbackAuditTargets,
	parseFeedbackAuditArgs,
} from "../../scripts/pr-feedback-audit.mjs";
import {
	evaluateReadiness,
	fetchRequiredStatusChecks,
	fetchReviewThreads,
	parseRepoSpec,
	prNumberFromInput,
} from "../../scripts/pr-ready-to-merge.mjs";
import {
	publicMirrorRefCandidates,
	resolvePublicMirrorRef,
} from "../../scripts/resolve-public-mirror-ref.mjs";

type WorkflowStep = {
	if?: string;
	name?: string;
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
	"timeout-minutes"?: number;
};

type Workflow = {
	concurrency?: {
		"cancel-in-progress"?: boolean | string;
		group?: string;
	};
	jobs?: Record<
		string,
		{
			outputs?: Record<string, unknown>;
			steps?: WorkflowStep[];
			"timeout-minutes"?: number;
			"runs-on"?: unknown;
		}
	>;
};

type ProjectConfig = {
	targets?: Record<string, { dependsOn?: string[] }>;
};

type NxTargetTimingRow = {
	durationMs: number;
	status: string;
	target: string;
};

function isPublicValidationWorkflow(workflow: Workflow): boolean {
	const runsOnValues = Object.values(workflow.jobs ?? {}).map((job) =>
		String(job["runs-on"] ?? ""),
	);
	return (
		runsOnValues.some((runsOn) =>
			runsOn.includes("PUBLIC_PR_VALIDATION_RUNNER"),
		) && !workflow.jobs?.["public-release-mirror"]
	);
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
					"scripts/install-smoke-utils.js",
					"scripts/ci-nx-tests.sh",
					"scripts/plan-ci-checks.mjs",
					"scripts/plan-nx-test-command.mjs",
					"scripts/release-readiness.js",
					"scripts/smoke-packed-cli.js",
					"scripts/workspace-utils.js",
					"test/scripts/ci-guardrails.test.ts",
					"test/scripts/workspace-utils.test.ts",
				],
			}),
		).toMatchObject({
			coverage: false,
			lightPrChecks: true,
			prChecks: true,
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
				changedFiles: ["test/scripts/workspace-utils.test.ts"],
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
					"scripts/deprecate-release.js",
					"scripts/run-scenario-replay-gate.mjs",
					"scripts/validate-public-package-deps.js",
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
	it("recognizes public validation workflows by runner lane", () => {
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

		expect(isPublicValidationWorkflow(publicWorkflow)).toBe(true);
		expect(
			isPublicValidationWorkflow({
				jobs: {
					...publicWorkflow.jobs,
					"public-release-mirror": {},
				},
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

	it("runs release helper script tests directly instead of the root Nx target", () => {
		const script = readFileSync(
			new URL("../../scripts/ci-nx-tests.sh", import.meta.url),
			{ encoding: "utf8" },
		);

		expect(script).toContain("release_helper_script_tests_only");
		expect(script).toContain(
			"Release helper script tests are handled directly by Vitest.",
		);
		expect(script).toContain("node ./scripts/run-vitest.js --run");
		expect(script).toContain("test/scripts/workspace-utils.test.ts");
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
		expect(workflow.jobs?.coverage?.["timeout-minutes"]).toBe(75);
		expect(coverageTimeouts.get("Run tests with coverage")).toBe(60);
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
		expect(uploadLogsStep?.with?.path).toContain("nx-tests-attempt-*.json");
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
		expect(prChecksRunsOn).toContain("evalops-private-ci");
		expect(prChecksRunsOn).toContain("PR_CHECKS_RUNNER");
		expect(prChecksRunsOn).toContain("evalops-private-ci");
		expect(prChecksRunsOn).toContain("INTERNAL_CONFIRMATION_RUNNER");
		expect(coverageRunsOn).toContain("ubuntu-latest");
		expect(coverageRunsOn).toContain("PR_COVERAGE_RUNNER");
		expect(coverageRunsOn).toContain("evalops-private-heavy");
		expect(coverageRunsOn).toContain("INTERNAL_CONFIRMATION_RUNNER");
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
		expect(helperSmokeStep?.run).toContain(
			"node --check scripts/release-readiness.js",
		);
		expect(helperSmokeStep?.run).toContain(
			"node ./scripts/run-vitest.js --run test/scripts/workspace-utils.test.ts",
		);
		expect(helperSmokeStep?.run).toContain(
			"MAESTRO_SKIP_INSTALL_AUDIT=1 MAESTRO_SKIP_BUN_INSTALL_SMOKE=1",
		);
		expect(helperSmokeStep?.run).toContain(
			"node scripts/release-readiness.js pack-smoke",
		);
		expect(helperSmokeStep?.run).toContain("npm run build");
		expect(releaseReadinessStep?.if).toContain("release_helper_only != 'true'");
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
			"runInstalledCliSmoke",
			"runInstalledPackageAudit",
		]) {
			expect(helpers[exportName]).toEqual(expect.any(Function));
		}
	});

	it("keeps packed CLI smoke aligned with registry install validation", () => {
		const script = readFileSync(
			new URL("../../scripts/smoke-packed-cli.js", import.meta.url),
			{ encoding: "utf8" },
		);

		expect(script).toContain("assertInstallablePackageMetadata");
		expect(script).toContain("runInstalledCliSmoke");
		expect(script).toContain("getBunCommand");
		expect(script).toContain("runNpmInstallSmoke();");
		expect(script).toContain("runBunInstallSmoke();");
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
		expect(script).toContain('resolve(process.cwd(), "dist/cli.js")');
		expect(script).toContain('run("npm run build");');
		expect(script.indexOf("ensurePackedCliArtifacts();")).toBeLessThan(
			script.indexOf('execSync("npm pack --silent"'),
		);
		expect(script).toContain('case "pack-smoke":');
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

		expect(timeouts.get("Run tests")).toBeGreaterThanOrEqual(10);
		expect(timeouts.get("Run evals chunk")).toBe(45);
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
			"${{ github.event_name != 'pull_request' || (needs.changes.outputs.ci_infrastructure_only != 'true' && needs.changes.outputs.proof_harness_only != 'true' && needs.changes.outputs.release_helper_only != 'true') }}";
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

	it("keeps the Rust toolchain home stable across workflow runs", () => {
		const action = readFileSync(
			new URL("../../.github/actions/setup-rust/action.yml", import.meta.url),
			{
				encoding: "utf8",
			},
		);

		expect(action).toContain(
			"/maestro-rust/${safe_repo}/${safe_job}/${safe_toolchain}",
		);
		expect(action).toContain("Ensure Rustup tool proxies");
		expect(action).toContain(
			"for proxy in cargo rustc rustdoc rustfmt cargo-fmt cargo-clippy clippy-driver",
		);
		expect(action).not.toContain("GITHUB_RUN_ID");
	});

	it("embeds and validates public mirror source metadata before opening PRs", () => {
		const ciWorkflow = parse(
			readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), {
				encoding: "utf8",
			}),
		) as Workflow;
		if (isPublicValidationWorkflow(ciWorkflow)) {
			expect(ciWorkflow.jobs?.["pr-checks"]).toBeDefined();
			return;
		}

		const workflow = readFileSync(
			new URL(
				"../../.github/workflows/sync-public-release-mirror.yml",
				import.meta.url,
			),
			{ encoding: "utf8" },
		);

		expect(workflow).toContain("scripts/public-mirror-source.mjs marker");
		expect(workflow).toContain("scripts/public-mirror-source.mjs validate");
		expect(workflow).toContain("source_marker");
		expect(workflow).toContain("${source_marker}");
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
		expect(String(uploadStep?.with?.path ?? "")).toContain(
			"nx-resolved-targets.log",
		);
		expect(String(uploadStep?.with?.path ?? "")).toContain(
			"nx-target-timings-*.log",
		);
		expect(String(uploadStep?.with?.path ?? "")).toContain("nx-profile-*.json");
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
});

describe("shellcheck workflow guardrails", () => {
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
					"scripts/install-smoke-utils.js",
					"scripts/plan-ci-checks.mjs",
					"scripts/release-readiness.js",
					"scripts/smoke-packed-cli.js",
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
					"test/scripts/workspace-utils.test.ts",
				],
				headPackage: basePackage,
			}),
		).toEqual({
			files: ["test/scripts/workspace-utils.test.ts"],
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
			"codex/release-foo",
		]);
		expect(publicMirrorRefCandidates("internal-release-foo")).toEqual([
			"internal-release-foo",
			"release-foo",
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
});
