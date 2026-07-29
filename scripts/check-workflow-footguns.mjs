#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));

function readIfExists(path) {
	if (!existsSync(path)) return "";
	return readFileSync(path, "utf8");
}

function workflowStepBlocks(workflowText) {
	const blocks = [];
	let current = [];
	for (const line of workflowText.split("\n")) {
		if (/^\s{6}-\s/.test(line) && current.length > 0) {
			blocks.push(current.join("\n"));
			current = [line];
			continue;
		}
		if (current.length > 0 || /^\s{6}-\s/.test(line)) {
			current.push(line);
		}
	}
	if (current.length > 0) {
		blocks.push(current.join("\n"));
	}
	return blocks;
}

function manifestMirrorsWorkflowFiles(root) {
	const manifestPath = join(root, ".github/release-mirror-manifest.json");
	if (!existsSync(manifestPath)) return false;
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	return Array.isArray(manifest.files)
		? manifest.files.some(
				(file) =>
					typeof file === "string" && file.startsWith(".github/workflows/"),
			)
		: false;
}

function evaluateEvalOpsBotDispatch(root) {
	const failures = [];
	const path = join(root, ".github/workflows/evalopsbot-review-request.yml");
	const workflowText = readIfExists(path);
	if (!workflowText) return failures;

	const hasTokenResolver =
		/\bid:\s*dispatch-token\b/.test(workflowText) &&
		/configured=false/.test(workflowText) &&
		/::warning::.*EVALOPS_PR_LENS_TOKEN/.test(workflowText);
	const hasHardFailure =
		/::error::Set EVALOPS_PR_LENS_TOKEN/.test(workflowText) ||
		/exit\s+[1-9]\d*/.test(
			workflowStepBlocks(workflowText)
				.filter((block) => /EVALOPS_PR_LENS_TOKEN|GH_TOKEN/.test(block))
				.join("\n"),
		);

	if (!hasTokenResolver || hasHardFailure) {
		failures.push(
			".github/workflows/evalopsbot-review-request.yml: dispatch token must skip gracefully when EVALOPS_PR_LENS_TOKEN is unavailable",
		);
	}

	const ungatedDispatchSteps = workflowStepBlocks(workflowText).filter(
		(block) =>
			/gh api\b/.test(block) &&
			!/if:\s*\$\{\{\s*steps\.dispatch-token\.outputs\.configured\s*==\s*'true'\s*\}\}/.test(
				block,
			),
	);
	if (ungatedDispatchSteps.length > 0) {
		failures.push(
			".github/workflows/evalopsbot-review-request.yml: gh api dispatch/status steps must be gated on steps.dispatch-token.outputs.configured == 'true'",
		);
	}

	return failures;
}

function evaluatePublicMirrorWorkflowBoundary(root) {
	const failures = [];
	if (manifestMirrorsWorkflowFiles(root)) {
		failures.push(
			".github/release-mirror-manifest.json: public workflows are public-owned and must not be mirrored from internal",
		);
	}

	const prepareScript = readIfExists(
		join(root, "scripts/prepare-public-release-mirror.mjs"),
	);
	if (/PUBLIC_INCLUDE_OVERRIDES[\s\S]*?\.github\/workflows\//.test(prepareScript)) {
		failures.push(
			"scripts/prepare-public-release-mirror.mjs: public workflow files must not be re-included by mirror preparation",
		);
	}

	for (const workflowPath of [
		".github/workflows/public-release-mirror.yml",
		".github/workflows/sync-public-release-mirror.yml",
	]) {
		const workflowText = readIfExists(join(root, workflowPath));
		if (!workflowText) continue;

		const appTokenBlocks = workflowStepBlocks(workflowText).filter((block) =>
			/actions\/create-github-app-token@/.test(block),
		);
		for (const block of appTokenBlocks) {
			if (/permission-workflows:\s*write\b/.test(block)) {
				failures.push(
					`${workflowPath}: public mirror App must remain contents-only because public owns workflow files`,
				);
			}
			if (!/permission-contents:\s*write\b/.test(block)) {
				failures.push(
					`${workflowPath}: public mirror App must request permission-contents: write`,
				);
			}
			if (!/permission-pull-requests:\s*write\b/.test(block)) {
				failures.push(
					`${workflowPath}: public mirror App must request permission-pull-requests: write to maintain generated mirror PRs`,
				);
			}
		}
		if (!/git status --porcelain -- \.github\/workflows/.test(workflowText)) {
			failures.push(
				`${workflowPath}: mirror publication must fail if public-owned workflow files change`,
			);
		}
	}

	return failures;
}

/**
 * PR CI must not steal a trusted self-hosted lane (e.g. `evalops-internal`)
 * by hard-coding it straight into a job's runs-on:, bypassing the vars.*
 * indirection that lets ops repoint the fleet without editing every
 * workflow.
 *
 * Policy: every job in a workflow whose trigger set includes `pull_request`
 * must have at least one `vars.` reference somewhere in its runs-on: value.
 * A literal fallback *inside* a vars expression is fine — e.g.
 * `${{ vars.PR_CHECKS_RUNNER || 'evalops-internal' }}` is compliant, because
 * the indirection is what matters, not what it falls back to. A runs-on:
 * value with no vars.* reference at all that names a self-hosted-looking
 * label (matches /evalops-|self-hosted/i) is the footgun this rejects.
 * GitHub-hosted labels (ubuntu-latest, macos-15, etc.) hard-coded bare are
 * out of scope: they're not "stealing" anything private.
 *
 * Reachability is judged at the workflow level (does `on:` declare a
 * `pull_request:` trigger at all), not per-job `if:` conditions — a job
 * gated to skip on pull_request gets over-scanned rather than under-scanned,
 * which is the safe direction for a guardrail.
 */
function hasPullRequestTrigger(workflowText) {
	const lines = workflowText.split("\n");
	let inOnBlock = false;
	let onInline = "";
	for (const rawLine of lines) {
		if (!inOnBlock) {
			const match = /^on:\s*(.*)$/.exec(rawLine);
			if (match) {
				inOnBlock = true;
				onInline = match[1].trim();
			}
			continue;
		}
		// A new top-level (column 0) key ends the on: block.
		if (/^\S/.test(rawLine) && rawLine.trim() !== "") break;
		if (/^\s*pull_request:\s*(#.*)?$/.test(rawLine)) return true;
	}
	if (onInline) {
		// Bare (`on: pull_request`) or flow-style (`on: [pull_request, push]`).
		return /\bpull_request\b/.test(onInline);
	}
	return false;
}

/** Every runs-on: value in a workflow, inline or block-list style, raw text. */
function extractRunsOnValues(workflowText) {
	const lines = workflowText.split("\n");
	const values = [];
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^(\s*)runs-on:\s*(.*)$/.exec(lines[index]);
		if (!match) continue;
		const [, indent, inline] = match;
		const trimmedInline = stripComment(inline).trim();
		if (trimmedInline) {
			values.push(trimmedInline);
			continue;
		}
		// Block-list style (e.g. `runs-on:\n  - self-hosted\n  - Linux`).
		const baseIndent = indent.length;
		let block = "";
		for (let next = index + 1; next < lines.length; next += 1) {
			const nextLine = lines[next];
			if (!nextLine.trim()) continue;
			const nextIndent = nextLine.length - nextLine.trimStart().length;
			if (nextIndent <= baseIndent) break;
			block += `${stripComment(nextLine).trim()}\n`;
		}
		if (block) values.push(block);
	}
	return values;
}

function stripComment(line) {
	const hashIndex = line.indexOf("#");
	if (hashIndex === -1) return line;
	// Good enough for runs-on: values, which never contain a literal `#`.
	return line.slice(0, hashIndex);
}

function evaluatePullRequestRunnerOverrides(root) {
	const failures = [];
	const workflowsDir = join(root, ".github/workflows");
	if (!existsSync(workflowsDir)) return failures;

	for (const entry of readdirSync(workflowsDir)) {
		if (!/\.ya?ml$/u.test(entry)) continue;
		const workflowFile = `.github/workflows/${entry}`;
		const workflowText = readIfExists(join(workflowsDir, entry));
		if (!workflowText || !hasPullRequestTrigger(workflowText)) continue;

		for (const runsOn of extractRunsOnValues(workflowText)) {
			if (/\bvars\./.test(runsOn)) continue;
			if (/evalops-|self-hosted/i.test(runsOn)) {
				const flat = runsOn.trim().replace(/\s+/g, " ");
				failures.push(
					`${workflowFile}: pull_request-triggered job hard-codes a self-hosted runner (runs-on: ${flat}) with no vars.* indirection; route through vars.PR_CHECKS_RUNNER (or similar) so the fleet can be repointed without editing the workflow`,
				);
			}
		}
	}

	return failures;
}

/**
 * Blacksmith runners are retired org-wide (owner decision 2026-07-20).
 * Fail any workflow, composite action, or actionlint config that still
 * references a blacksmith-* runner label or a BLACKSMITH_* fallback var so
 * the fleet cannot silently creep back in. Scans all of .github/ (not just
 * .github/workflows/) so a composite action under .github/actions/** or the
 * self-hosted-runner label registry in .github/actionlint.yaml can't
 * reintroduce a reference unnoticed.
 */
function evaluateNoBlacksmithReferences(root) {
	const failures = [];
	const githubDir = join(root, ".github");
	if (!existsSync(githubDir)) return failures;

	for (const entry of readdirSync(githubDir, { recursive: true })) {
		if (!/\.ya?ml$/.test(entry)) continue;
		const relativePath = `.github/${entry.split(sep).join("/")}`;
		const fileText = readIfExists(join(root, relativePath));
		if (/blacksmith/i.test(fileText)) {
			failures.push(
				`${relativePath}: Blacksmith runners are retired; use GitHub-hosted runners (e.g. ubuntu-latest, macos-15, ubuntu-24.04-arm) instead of blacksmith-* labels or BLACKSMITH_* vars`,
			);
		}
	}

	return failures;
}

function githubYamlFiles(root) {
	const githubDir = join(root, ".github");
	if (!existsSync(githubDir)) return [];
	const files = [];
	for (const entry of readdirSync(githubDir, { recursive: true })) {
		if (!/\.ya?ml$/.test(entry)) continue;
		const relativePath = `.github/${entry.split(sep).join("/")}`;
		if (
			!relativePath.startsWith(".github/workflows/") &&
			!relativePath.startsWith(".github/actions/")
		) {
			continue;
		}
		files.push(relativePath);
	}
	return files.sort();
}

/**
 * Yield every line that belongs to the body of a `run:` step, as
 * `{ line, lineNumber }`. Handles both block scalars (`run: |`) and the
 * single-line form (`run: some command`).
 */
function runBodyLines(fileText) {
	const lines = fileText.split("\n");
	const found = [];
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^(\s*)(-\s+)?run:(\s*[|>][-+0-9]*\s*)?(.*)$/.exec(
			lines[index],
		);
		if (!match) continue;
		const keyIndent = match[1].length + (match[2] ? match[2].length : 0);

		if (!match[3]) {
			// Single-line `run: command`.
			if (match[4].trim() !== "") {
				found.push({ line: match[4], lineNumber: index + 1 });
			}
			continue;
		}

		let bodyIndent = null;
		for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
			const line = lines[cursor];
			if (line.trim() === "") continue;
			const indent = line.length - line.trimStart().length;
			if (bodyIndent === null) {
				if (indent <= keyIndent) break;
				bodyIndent = indent;
			}
			if (indent < bodyIndent) break;
			found.push({ line, lineNumber: cursor + 1 });
		}
	}
	return found;
}

// A heredoc redirection: `<<DELIM`, `<<-DELIM`, `<<'DELIM'`, `<<"DELIM"`.
// The leading `(^|[\s(])` keeps `echo "token<<EOF"` (a $GITHUB_OUTPUT
// delimiter string, not a redirection) out of the match, and `(?!<)` keeps
// herestrings (`<<<"$value"`) out.
const HEREDOC_OPENER = /(?:^|[\s(])<<-?(?!<)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;

/**
 * Shell-injection surface in workflow `run:` bodies.
 *
 * Two rules, both about text reaching a shell parser that should only ever
 * have reached a variable:
 *
 * 1. Heredoc delimiters must be quoted (`<<'EOF'`). An unquoted delimiter makes
 *    the heredoc body a shell-expansion context, so every `$(...)`, backtick,
 *    and `${...}` written into it — including anything an Actions expression
 *    substituted into the workflow text first — is evaluated by the shell.
 *
 * 2. `${{ ... }}` must never appear inside a `run:` body. Actions substitutes
 *    those expressions into the script *as text* before bash ever sees it, so
 *    a value containing a quote or `$(` becomes script. Quoting a heredoc
 *    delimiter does not help here: substitution happens a layer above the
 *    shell. Bind the value to `env:` and reference `"$NAME"` instead.
 *
 * Both rules are what keeps attacker-influenced text (commit subjects, PR
 * titles, comment bodies, branch names) from reaching a shell on the
 * self-hosted runners that hold release and provider credentials.
 */
function evaluateRunBlockShellSafety(root) {
	const failures = [];

	for (const relativePath of githubYamlFiles(root)) {
		const fileText = readIfExists(join(root, relativePath));
		if (!fileText) continue;

		for (const { line, lineNumber } of runBodyLines(fileText)) {
			// A whole-line shell comment cannot open a heredoc, so prose about
			// heredocs does not trip rule 1. It is still checked against rule 2:
			// an Actions expression that expands to a newline escapes the
			// comment and lands in the script.
			const isWholeLineComment = /^\s*#/.test(line);

			if (!isWholeLineComment) {
				for (const match of line.matchAll(HEREDOC_OPENER)) {
					const [quote, delimiter] = [match[1], match[2]];
					if (quote === "") {
						failures.push(
							`${relativePath}:${lineNumber}: unquoted heredoc delimiter \`<<${delimiter}\` makes the heredoc body a shell-expansion context; write \`<<'${delimiter}'\` and pass interpolated values through printf '%s' or a file`,
						);
					}
				}
			}

			if (line.includes("${{")) {
				failures.push(
					`${relativePath}:${lineNumber}: \`\${{ ... }}\` is substituted into the script as text before bash parses it; bind the value to the step's \`env:\` and reference "$NAME" instead`,
				);
			}
		}
	}

	return failures;
}

export function evaluateWorkflowFootguns({ root = defaultRoot } = {}) {
	return [
		...evaluateEvalOpsBotDispatch(root),
		...evaluatePublicMirrorWorkflowBoundary(root),
		...evaluatePullRequestRunnerOverrides(root),
		...evaluateNoBlacksmithReferences(root),
		...evaluateRunBlockShellSafety(root),
	];
}

function main() {
	const failures = evaluateWorkflowFootguns({ root: process.cwd() });
	if (failures.length === 0) {
		console.log("Workflow footgun guardrails passed.");
		return;
	}
	for (const failure of failures) {
		console.error(failure);
	}
	process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
