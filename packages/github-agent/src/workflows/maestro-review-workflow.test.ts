import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	MAESTRO_REVIEW_WORKFLOW_PATH,
	buildMaestroReviewWorkflow,
	writeMaestroReviewWorkflow,
} from "../index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

describe("maestro review workflow generator", () => {
	it("emits a pull_request workflow that runs maestro exec and comments", () => {
		const yaml = buildMaestroReviewWorkflow();
		expect(yaml).toContain("name: Maestro Code Review");
		expect(yaml).toContain("on:\n  pull_request:");
		expect(yaml).toContain("pull-requests: write");
		expect(yaml).toContain(
			'export MAESTRO_MERGE_BASE_SHA="$(git merge-base "${MAESTRO_BASE_SHA}" "${MAESTRO_HEAD_SHA}")"',
		);
		expect(yaml).toContain(
			"maestro exec --provider 'anthropic' --output-last-message review.md",
		);
		expect(yaml).toContain(
			"from merge base ${MAESTRO_MERGE_BASE_SHA} to ${MAESTRO_HEAD_SHA}",
		);
		expect(yaml).toContain("gh pr comment");
		expect(yaml).toContain('node-version: "20"');
		expect(yaml).toContain("npm install -g 'maestro@latest'");
		expect(yaml).toContain("GITHUB_PERSONAL_ACCESS_TOKEN: ${{ github.token }}");
		expect(yaml).toContain(
			[
				'gh pr comment "${MAESTRO_PR_NUMBER}" --edit-last --body-file review.md || \\',
				'            gh pr comment "${MAESTRO_PR_NUMBER}" --body-file review.md',
			].join("\n"),
		);
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

	it("is deterministic for the same options", () => {
		expect(buildMaestroReviewWorkflow({ model: "claude-opus-4-8" })).toBe(
			buildMaestroReviewWorkflow({ model: "claude-opus-4-8" }),
		);
	});

	it("threads model, version, node, and api-key-secret options", () => {
		const yaml = buildMaestroReviewWorkflow({
			provider: "anthropic",
			model: "claude-opus-4-8",
			maestroPackage: "@example/maestro",
			maestroVersion: "1.2.3",
			nodeVersion: "22",
			apiKeySecretName: "MODEL_API_KEY",
		});
		expect(yaml).toContain(
			"maestro exec --provider 'anthropic' --model 'claude-opus-4-8'",
		);
		expect(yaml).toContain("npm install -g '@example/maestro@1.2.3'");
		expect(yaml).toContain('node-version: "22"');
		expect(yaml).toContain("ANTHROPIC_API_KEY: ${{ secrets.MODEL_API_KEY }}");
	});

	it("maps provider secret names to Maestro runtime env names", () => {
		expect(buildMaestroReviewWorkflow({ provider: "openai" })).toContain(
			"OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}",
		);
		expect(
			buildMaestroReviewWorkflow({
				provider: "openai",
				apiKeySecretName: "maestro_OpenAI_review_key",
			}),
		).toContain("OPENAI_API_KEY: ${{ secrets.maestro_OpenAI_review_key }}");
		expect(
			buildMaestroReviewWorkflow({
				provider: "custom-provider",
				apiKeyEnvName: "CUSTOM_PROVIDER_API_KEY",
				apiKeySecretName: "CUSTOM_PROVIDER_REVIEW_SECRET",
			}),
		).toContain(
			"CUSTOM_PROVIDER_API_KEY: ${{ secrets.CUSTOM_PROVIDER_REVIEW_SECRET }}",
		);
	});

	it("omits the model flag when no model is given", () => {
		expect(buildMaestroReviewWorkflow()).toContain(
			"maestro exec --provider 'anthropic' --output-last-message",
		);
		expect(buildMaestroReviewWorkflow()).not.toContain("--model");
	});

	it("infers a provider from the configured API key env var", () => {
		expect(
			buildMaestroReviewWorkflow({ apiKeySecretName: "OPENAI_API_KEY" }),
		).toContain("maestro exec --provider 'openai' --output-last-message");
	});

	it("quotes shell-interpreted option values", () => {
		const yaml = buildMaestroReviewWorkflow({
			model: "foo'; echo nope",
			maestroPackage: "@example/maestro",
			maestroVersion: "1.2.3-beta.1",
		});

		expect(yaml).toContain("--model 'foo'\\''; echo nope'");
		expect(yaml).toContain("npm install -g '@example/maestro@1.2.3-beta.1'");
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
		const repoRoot = mkdtempSync(join(tmpdir(), "maestro-review-"));
		tempDirs.push(repoRoot);
		const written = writeMaestroReviewWorkflow(repoRoot);
		expect(written).toBe(join(repoRoot, MAESTRO_REVIEW_WORKFLOW_PATH));
		expect(readFileSync(written, "utf8")).toContain(
			"name: Maestro Code Review",
		);
	});
});
