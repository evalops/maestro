/**
 * Agent Readiness Criteria
 *
 * Static rubric the agent-readiness auditor (filed under #2661 part 2)
 * walks when evaluating a repo's readiness for autonomous agent work.
 * The criteria are explicitly agent-aware — each one cites *why* it
 * helps or constrains an autonomous agent (feature flags reduce bad-
 * commit blast radius, CODEOWNERS routes agent-authored PRs to humans,
 * coverage thresholds force agents to maintain tests, etc.).
 *
 * Each criterion has:
 *   - id          — stable kebab/snake identifier
 *   - name        — display name
 *   - description — one-line claim
 *   - category    — docs | build | testing | style | debugging | security | product
 *   - level       — 1 (foundational) … 5 (frontier)
 *   - scope       — application (code-shape) | repository (repo-shape)
 *   - instructions — LLM-ready pass-check guidance for the auditor
 *   - isSkippable — true for criteria that don't apply to all repo types
 *   - requires    — assertion ids that must pass before this criterion is run
 *
 * ## What this module is
 *
 * Pure data + typed accessors. No I/O, no auditor agent, no LLM calls.
 * The auditor command in part 2 of #2661 consumes this rubric and the
 * `instructions` strings as the prompt body per criterion.
 *
 * ## EvalOps-specific criteria
 *
 * `evalOpsCriteria` is a separate layer that customers can opt into
 * when they sell themselves on agent evaluation discipline. Kept in
 * its own array so the base rubric stays portable.
 */

/** Coarse categorization for grouping criteria in reports. */
export type ReadinessCategory =
	| "docs"
	| "build"
	| "testing"
	| "style"
	| "debugging"
	| "security"
	| "product";

/** Audit scope: the codebase shape or the repo shape. */
export type ReadinessScope = "application" | "repository";

/**
 * Foundational → frontier ramp. Level 1 is the floor for productive
 * autonomous agent work; level 5 is best-in-class platform discipline.
 */
export type ReadinessLevel = 1 | 2 | 3 | 4 | 5;

/** A single static rubric entry. */
export interface AgentReadinessCriterion {
	id: string;
	name: string;
	description: string;
	category: ReadinessCategory;
	level: ReadinessLevel;
	scope: ReadinessScope;
	instructions: string;
	/** True for criteria the auditor may skip if the repo type makes them moot. */
	isSkippable?: boolean;
	/**
	 * Other criterion ids that must pass before this one is evaluated.
	 * E.g. `agents_md_validation` requires `agents_md` so the auditor
	 * doesn't run the check on repos that don't have the document.
	 */
	requires?: string[];
}

/**
 * Base rubric. Pragmatic agent-readiness criteria covering the
 * foundations through advanced operational discipline. The instruction
 * text is rewritten in this repo's voice with an EvalOps-shaped tone.
 */
export const BASE_READINESS_CRITERIA: readonly AgentReadinessCriterion[] = [
	{
		id: "readme",
		name: "README",
		description: "Repository has a README with basic information.",
		category: "docs",
		level: 1,
		scope: "repository",
		instructions:
			"README.md exists at repo root with setup/usage instructions for a first-time contributor.",
	},
	{
		id: "agents_md",
		name: "AGENTS.md",
		description:
			"Repository has an AGENTS.md file documenting agent-relevant essentials.",
		category: "docs",
		level: 2,
		scope: "repository",
		instructions:
			"AGENTS.md exists at repo root, is non-empty (>100 characters), and documents at least: package manager (npm/bun/pnpm/yarn or pip/poetry), build commands, test commands, and any conventions an autonomous agent needs to follow (e.g. branch naming, PR style).",
	},
	{
		id: "gitignore_comprehensive",
		name: "Comprehensive .gitignore",
		description: ".gitignore excludes secrets and build artifacts.",
		category: "security",
		level: 1,
		scope: "repository",
		instructions:
			".gitignore excludes .env files (not .env.example), dependency directories (node_modules, .venv), build artifacts (dist, build, target), IDE configs (.idea, .vscode/settings.local), and OS files (.DS_Store, Thumbs.db). Prevents accidental secret/artifact commits.",
	},
	{
		id: "lint_config",
		name: "Linter configured",
		description: "Project has a linter configured for static checks.",
		category: "style",
		level: 1,
		scope: "application",
		instructions:
			"A linter or static analysis tool is configured for the primary language. Examples: ESLint/Biome (.eslintrc*, biome.json) for TS/JS, ruff/flake8 (pyproject.toml, ruff.toml) for Python, clippy for Rust, golangci-lint for Go.",
	},
	{
		id: "type_check",
		name: "Static type checking",
		description: "Project enforces static type checking.",
		category: "style",
		level: 1,
		scope: "application",
		instructions:
			'A type checker is configured for the primary language. Examples: tsconfig.json with "strict": true for TS, mypy.ini or [tool.mypy] in pyproject.toml for Py, sorbet for Ruby, rustc for Rust.',
	},
	{
		id: "formatter",
		name: "Code formatter",
		description: "Project uses an automated code formatter.",
		category: "style",
		level: 1,
		scope: "application",
		instructions:
			"An automated formatter is configured. Examples: Prettier/Biome for TS/JS, Black or Ruff format for Python, rustfmt for Rust, gofmt for Go.",
	},
	{
		id: "unit_tests_exist",
		name: "Unit tests exist",
		description: "Project has at least a baseline of unit tests.",
		category: "testing",
		level: 1,
		scope: "application",
		instructions:
			"Unit test files are present and discoverable by the project's test runner. Examples: *.test.ts / *.spec.ts / __tests__ for TS, tests/test_*.py for Python, *_test.go for Go.",
	},
	{
		id: "pre_commit_hooks",
		name: "Pre-commit hooks",
		description: "Pre-commit hooks enforce quality checks before commit.",
		category: "style",
		level: 2,
		scope: "application",
		instructions:
			"Pre-commit hooks are configured to run lint/format/type checks. Examples: Husky + lint-staged for TS, .pre-commit-config.yaml for Python. Helps catch agent-authored mistakes before they land in commits.",
	},
	{
		id: "build_cmd_doc",
		name: "Build command documented",
		description: "Build command is documented so agents can rebuild.",
		category: "build",
		level: 2,
		scope: "repository",
		instructions:
			"README or AGENTS.md documents how to build the project from a clean clone. Examples: `npm install && npm run build`, `pip install -e .`, `cargo build`.",
	},
	{
		id: "deps_pinned",
		name: "Dependencies pinned",
		description: "Project pins dependencies to specific versions.",
		category: "build",
		level: 2,
		scope: "repository",
		instructions:
			"A lockfile is committed (package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lockb for TS; poetry.lock or requirements.txt with == pins for Python; Cargo.lock for Rust; go.sum for Go).",
	},
	{
		id: "vcs_cli_tools",
		name: "Authenticated VCS CLI",
		description: "Authenticated GitHub or GitLab CLI is available.",
		category: "build",
		level: 2,
		scope: "repository",
		instructions:
			"`gh` or `glab` CLI is installed and `gh auth status` / `glab auth status` confirms an authenticated user. Many higher-level criteria fall back to file inference without this, which is less reliable.",
	},
	{
		id: "branch_protection",
		name: "Branch protection",
		description: "Default branch has protection rules.",
		category: "security",
		level: 2,
		scope: "repository",
		instructions:
			"Branch protection is enabled on the default branch (require PR, require review, require status checks). If `gh` / `glab` is authenticated with admin scope, query the API; otherwise fall back to a CODEOWNERS + .github/workflows inspection.",
	},
	{
		id: "codeowners",
		name: "CODEOWNERS",
		description: "Repository has a CODEOWNERS file routing PRs to owners.",
		category: "security",
		level: 2,
		scope: "repository",
		instructions:
			"CODEOWNERS exists at repo root or .github/CODEOWNERS, with at least one valid assignment. Routes agent-authored PRs to the right humans for review.",
	},
	{
		id: "dependency_update_automation",
		name: "Dependency update automation",
		description: "Dependabot or Renovate is creating dependency PRs.",
		category: "security",
		level: 2,
		scope: "repository",
		instructions:
			".github/dependabot.yml, renovate.json, .renovaterc, or equivalent is configured. Reduces the window in which known vulnerabilities sit unpatched.",
	},
	{
		id: "error_tracking_contextualized",
		name: "Contextual error tracking",
		description: "Production errors carry stack + breadcrumb context.",
		category: "debugging",
		level: 2,
		scope: "application",
		instructions:
			"Sentry, Bugsnag, Rollbar, or equivalent is configured with source maps and breadcrumbs, OR a structured logger with contextual error capture is in use. Lets agents trace a production failure back to the responsible code path.",
	},
	{
		id: "runbooks_documented",
		name: "Runbooks documented",
		description: "Incident-response playbooks exist or are linked.",
		category: "debugging",
		level: 2,
		scope: "repository",
		instructions:
			"README, AGENTS.md, or docs/ references runbooks (Notion, Confluence, runbooks/ directory, or similar). Even external links pass — the criterion is 'an agent on call knows where to look'.",
	},
	{
		id: "structured_logging",
		name: "Structured logging",
		description: "Application emits structured (JSON) logs.",
		category: "debugging",
		level: 2,
		scope: "application",
		instructions:
			"Structured logging library is wired up: pino/winston/bunyan for TS, structlog/loguru for Python, slog for Go, tracing for Rust. Or a dedicated logger module that emits JSON.",
	},
	{
		id: "test_coverage_thresholds",
		name: "Coverage thresholds enforced",
		description: "Minimum test coverage is enforced in CI.",
		category: "testing",
		level: 2,
		scope: "application",
		instructions:
			"CI fails when coverage drops below a configured threshold. Examples: vitest coverage thresholds, pytest --cov-fail-under, Codecov status checks blocking PRs, SonarQube quality gate. Agents must know they're expected to keep coverage up.",
	},
	{
		id: "automated_doc_generation",
		name: "Automated doc generation",
		description: "Docs auto-regenerate from code.",
		category: "docs",
		level: 2,
		scope: "repository",
		instructions:
			"API docs, schemas, or architecture diagrams are regenerated automatically. Examples: OpenAPI generators, JSDoc/TypeDoc, Sphinx, changelog automation. Reduces the chance agent changes silently invalidate docs.",
	},
	{
		id: "integration_tests_exist",
		name: "Integration tests exist",
		description: "Project has integration or end-to-end tests.",
		category: "testing",
		level: 3,
		scope: "application",
		instructions:
			"Cypress/Playwright/WebdriverIO for browser, supertest/Vitest e2e for Node services, behave or pytest-bdd .feature files for Python, or equivalent. Catches the integration-level bugs unit tests miss.",
	},
	{
		id: "secret_scanning",
		name: "Secret scanning",
		description: "Repository scans for accidentally committed secrets.",
		category: "security",
		level: 3,
		scope: "repository",
		instructions:
			"GitHub secret scanning is enabled, OR a pre-commit / CI scanner (trufflehog, gitleaks, detect-secrets) runs on every change.",
	},
	{
		id: "single_command_setup",
		name: "Single-command setup",
		description:
			"One command takes a fresh clone to a running dev environment.",
		category: "build",
		level: 3,
		scope: "repository",
		instructions:
			"README or AGENTS.md documents a single command (or a short chain) that goes from `git clone` to a running dev environment. Examples: `make dev`, `npm install && npm run dev`, `nix develop`.",
	},
	{
		id: "release_automation",
		name: "Release automation",
		description: "Releases or deploys are automated rather than manual.",
		category: "build",
		level: 3,
		scope: "repository",
		instructions:
			"CD pipeline in .github/workflows or .gitlab-ci, semantic-release / changesets / release-please configured, GitOps manifests, or equivalent. Reduces the chance an agent-authored fix sits unreleased.",
	},
	{
		id: "release_notes_automation",
		name: "Release notes automation",
		description: "Changelogs / release notes are generated automatically.",
		category: "build",
		level: 3,
		scope: "repository",
		instructions:
			"semantic-release, standard-version, changesets, GitHub Releases automation, or a custom script that aggregates merged PRs by tag. Agents contribute to the changelog automatically rather than relying on humans to backfill it.",
	},
	{
		id: "skills",
		name: "Skills configured",
		description: "Repository defines reusable skills the agent can load.",
		category: "docs",
		level: 3,
		scope: "repository",
		instructions:
			"Skills directory exists (`.maestro/skills/`, `.claude/skills/`, `.factory/skills/`, or `.skills/`), with at least one skill folder containing a valid SKILL.md.",
	},
	{
		id: "documentation_freshness",
		name: "Documentation freshness",
		description: "Key docs were updated in the last 180 days.",
		category: "docs",
		level: 3,
		scope: "repository",
		instructions:
			'`git log --since="180 days ago" --name-only -- README.md AGENTS.md CONTRIBUTING.md` returns at least one entry. Stale top-level docs are a strong signal an agent will be misled.',
	},
	{
		id: "api_schema_docs",
		name: "API schema docs",
		description: "OpenAPI / GraphQL / gRPC schema is available.",
		category: "docs",
		level: 3,
		scope: "application",
		instructions:
			"openapi.json/yaml, *.proto, schema.graphql, or equivalent is committed. Agents can answer 'what does this API accept' without inferring from controllers.",
	},
	{
		id: "service_flow_documented",
		name: "Service flow documented",
		description: "Architecture diagrams or dependency docs exist.",
		category: "docs",
		level: 3,
		scope: "repository",
		instructions:
			"Architecture diagrams (.mermaid, .puml, docs/architecture*) or a documented dependency list (services, databases, external APIs).",
	},
	{
		id: "log_scrubbing",
		name: "Sensitive log scrubbing",
		description: "Logs sanitize PII / secrets before emission.",
		category: "security",
		level: 3,
		scope: "application",
		instructions:
			"Logging library is configured with redaction (pino redact paths, winston redaction format, structlog processors), or a custom sanitization wrapper is documented and used.",
	},
	{
		id: "test_performance_tracking",
		name: "Test performance tracked",
		description: "Test suite duration is measured and surfaced.",
		category: "testing",
		level: 4,
		scope: "application",
		instructions:
			"CI emits per-suite or per-test timing (vitest --reporter=verbose, pytest --durations=N, BuildPulse integration, Datadog CI, GitHub test reporter). Avoids the slow-suite drift that strangles iteration speed.",
	},
	{
		id: "feature_flag_infrastructure",
		name: "Feature flag infrastructure",
		description: "Feature flags exist for safe rollouts.",
		category: "build",
		level: 4,
		scope: "repository",
		instructions:
			"LaunchDarkly, Statsig, Unleash, GrowthBook, or a custom flag system is configured. Enables agents to ship changes behind toggles instead of all-at-once.",
	},
	{
		id: "deployment_frequency",
		name: "Frequent deploys",
		description: "System deploys multiple times per week.",
		category: "build",
		level: 4,
		scope: "repository",
		instructions:
			"With `gh` or `glab` authenticated: `gh release list --limit 30` shows multiple releases in the recent past, OR `gh run list --workflow=<deploy-workflow>` shows frequent runs. Without auth, infer from CHANGELOG entries and tag history.",
	},
	{
		id: "rollback_automation",
		name: "Rollback automation",
		description: "Bad deploys can be rolled back without manual surgery.",
		category: "build",
		level: 4,
		scope: "repository",
		instructions:
			"Rollback is documented and at least partially automated: `vercel rollback`, ArgoCD rollback, kubectl rollout undo, infra-as-code revert with auto-apply. Agents that ship can ship-and-revert; manual surgery is a blocker.",
		isSkippable: true,
	},
	{
		id: "progressive_rollout",
		name: "Progressive rollout",
		description: "Canary, percentage, or ring deployments are configured.",
		category: "build",
		level: 4,
		scope: "repository",
		instructions:
			"Canary / blue-green / percentage rollouts via the deploy platform (Argo Rollouts, Vercel canary, AWS CodeDeploy linear), the feature flag system, or a custom mechanism. Skip for non-infra repos.",
		isSkippable: true,
	},
	{
		id: "agents_md_validation",
		name: "AGENTS.md validation",
		description: "Automation validates AGENTS.md stays consistent with code.",
		category: "docs",
		level: 4,
		scope: "repository",
		instructions:
			"A CI job or pre-commit hook validates that AGENTS.md commands still execute, OR that referenced files/paths exist, OR re-runs documentation generation to detect drift. Requires `agents_md` to pass first.",
		requires: ["agents_md"],
	},
	{
		id: "code_quality_metrics",
		name: "Code quality dashboard",
		description: "Coverage, complexity, and maintainability are tracked.",
		category: "debugging",
		level: 4,
		scope: "application",
		instructions:
			"A code-quality dashboard exists: SonarQube, Codacy, Code Climate, or a custom Grafana / Looker view backed by repo data. Agents can pick up 'where complexity is degrading' as a target.",
	},
	{
		id: "cyclomatic_complexity",
		name: "Cyclomatic complexity tracked",
		description: "Code complexity is enforced via tooling.",
		category: "style",
		level: 5,
		scope: "application",
		instructions:
			"ESLint complexity rule, lizard, radon, gocyclo, or SonarQube complexity gates are enforced in CI. Prevents agent-authored shotgun edits from creeping past the bar.",
	},
	{
		id: "error_to_insight_pipeline",
		name: "Error-to-insight pipeline",
		description: "Errors auto-create issues / pages / tickets.",
		category: "product",
		level: 5,
		scope: "application",
		instructions:
			"Sentry / Bugsnag / Rollbar issues feed into GitHub / Linear / Jira via webhook automation, AND/OR PagerDuty integration creates tickets on incident close. Agents can pick up 'fix this specific error' as a target.",
	},
];

/**
 * EvalOps-specific layer that extends the base rubric for customers who
 * want their repos evaluated against eval-discipline criteria too.
 * Filed separately so the base rubric stays portable; consumers opt in
 * by composing `BASE_READINESS_CRITERIA` with this set.
 */
export const EVALOPS_READINESS_CRITERIA: readonly AgentReadinessCriterion[] = [
	{
		id: "eval_scenarios_defined",
		name: "Eval scenarios defined",
		description: "Repository defines reproducible eval scenarios.",
		category: "testing",
		level: 3,
		scope: "repository",
		instructions:
			"A scenarios definition file exists (evals/scenarios.json, .maestro/evals/, or equivalent). Each scenario has an id, a description, and at least one assertion. The agent can be measured against the same prompts every run.",
	},
	{
		id: "eval_regression_ci",
		name: "Eval regression CI",
		description: "Evals run in CI on agent-touched PRs.",
		category: "testing",
		level: 4,
		scope: "repository",
		instructions:
			"A CI job runs the eval suite on PRs and gates merge when the pass rate drops. Without this, agent regressions reach main silently.",
	},
	{
		id: "prompt_versioning",
		name: "Prompts versioned",
		description: "Agent prompts are versioned and reviewable.",
		category: "docs",
		level: 3,
		scope: "repository",
		instructions:
			"Agent system prompts, skill bodies, and persona prompts live in version-controlled files (not inlined as raw strings in code). Reviewers can diff prompt changes the same way they diff code.",
	},
	{
		id: "model_capability_cards",
		name: "Model capability cards",
		description: "Each routed model has a capability card.",
		category: "product",
		level: 5,
		scope: "repository",
		instructions:
			"For every model in the router's candidate set, a capability card documents strengths, weaknesses, and at least 5 score_examples drawn from real eval runs. Routes are auditable as 'why did the router pick this model'.",
	},
];

const ALL_CRITERIA: readonly AgentReadinessCriterion[] = [
	...BASE_READINESS_CRITERIA,
	...EVALOPS_READINESS_CRITERIA,
];

/** Return every known criterion (base + EvalOps layer). */
export function listAllCriteria(): readonly AgentReadinessCriterion[] {
	return ALL_CRITERIA;
}

/** Filter criteria by level (≤ maxLevel keeps lower levels too). */
export function criteriaUpToLevel(
	maxLevel: ReadinessLevel,
	criteria: readonly AgentReadinessCriterion[] = ALL_CRITERIA,
): AgentReadinessCriterion[] {
	return criteria.filter((c) => c.level <= maxLevel);
}

/** Filter criteria by category. */
export function criteriaByCategory(
	category: ReadinessCategory,
	criteria: readonly AgentReadinessCriterion[] = ALL_CRITERIA,
): AgentReadinessCriterion[] {
	return criteria.filter((c) => c.category === category);
}

/** Filter criteria by scope. */
export function criteriaByScope(
	scope: ReadinessScope,
	criteria: readonly AgentReadinessCriterion[] = ALL_CRITERIA,
): AgentReadinessCriterion[] {
	return criteria.filter((c) => c.scope === scope);
}

/**
 * Resolve dependency order. A criterion with `requires` is placed
 * after every criterion it depends on. Throws on missing dependencies
 * (caller bug) or cycles (rubric authoring bug).
 */
export function orderCriteriaByDependencies(
	criteria: readonly AgentReadinessCriterion[],
): AgentReadinessCriterion[] {
	const byId = new Map<string, AgentReadinessCriterion>();
	for (const c of criteria) {
		byId.set(c.id, c);
	}
	const ordered: AgentReadinessCriterion[] = [];
	const visiting = new Set<string>();
	const visited = new Set<string>();

	const visit = (id: string, path: string[]): void => {
		if (visited.has(id)) {
			return;
		}
		if (visiting.has(id)) {
			throw new Error(
				`Cycle detected in readiness criterion dependencies: ${[
					...path,
					id,
				].join(" -> ")}`,
			);
		}
		const criterion = byId.get(id);
		if (!criterion) {
			throw new Error(
				`Unknown readiness criterion id "${id}" referenced as a dependency`,
			);
		}
		visiting.add(id);
		for (const dep of criterion.requires ?? []) {
			visit(dep, [...path, id]);
		}
		visiting.delete(id);
		visited.add(id);
		ordered.push(criterion);
	};

	for (const c of criteria) {
		visit(c.id, []);
	}
	return ordered;
}

/**
 * Quick stats helper for surface-level reporting. Counts criteria per
 * level + per category without walking the rubric three times in the
 * UI.
 */
export function summarizeCriteria(
	criteria: readonly AgentReadinessCriterion[] = ALL_CRITERIA,
): {
	total: number;
	byLevel: Record<ReadinessLevel, number>;
	byCategory: Record<ReadinessCategory, number>;
} {
	const byLevel: Record<ReadinessLevel, number> = {
		1: 0,
		2: 0,
		3: 0,
		4: 0,
		5: 0,
	};
	const byCategory: Record<ReadinessCategory, number> = {
		docs: 0,
		build: 0,
		testing: 0,
		style: 0,
		debugging: 0,
		security: 0,
		product: 0,
	};
	for (const c of criteria) {
		byLevel[c.level] += 1;
		byCategory[c.category] += 1;
	}
	return { total: criteria.length, byLevel, byCategory };
}
