/**
 * Maestro code-review CI installer
 *
 * Emits a GitHub Actions workflow that runs `maestro exec` on every pull
 * request and posts a merge-readiness review as a PR comment. This is the
 * turnkey "install Maestro into CI" path: an installer skill (or a user) calls
 * buildMaestroReviewWorkflow() / writeMaestroReviewWorkflow() to drop the
 * workflow into a target repository.
 *
 * The emitter is deterministic so the installer can detect drift and the
 * generated file reviews cleanly.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Repo-relative path the workflow is written to. */
export const MAESTRO_REVIEW_WORKFLOW_PATH =
	".github/workflows/maestro-review.yml";

export interface MaestroReviewWorkflowOptions {
	/** Node major version used to run Maestro in CI. Default "20". */
	nodeVersion?: string;
	/** npm package installed in CI. Defaults to MAESTRO_PACKAGE_NAME or "maestro". */
	maestroPackage?: string;
	/** Version/tag of the package to install. Default "latest". */
	maestroVersion?: string;
	/**
	 * Optional provider passed to `maestro exec --provider` when no model is set.
	 * Defaults to the provider inferred from the API key secret/env var and falls
	 * back to "anthropic".
	 */
	provider?: string;
	/** Optional model id passed to `maestro exec --model`. */
	model?: string;
	/**
	 * Name of the repository secret holding the model provider API key. Defaults
	 * to the provider's expected runtime env var (e.g. "ANTHROPIC_API_KEY").
	 */
	apiKeySecretName?: string;
	/**
	 * Environment variable exposed to Maestro. Defaults to the provider-specific
	 * API key env var so custom secret names still work at runtime.
	 */
	apiKeyEnvName?: string;
}

const PROVIDER_API_KEY_ENV_NAMES: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	"openai-codex": "OPENAI_CODEX_TOKEN",
	"azure-openai": "AZURE_OPENAI_API_KEY",
	google: "GEMINI_API_KEY",
	"google-gemini-cli": "GOOGLE_GEMINI_CLI_TOKEN",
	"google-antigravity": "GOOGLE_ANTIGRAVITY_TOKEN",
	evalops: "MAESTRO_EVALOPS_ACCESS_TOKEN",
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	mistral: "MISTRAL_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	xai: "XAI_API_KEY",
	zai: "ZAI_API_KEY",
	writer: "WRITER_API_KEY",
	moonshot: "MOONSHOT_API_KEY",
	dashscope: "DASHSCOPE_API_KEY",
	minimax: "MINIMAX_API_KEY",
};

interface ResolvedOptions {
	nodeVersion: string;
	maestroPackage: string;
	maestroVersion: string;
	provider: string;
	model?: string;
	apiKeySecretName: string;
	apiKeyEnvName: string;
}

function validateEnvName(name: string, optionName: string): string {
	if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
		throw new Error(
			`${optionName} must be a valid GitHub Actions env name: ${name}`,
		);
	}
	return name;
}

function validateSecretName(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new Error(
			`apiKeySecretName must be a valid GitHub Actions secret name: ${name}`,
		);
	}
	return name;
}

function getDefaultApiKeyEnvName(provider: string): string {
	return (
		PROVIDER_API_KEY_ENV_NAMES[provider] ??
		`${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`
	);
}

function validateYamlScalar(value: string, optionName: string): string {
	if (/\r|\n/.test(value)) {
		throw new Error(`${optionName} must not contain newlines`);
	}
	return value;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

const PROVIDER_BY_API_KEY_ENV_VAR: Record<string, string> = {
	ANTHROPIC_API_KEY: "anthropic",
	GEMINI_API_KEY: "google",
	GOOGLE_GEMINI_CLI_TOKEN: "google-gemini-cli",
	GOOGLE_ANTIGRAVITY_TOKEN: "google-antigravity",
	OPENAI_API_KEY: "openai",
	OPENAI_CODEX_TOKEN: "openai-codex",
	OPENAI_CODEX_ACCESS_TOKEN: "openai-codex",
	CODEX_API_KEY: "openai-codex",
	AZURE_OPENAI_API_KEY: "azure-openai",
	MAESTRO_EVALOPS_ACCESS_TOKEN: "evalops",
	WRITER_API_KEY: "writer",
	XAI_API_KEY: "xai",
	GROQ_API_KEY: "groq",
	CEREBRAS_API_KEY: "cerebras",
	OPENROUTER_API_KEY: "openrouter",
	ZAI_API_KEY: "zai",
	MISTRAL_API_KEY: "mistral",
	DEEPSEEK_API_KEY: "deepseek",
	MOONSHOT_API_KEY: "moonshot",
	KIMI_API_KEY: "moonshot",
	DASHSCOPE_API_KEY: "dashscope",
	QWEN_API_KEY: "dashscope",
	MINIMAX_API_KEY: "minimax",
};

function inferProviderFromApiKeyEnvVar(
	apiKeyName?: string,
): string | undefined {
	return apiKeyName ? PROVIDER_BY_API_KEY_ENV_VAR[apiKeyName] : undefined;
}

function resolveOptions(
	options: MaestroReviewWorkflowOptions,
): ResolvedOptions {
	const inferredProvider =
		inferProviderFromApiKeyEnvVar(options.apiKeySecretName) ??
		inferProviderFromApiKeyEnvVar(options.apiKeyEnvName);
	const provider = validateYamlScalar(
		options.provider ?? inferredProvider ?? "anthropic",
		"provider",
	);
	const apiKeyEnvName = validateEnvName(
		options.apiKeyEnvName ?? getDefaultApiKeyEnvName(provider),
		"apiKeyEnvName",
	);
	return {
		nodeVersion: validateYamlScalar(options.nodeVersion ?? "20", "nodeVersion"),
		maestroPackage: validateYamlScalar(
			options.maestroPackage ?? process.env.MAESTRO_PACKAGE_NAME ?? "maestro",
			"maestroPackage",
		),
		maestroVersion: validateYamlScalar(
			options.maestroVersion ?? "latest",
			"maestroVersion",
		),
		provider,
		model:
			options.model === undefined
				? undefined
				: validateYamlScalar(options.model, "model"),
		apiKeySecretName: validateSecretName(
			options.apiKeySecretName ?? apiKeyEnvName,
		),
		apiKeyEnvName,
	};
}

/**
 * Build the `.github/workflows/maestro-review.yml` contents as a YAML string.
 */
export function buildMaestroReviewWorkflow(
	options: MaestroReviewWorkflowOptions = {},
): string {
	const resolved = resolveOptions(options);
	const modelFlag = resolved.model
		? ` --model ${shellQuote(resolved.model)}`
		: "";
	const packageSpec = `${resolved.maestroPackage}@${resolved.maestroVersion}`;
	// Keep ${...} placeholders as literal shell expansions in the generated YAML.
	const reviewPrompt =
		"Use the pr-review skill to review the changes in this pull request " +
		"(#${MAESTRO_PR_NUMBER}) from merge base ${MAESTRO_MERGE_BASE_SHA} to " +
		"${MAESTRO_HEAD_SHA} (equivalent to the three-dot PR diff " +
		"${MAESTRO_BASE_SHA}...${MAESTRO_HEAD_SHA}). Produce a " +
		"merge-readiness review ordered by severity, with file and line " +
		"references.";

	return `# Generated by Maestro (install-code-review). Re-running the installer
# overwrites this file; hand edits may be lost.
name: Maestro Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: maestro-review-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: ${JSON.stringify(resolved.nodeVersion)}
      - name: Install Maestro
        run: npm install -g ${shellQuote(packageSpec)}
      - name: Review pull request
        env:
          ${resolved.apiKeyEnvName}: \${{ secrets.${resolved.apiKeySecretName} }}
          GH_TOKEN: \${{ github.token }}
          GITHUB_PERSONAL_ACCESS_TOKEN: \${{ github.token }}
          MAESTRO_PR_NUMBER: \${{ github.event.pull_request.number }}
          MAESTRO_BASE_SHA: \${{ github.event.pull_request.base.sha }}
          MAESTRO_HEAD_SHA: \${{ github.event.pull_request.head.sha }}
        run: |
          export MAESTRO_MERGE_BASE_SHA="$(git merge-base "\${MAESTRO_BASE_SHA}" "\${MAESTRO_HEAD_SHA}")"
          maestro exec --provider ${shellQuote(resolved.provider)}${modelFlag} --output-last-message review.md \\
            "${reviewPrompt}"
          gh pr comment "\${MAESTRO_PR_NUMBER}" --edit-last --body-file review.md || \\
            gh pr comment "\${MAESTRO_PR_NUMBER}" --body-file review.md
`;
}

/**
 * Write the review workflow into the target repository, creating the
 * `.github/workflows` directory if needed. Returns the absolute path written.
 */
export function writeMaestroReviewWorkflow(
	repoRoot: string,
	options: MaestroReviewWorkflowOptions = {},
): string {
	const target = join(repoRoot, MAESTRO_REVIEW_WORKFLOW_PATH);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, buildMaestroReviewWorkflow(options), "utf8");
	return target;
}
