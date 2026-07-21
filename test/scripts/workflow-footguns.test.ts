import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateWorkflowFootguns } from "../../scripts/check-workflow-footguns.mjs";

const fixtures: string[] = [];

function makeFixture(): string {
	const root = join(
		tmpdir(),
		`maestro-workflow-footguns-${process.pid}-${Date.now()}-${fixtures.length}`,
	);
	fixtures.push(root);
	mkdirSync(join(root, ".github/workflows"), { recursive: true });
	mkdirSync(join(root, ".github"), { recursive: true });
	return root;
}

function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function writeReleaseManifest(root: string, files: string[]): void {
	write(
		join(root, ".github/release-mirror-manifest.json"),
		`${JSON.stringify({ files }, null, 2)}\n`,
	);
}

describe("workflow footgun guardrails", () => {
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("rejects EvalOpsBot dispatch workflows that hard-fail when the dispatch token is missing", () => {
		const root = makeFixture();
		write(
			join(root, ".github/workflows/evalopsbot-review-request.yml"),
			[
				"name: EvalOpsBot requested review",
				"jobs:",
				"  dispatch:",
				"    steps:",
				"      - name: Require dispatch token",
				"        shell: bash",
				"        run: |",
				"          set -euo pipefail",
				'          if [ -z "${GH_TOKEN}" ]; then',
				'            echo "::error::Set EVALOPS_PR_LENS_TOKEN for immediate EvalOpsBot review dispatch."',
				"            exit 2",
				"          fi",
				"      - name: Dispatch deep review",
				"        shell: bash",
				"        run: gh api --method POST repos/evalops/.github/dispatches",
				"",
			].join("\n"),
		);

		expect(evaluateWorkflowFootguns({ root })).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					"evalopsbot-review-request.yml: dispatch token must skip gracefully",
				),
			]),
		);
	});

	it("accepts EvalOpsBot dispatch workflows that gate dispatch steps behind a configured-token output", () => {
		const root = makeFixture();
		write(
			join(root, ".github/workflows/evalopsbot-review-request.yml"),
			[
				"name: EvalOpsBot requested review",
				"jobs:",
				"  dispatch:",
				"    steps:",
				"      - name: Resolve dispatch token",
				"        id: dispatch-token",
				"        shell: bash",
				"        run: |",
				"          set -euo pipefail",
				'          if [ -z "${GH_TOKEN}" ]; then',
				'            echo "::warning::EVALOPS_PR_LENS_TOKEN is unavailable; skipping immediate EvalOpsBot review dispatch."',
				'            echo "configured=false" >> "$GITHUB_OUTPUT"',
				"            exit 0",
				"          fi",
				'          echo "configured=true" >> "$GITHUB_OUTPUT"',
				"      - name: Dispatch deep review",
				"        if: ${{ steps.dispatch-token.outputs.configured == 'true' }}",
				"        shell: bash",
				"        run: gh api --method POST repos/evalops/.github/dispatches",
				"",
			].join("\n"),
		);

		expect(evaluateWorkflowFootguns({ root })).toEqual([]);
	});

	it("rejects public release mirror app tokens that can sync workflow files without requesting workflow permission", () => {
		const root = makeFixture();
		writeReleaseManifest(root, [".github/workflows/tag-release.yml"]);
		write(
			join(root, ".github/workflows/public-release-mirror.yml"),
			[
				"name: public-release-mirror",
				"jobs:",
				"  mirror-release:",
				"    steps:",
				"      - name: Mint public repo GitHub App token",
				"        id: app-token",
				"        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
				"        with:",
				"          app-id: ${{ secrets.PUBLIC_MIRROR_APP_ID }}",
				"          private-key: ${{ secrets.PUBLIC_MIRROR_APP_PRIVATE_KEY }}",
				"          owner: evalops",
				"          repositories: maestro",
				"",
			].join("\n"),
		);

		expect(evaluateWorkflowFootguns({ root })).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					"public-release-mirror.yml: GitHub App token must request permission-workflows: write",
				),
			]),
		);
	});

	it("rejects public release mirror app tokens that downscope away contents write permission", () => {
		const root = makeFixture();
		writeReleaseManifest(root, [".github/workflows/tag-release.yml"]);
		write(
			join(root, ".github/workflows/public-release-mirror.yml"),
			[
				"name: public-release-mirror",
				"jobs:",
				"  mirror-release:",
				"    steps:",
				"      - name: Mint public repo GitHub App token",
				"        id: app-token",
				"        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
				"        with:",
				"          app-id: ${{ secrets.PUBLIC_MIRROR_APP_ID }}",
				"          private-key: ${{ secrets.PUBLIC_MIRROR_APP_PRIVATE_KEY }}",
				"          owner: evalops",
				"          repositories: maestro",
				"          permission-workflows: write",
				"",
			].join("\n"),
		);

		expect(evaluateWorkflowFootguns({ root })).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					"public-release-mirror.yml: GitHub App token must preserve permission-contents: write",
				),
			]),
		);
	});

	it("accepts public release mirror app tokens that request workflow and contents permission before syncing workflow files", () => {
		const root = makeFixture();
		writeReleaseManifest(root, [".github/workflows/tag-release.yml"]);
		write(
			join(root, ".github/workflows/public-release-mirror.yml"),
			[
				"name: public-release-mirror",
				"jobs:",
				"  mirror-release:",
				"    steps:",
				"      - name: Mint public repo GitHub App token",
				"        id: app-token",
				"        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
				"        with:",
				"          app-id: ${{ secrets.PUBLIC_MIRROR_APP_ID }}",
				"          private-key: ${{ secrets.PUBLIC_MIRROR_APP_PRIVATE_KEY }}",
				"          owner: evalops",
				"          repositories: maestro",
				"          permission-contents: write",
				"          permission-workflows: write",
				"",
			].join("\n"),
		);

		expect(evaluateWorkflowFootguns({ root })).toEqual([]);
	});

	it("rejects hard-coding the trusted evalops-internal lane for pull_request jobs", () => {
		const root = makeFixture();
		write(
			join(root, ".github/workflows/ci.yml"),
			[
				"name: ci",
				"jobs:",
				"  pr-checks:",
				"    runs-on: ${{ github.event_name == 'pull_request' && 'evalops-internal' || 'ubuntu-latest' }}",
				"    steps:",
				"      - run: echo ok",
				"",
			].join("\n"),
		);
		write(
			join(root, ".github/workflows/rust.yml"),
			[
				"name: Rust TUI",
				"jobs:",
				"  build:",
				"    runs-on: ${{ github.event_name == 'pull_request' && 'evalops-internal' || 'ubuntu-latest' }}",
				"    steps:",
				"      - run: echo ok",
				"",
			].join("\n"),
		);

		expect(evaluateWorkflowFootguns({ root })).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					"ci.yml: pull_request jobs must not hard-code evalops-internal",
				),
				expect.stringContaining(
					"rust.yml: pull_request jobs must not hard-code evalops-internal",
				),
			]),
		);
	});

	it("accepts pull request workflows routed through PR_CHECKS / INTERNAL_CONFIRMATION failover vars", () => {
		const root = makeFixture();
		write(
			join(root, ".github/workflows/ci.yml"),
			[
				"name: ci",
				"jobs:",
				"  pr-checks:",
				"    runs-on: ${{ github.event_name == 'pull_request' && (vars.PR_CHECKS_RUNNER || 'ubuntu-latest') || (vars.INTERNAL_CONFIRMATION_RUNNER || 'ubuntu-latest') }}",
				"    steps:",
				"      - run: echo ok",
				"  coverage:",
				"    runs-on: ${{ github.event_name == 'pull_request' && 'ubuntu-latest' || (vars.INTERNAL_CONFIRMATION_RUNNER || 'ubuntu-latest') }}",
				"    steps:",
				"      - run: echo ok",
				"",
			].join("\n"),
		);
		write(
			join(root, ".github/workflows/rust.yml"),
			[
				"name: Rust TUI",
				"jobs:",
				"  build:",
				"    runs-on: ${{ github.event_name == 'pull_request' && 'ubuntu-latest' || (vars.INTERNAL_CONFIRMATION_RUNNER || 'ubuntu-latest') }}",
				"    steps:",
				"      - run: echo ok",
				"",
			].join("\n"),
		);

		expect(evaluateWorkflowFootguns({ root })).toEqual([]);
	});

	it("accepts public pull request workflows routed through the public validation runner var", () => {
		const root = makeFixture();
		write(
			join(root, ".github/workflows/ci.yml"),
			[
				"name: ci",
				"jobs:",
				"  pr-checks:",
				"    runs-on: ${{ vars.PUBLIC_PR_VALIDATION_RUNNER || 'ubuntu-latest' }}",
				"    steps:",
				"      - run: echo ok",
				"",
			].join("\n"),
		);

		expect(evaluateWorkflowFootguns({ root })).toEqual([]);
	});

	it("rejects workflows that still reference retired Blacksmith runner labels", () => {
		const root = makeFixture();
		write(
			join(root, ".github/workflows/ci.yml"),
			[
				"name: ci",
				"jobs:",
				"  pr-checks:",
				"    runs-on: ${{ github.event_name == 'pull_request' && (vars.PR_CHECKS_RUNNER || 'ubuntu-latest') || (vars.INTERNAL_CONFIRMATION_RUNNER || 'ubuntu-latest') }}",
				"    steps:",
				"      - run: echo ok",
				"",
			].join("\n"),
		);
		write(
			join(root, ".github/workflows/rust.yml"),
			[
				"name: Rust TUI",
				"jobs:",
				"  build:",
				"    runs-on: ${{ vars.BLACKSMITH_RUNNER || 'blacksmith-4vcpu-ubuntu-2404' }}",
				"    steps:",
				"      - run: echo ok",
				"",
			].join("\n"),
		);

		expect(evaluateWorkflowFootguns({ root })).toEqual(
			expect.arrayContaining([
				expect.stringContaining("rust.yml: Blacksmith runners are retired"),
			]),
		);
	});

	it("rejects workflows that still reference retired Blacksmith runner vars even without a literal label", () => {
		const root = makeFixture();
		write(
			join(root, ".github/workflows/ci.yml"),
			[
				"name: ci",
				"jobs:",
				"  pr-checks:",
				"    runs-on: ${{ vars.BLACKSMITH_HEAVY_RUNNER || 'ubuntu-latest' }}",
				"    steps:",
				"      - run: echo ok",
				"",
			].join("\n"),
		);

		expect(evaluateWorkflowFootguns({ root })).toEqual(
			expect.arrayContaining([
				expect.stringContaining("ci.yml: Blacksmith runners are retired"),
			]),
		);
	});

	it("rejects Blacksmith references outside .github/workflows (composite actions, actionlint.yaml)", () => {
		const root = makeFixture();
		write(
			join(root, ".github/actions/setup-rust/action.yml"),
			[
				"name: setup-rust",
				"runs:",
				"  using: composite",
				"  steps:",
				"    - shell: bash",
				"      run: echo 'fallback runner: blacksmith-4vcpu-ubuntu-2404'",
				"",
			].join("\n"),
		);
		write(
			join(root, ".github/actionlint.yaml"),
			[
				"self-hosted-runner:",
				"  labels:",
				"    - blacksmith-8vcpu-ubuntu-2404",
				"",
			].join("\n"),
		);

		expect(evaluateWorkflowFootguns({ root })).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					".github/actions/setup-rust/action.yml: Blacksmith runners are retired",
				),
				expect.stringContaining(
					".github/actionlint.yaml: Blacksmith runners are retired",
				),
			]),
		);
	});
});
