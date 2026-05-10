import { describe, expect, it } from "vitest";
import {
	evaluatePublicMirrorReviewDebt,
	parsePublicMirrorPulls,
} from "../../scripts/check-public-mirror-review-debt.mjs";
import { planCiChecks } from "../../scripts/plan-ci-checks.mjs";
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
		).toMatchObject({ coverage: true, publicMirror: true });
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
