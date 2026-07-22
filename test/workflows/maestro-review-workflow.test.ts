import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMaestroReviewWorkflow as buildGithubAgentReviewWorkflow } from "../../packages/github-agent/src/workflows/maestro-review-workflow.js";
import {
	MAESTRO_REVIEW_WORKFLOW_PATH,
	buildMaestroReviewWorkflow,
	writeMaestroReviewWorkflow,
} from "../../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

describe("buildMaestroReviewWorkflow", () => {
	it("defaults CI auth to the anthropic provider", () => {
		const yaml = buildMaestroReviewWorkflow();
		expect(yaml).toContain(
			"maestro exec --provider 'anthropic' --output-last-message review.md",
		);
		expect(yaml).toContain(
			"ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}",
		);
		expect(yaml).toContain("npm install -g 'maestro@latest'");
		expect(yaml).toContain("GITHUB_PERSONAL_ACCESS_TOKEN: ${{ github.token }}");
		expect(yaml).toContain(
			'export MAESTRO_MERGE_BASE_SHA="$(git merge-base "${MAESTRO_BASE_SHA}" "${MAESTRO_HEAD_SHA}")"',
		);
		expect(yaml).toContain(
			"from merge base ${MAESTRO_MERGE_BASE_SHA} to ${MAESTRO_HEAD_SHA}",
		);
		expect(yaml).toContain(
			[
				'gh pr comment "${MAESTRO_PR_NUMBER}" --edit-last --body-file review.md || \\',
				'            gh pr comment "${MAESTRO_PR_NUMBER}" --body-file review.md',
			].join("\n"),
		);
	});

	it("uses an explicit package override", () => {
		expect(
			buildMaestroReviewWorkflow({ maestroPackage: "@example/from-env" }),
		).toContain("npm install -g '@example/from-env@latest'");
	});

	it("reads the default package override at build time", () => {
		const previous = process.env.MAESTRO_PACKAGE_NAME;
		try {
			process.env.MAESTRO_PACKAGE_NAME = "@example/from-env";
			expect(buildMaestroReviewWorkflow()).toContain(
				"npm install -g '@example/from-env@latest'",
			);
		} finally {
			if (previous === undefined) {
				delete process.env.MAESTRO_PACKAGE_NAME;
			} else {
				process.env.MAESTRO_PACKAGE_NAME = previous;
			}
		}
	});

	it("maps custom secret names to the provider runtime env var", () => {
		const yaml = buildMaestroReviewWorkflow({
			provider: "openai",
			apiKeySecretName: "OPENAI_REVIEW_SECRET",
		});
		expect(yaml).toContain(
			"OPENAI_API_KEY: ${{ secrets.OPENAI_REVIEW_SECRET }}",
		);
	});

	it("matches the github-agent generator for shared options", () => {
		const options = {
			apiKeySecretName: "maestro_OpenAI_review_key",
			maestroPackage: "maestro",
			maestroVersion: "next",
			model: "gpt-5.1",
			nodeVersion: "22",
			provider: "openai",
		};

		expect(buildMaestroReviewWorkflow(options)).toBe(
			buildGithubAgentReviewWorkflow(options),
		);
	});

	it("rejects unsafe workflow structure values", () => {
		expect(() =>
			buildMaestroReviewWorkflow({ apiKeySecretName: "BAD-NAME" }),
		).toThrow("apiKeySecretName");
		expect(() =>
			buildMaestroReviewWorkflow({ apiKeyEnvName: "BAD-NAME" }),
		).toThrow("apiKeyEnvName");
		expect(() =>
			buildMaestroReviewWorkflow({ model: "safe\necho unsafe" }),
		).toThrow("model");
	});

	it("writes the workflow to the conventional path", () => {
		const repoRoot = mkdtempSync(join(tmpdir(), "maestro-review-root-"));
		tempDirs.push(repoRoot);
		const written = writeMaestroReviewWorkflow(repoRoot);
		expect(written).toBe(join(repoRoot, MAESTRO_REVIEW_WORKFLOW_PATH));
		expect(readFileSync(written, "utf8")).toContain(
			"name: Maestro Code Review",
		);
	});
});
