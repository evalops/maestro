import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadGuardianState, recordGuardianRun } from "./state.js";
import { DEFAULT_EXCLUDES } from "./types.js";
import type {
	GuardianEnablement,
	GuardianRunOptions,
	GuardianRunResult,
	GuardianStatus,
	GuardianToolResult,
} from "./types.js";

const GUARDIAN_DISABLE_VALUES = ["0", "false", "off", "no"];
const GUARDIAN_ENABLE_VALUES = ["1", "true", "on"];
const DEFAULT_TIMEOUT_MS = 10_000;

type FileListResult =
	| { ok: true; files: string[] }
	| { ok: false; error: string; exitCode: number };

type CommandResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
	error?: string;
	durationMs: number;
};

function commandExists(command: string, cwd: string): boolean {
	const result = spawnSync(command, ["--version"], {
		cwd,
		stdio: "pipe",
		encoding: "utf-8",
	});
	return (result.status ?? 1) === 0;
}

function runCommand(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): CommandResult {
	const started = Date.now();
	try {
		const result = spawnSync(command, args, {
			cwd,
			encoding: "utf-8",
			maxBuffer: 8 * 1024 * 1024,
			timeout: timeoutMs,
		});
		return {
			exitCode: result.status ?? 1,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			durationMs: Date.now() - started,
		};
	} catch (error) {
		return {
			exitCode: 1,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
			error: error instanceof Error ? error.message : String(error),
			durationMs: Date.now() - started,
		};
	}
}

function hasGitSecretsPlugin(root: string): boolean {
	const result = runCommand("git", ["secrets", "--help"], root, 4_000);
	return (
		result.exitCode === 0 ||
		result.stderr.includes("git secrets") ||
		result.stdout.includes("git secrets")
	);
}

function filterFiles(files: string[]): string[] {
	return files.filter((file) => {
		const normalized = file.replace(/\\/g, "/");
		return !DEFAULT_EXCLUDES.some(
			(exclude) =>
				normalized === exclude ||
				normalized.startsWith(exclude) ||
				normalized.includes(`/${exclude}`),
		);
	});
}

function listStagedFiles(root: string): FileListResult {
	const result = runCommand(
		"git",
		["diff", "--name-only", "--cached", "--diff-filter=ACMRTUXB"],
		root,
	);
	if (result.exitCode !== 0) {
		return {
			ok: false,
			error:
				result.stderr.trim() ||
				result.stdout.trim() ||
				"Unable to list staged files",
			exitCode: result.exitCode,
		};
	}
	const files = filterFiles(
		result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
	);
	return { ok: true, files };
}

function listTrackedFiles(root: string): FileListResult {
	const result = runCommand("git", ["ls-files"], root);
	if (result.exitCode !== 0) {
		return {
			ok: false,
			error:
				result.stderr.trim() ||
				result.stdout.trim() ||
				"Unable to list tracked files",
			exitCode: result.exitCode,
		};
	}
	const files = filterFiles(
		result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
	);
	return { ok: true, files };
}

function resolveEnablement(
	respectEnv: boolean | undefined,
): GuardianEnablement {
	const state = loadGuardianState();
	if (!respectEnv) {
		return { enabled: state.enabled };
	}
	const rawEnv = process.env.COMPOSER_GUARDIAN;
	if (typeof rawEnv === "string" && rawEnv.trim().length > 0) {
		const normalized = rawEnv.trim().toLowerCase();
		if (GUARDIAN_DISABLE_VALUES.includes(normalized)) {
			return {
				enabled: false,
				reason: "COMPOSER_GUARDIAN=0 (disabled)",
				envOverride: "disabled",
			};
		}
		if (GUARDIAN_ENABLE_VALUES.includes(normalized)) {
			return {
				enabled: true,
				reason: "COMPOSER_GUARDIAN=1 (forced on)",
				envOverride: "enabled",
			};
		}
	}
	return { enabled: state.enabled };
}

function locateSemgrep(
	root: string,
): { command: string; args: string[] } | null {
	if (commandExists("semgrep", root)) {
		return { command: "semgrep", args: [] };
	}
	if (commandExists("npx", root)) {
		return { command: "npx", args: ["--yes", "semgrep"] };
	}
	return null;
}

function runSemgrep(files: string[], root: string): GuardianToolResult {
	const started = Date.now();
	const cmd = locateSemgrep(root);
	if (!cmd) {
		return {
			tool: "semgrep",
			exitCode: 0,
			stdout: "",
			stderr: "",
			durationMs: Date.now() - started,
			skipped: true,
			reason: "semgrep not found",
		};
	}
	const includeArgs = files.flatMap((file) => ["--include", file]);
	const args = [
		...cmd.args,
		"scan",
		"--config",
		"p/secrets",
		"--config",
		"p/ci",
		"--json",
		"--skip-unknown-extensions",
		"--error",
		"--timeout",
		"7",
		"--metrics=off",
		"--disable-version-check",
		...includeArgs,
		".",
	];
	// Semgrep can take longer on larger workspaces; allow up to 2 minutes before timing out
	const result = runCommand(cmd.command, args, root, 120_000);
	return {
		tool: "semgrep",
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		durationMs: result.durationMs,
	};
}

function materializeStagedFiles(root: string, files: string[]): string | null {
	const tempDir = mkdtempSync(join(os.tmpdir(), "composer-guardian-staged-"));
	for (const relative of files) {
		const target = join(tempDir, relative);
		const dir = dirname(target);
		mkdirSync(dir, { recursive: true });
		const show = runCommand("git", ["show", `:${relative}`], root, 5_000);
		if (show.exitCode !== 0) {
			// skip files we fail to read from index
			continue;
		}
		try {
			writeFileSync(target, show.stdout, "utf-8");
		} catch {
			// ignore write errors for problematic files
		}
	}
	return tempDir;
}

function copyFilesToTemp(root: string, files: string[]): string | null {
	if (!files.length) return null;
	const tempDir = mkdtempSync(join(os.tmpdir(), "composer-guardian-"));
	for (const relative of files) {
		const source = resolve(root, relative);
		if (!existsSync(source)) {
			continue;
		}
		const target = join(tempDir, relative);
		const dir = dirname(target);
		mkdirSync(dir, { recursive: true });
		try {
			copyFileSync(source, target);
		} catch {
			// ignore copy errors; file may be removed
		}
	}
	return tempDir;
}

function runGitSecrets(files: string[], root: string): GuardianToolResult {
	const started = Date.now();
	if (!files.length) {
		return {
			tool: "git-secrets",
			exitCode: 0,
			stdout: "",
			stderr: "",
			durationMs: Date.now() - started,
			skipped: true,
			reason: "no files",
		};
	}

	const hasBinary = commandExists("git-secrets", root);
	const hasPlugin = !hasBinary && hasGitSecretsPlugin(root);
	if (!hasBinary && !hasPlugin) {
		return {
			tool: "git-secrets",
			exitCode: 0,
			stdout: "",
			stderr: "",
			durationMs: Date.now() - started,
			skipped: true,
			reason: "git-secrets not installed",
		};
	}

	const args = hasBinary
		? ["--scan", "--no-index", "--", ...files]
		: ["secrets", "--scan", "--no-index", "--", ...files];
	const result = runCommand(hasBinary ? "git-secrets" : "git", args, root);
	return {
		tool: "git-secrets",
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		durationMs: result.durationMs,
	};
}

function runTrufflehog(files: string[], root: string): GuardianToolResult {
	const started = Date.now();
	if (!commandExists("trufflehog", root)) {
		return {
			tool: "trufflehog",
			exitCode: 0,
			stdout: "",
			stderr: "",
			durationMs: Date.now() - started,
			skipped: true,
			reason: "trufflehog not installed",
		};
	}
	if (!files.length) {
		return {
			tool: "trufflehog",
			exitCode: 0,
			stdout: "",
			stderr: "",
			durationMs: Date.now() - started,
			skipped: true,
			reason: "no files",
		};
	}

	let tempDir: string | null = null;
	try {
		tempDir = copyFilesToTemp(root, files);
		if (!tempDir) {
			return {
				tool: "trufflehog",
				exitCode: 0,
				stdout: "",
				stderr: "",
				durationMs: Date.now() - started,
				skipped: true,
				reason: "no files",
			};
		}
		const result = runCommand(
			"trufflehog",
			["filesystem", "--no-update", "--fail", "--json", "--path", tempDir],
			tempDir,
		);
		return {
			tool: "trufflehog",
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			durationMs: result.durationMs,
		};
	} finally {
		if (tempDir) {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// best effort cleanup
			}
		}
	}
}

export type HeuristicFindingName =
	| "AWS access key"
	| "AWS secret key"
	| "Private key block"
	| "Generic API key"
	| "Slack token"
	| "GitHub token"
	| "GitLab token"
	| "Google API key"
	| "Stripe key"
	| "OpenAI API key"
	| "SendGrid API key"
	| "Twilio auth token"
	| "Discord webhook"
	| "Database URL with credentials"
	| "JWT token";

const HEURISTIC_PATTERNS: Array<{ name: HeuristicFindingName; regex: RegExp }> =
	[
		// AWS credentials
		{ name: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
		{
			name: "AWS secret key",
			// AWS secret keys are 40 characters of base64-like characters
			regex:
				/(?:aws_secret_access_key|secret_access_key|aws_secret)\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/i,
		},
		{
			name: "Private key block",
			regex: /BEGIN [A-Z ]*PRIVATE KEY/,
		},
		{
			name: "Generic API key",
			// Avoid matching natural language inside string literals while still catching
			// typical config patterns like:
			//   token: "...." / token = "...."
			//   apiKey: "...." / api_key = "...."
			// And JSON-style:
			//   "token": "...."
			regex:
				/(?:(?<!['"])\b(?:api[_-]?key|token)\b\s*[:=]\s*['"][A-Za-z0-9_-]{20,}['"]|['"](?:api[_-]?key|token)['"]\s*:\s*['"][A-Za-z0-9_-]{20,}['"])/i,
		},
		{
			name: "Slack token",
			// Slack tokens are typically segmented and include numeric IDs:
			//   xoxb-<digits>-<digits>-<secret>
			//   xapp-<digits>-<digits>-<secret>
			// Use a stricter shape to avoid false positives in tests/docs.
			regex: /\b(?:xox[baprs]|xapp)-\d{6,}(?:-\d{6,}){1,2}-[A-Za-z0-9-]{10,}\b/,
		},
		{
			name: "GitHub token",
			// GitHub tokens: ghp_ (personal), gho_ (OAuth), ghu_ (user-to-server),
			// ghs_ (server-to-server), ghr_ (refresh), github_pat_
			regex: /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{36,}\b/,
		},
		{
			name: "GitLab token",
			// GitLab personal access tokens: glpat-...
			regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/,
		},
		{
			name: "Google API key",
			// Google API keys start with AIza
			regex: /\bAIza[A-Za-z0-9_-]{35}\b/,
		},
		{
			name: "Stripe key",
			// Stripe keys: sk_live_, pk_live_, sk_test_, pk_test_, rk_live_, rk_test_
			regex: /\b[spr]k_(?:live|test)_[A-Za-z0-9]{24,}\b/,
		},
		{
			name: "OpenAI API key",
			// OpenAI keys: sk-... (typically 48+ chars total)
			regex: /\bsk-[A-Za-z0-9]{32,}\b/,
		},
		{
			name: "SendGrid API key",
			// SendGrid keys start with SG.
			regex: /\bSG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{22,}\b/,
		},
		{
			name: "Twilio auth token",
			// Twilio auth tokens in config patterns
			regex:
				/twilio[_-]?(?:auth[_-]?token|account[_-]?sid)\s*[:=]\s*['"]?[A-Za-z0-9]{32,}['"]?/i,
		},
		{
			name: "Discord webhook",
			// Discord webhook URLs contain sensitive tokens
			regex:
				/https:\/\/(?:discord(?:app)?\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/,
		},
		{
			name: "Database URL with credentials",
			// Database connection strings with embedded credentials
			// postgres://user:password@host, mysql://user:pass@host, mongodb://user:pass@host
			regex:
				/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:]+:[^@]+@[^\s'"]+/i,
		},
		{
			name: "JWT token",
			// JWT tokens have a distinctive structure: eyJ...
			// Only flag if it looks like a real token (has all three parts with decent lengths)
			regex:
				/\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
		},
	];

export function detectHeuristicFindings(
	contents: string,
): HeuristicFindingName[] {
	const matches: HeuristicFindingName[] = [];
	for (const pattern of HEURISTIC_PATTERNS) {
		if (pattern.regex.test(contents)) {
			matches.push(pattern.name);
		}
	}
	return matches;
}

function runHeuristicScan(files: string[], root: string): GuardianToolResult {
	const started = Date.now();
	const findings: string[] = [];
	const ignorePatterns = [
		/test\/enterprise\/pii-detector\.test\.ts$/,
		/test\/guardian\/heuristic-scan\.test\.ts$/,
		// The runner itself contains regex patterns that look like secrets
		/src\/guardian\/runner\.ts$/,
	];

	for (const relative of files) {
		if (ignorePatterns.some((pattern) => pattern.test(relative))) {
			continue;
		}
		const fullPath = resolve(root, relative);
		if (!existsSync(fullPath)) continue;
		let contents: string;
		try {
			const stats = statSync(fullPath);
			if (stats.size > 2 * 1024 * 1024) {
				continue;
			}
			contents = readFileSync(fullPath, "utf-8");
		} catch {
			continue;
		}
		if (contents.includes("\0")) continue; // likely binary
		for (const match of detectHeuristicFindings(contents)) {
			findings.push(`${match}: ${relative}`);
		}
	}

	if (!findings.length) {
		return {
			tool: "heuristic-scan",
			exitCode: 0,
			stdout: "",
			stderr: "",
			durationMs: Date.now() - started,
		};
	}
	return {
		tool: "heuristic-scan",
		exitCode: 1,
		stdout: findings.join("\n"),
		stderr: "",
		durationMs: Date.now() - started,
	};
}

function buildSummary(
	status: GuardianStatus,
	files: string[],
	tools: GuardianToolResult[],
	target: "staged" | "all",
	skipReason?: string,
): string {
	if (status === "skipped") {
		return `Guardian skipped (${skipReason ?? "disabled"})`;
	}
	const fileLabel = target === "staged" ? "staged file(s)" : "tracked file(s)";
	const prefix =
		status === "passed"
			? "Guardian passed"
			: status === "failed"
				? "Guardian blocked commit"
				: "Guardian error";
	const ran = tools
		.filter((tool) => !tool.skipped)
		.map((tool) => tool.tool)
		.join(" + ");
	const skipped = tools
		.filter((tool) => tool.skipped)
		.map((tool) => tool.tool)
		.join(", ");
	const toolSummary =
		ran && skipped
			? `${ran} (skipped: ${skipped})`
			: ran || (skipped ? `skipped: ${skipped}` : "");
	return `${prefix} on ${files.length} ${fileLabel}${
		toolSummary ? ` using ${toolSummary}` : ""
	}`;
}

export function formatGuardianResult(result: GuardianRunResult): string {
	const lines: string[] = [];
	lines.push(result.summary);
	lines.push(
		`Status: ${result.status} • Target: ${result.target} • Duration: ${
			result.durationMs
		}ms`,
	);
	for (const tool of result.toolResults) {
		const status =
			tool.skipped && tool.reason
				? `skipped (${tool.reason})`
				: tool.exitCode === 0
					? "clean"
					: tool.exitCode === 1
						? "findings"
						: "error";
		lines.push(
			`- ${tool.tool}: ${status} (${tool.durationMs}ms${
				tool.exitCode !== 0 ? `, exit ${tool.exitCode}` : ""
			})`,
		);
		if (tool.stdout.trim()) {
			lines.push(`  stdout: ${tool.stdout.trim()}`);
		}
		if (tool.stderr.trim()) {
			lines.push(`  stderr: ${tool.stderr.trim()}`);
		}
	}
	if (result.files?.length) {
		const preview = result.files.slice(0, 8).join(", ");
		const suffix =
			result.files.length > 8 ? ` … +${result.files.length - 8} more` : "";
		lines.push(`Files: ${preview}${suffix}`);
	}
	return lines.join("\n");
}

function pickOverallStatus(tools: GuardianToolResult[]): GuardianStatus {
	const hadError = tools.some((tool) => !tool.skipped && tool.exitCode > 1);
	if (hadError) return "error";
	const hadFindings = tools.some(
		(tool) => !tool.skipped && tool.exitCode === 1,
	);
	if (hadFindings) return "failed";
	return "passed";
}

export function shouldGuardCommand(command: string): {
	shouldGuard: boolean;
	trigger: string | null;
} {
	const inlineDisable = /COMPOSER_GUARDIAN\s*=\s*(0|false|off|no)/i;
	if (inlineDisable.test(command)) {
		return { shouldGuard: false, trigger: null };
	}
	const gitMatch = command.match(/\bgit\s+(commit|push)\b/i);
	if (gitMatch) {
		return { shouldGuard: true, trigger: `git ${gitMatch[1].toLowerCase()}` };
	}

	const destructivePatterns: Array<{ regex: RegExp; label: string }> = [
		{ regex: /\brm\s+-rf\b/i, label: "rm -rf" },
		{
			regex: /\brm\s+(?:-[a-z]*r[a-z]*\b|--recursive\b)/i,
			label: "rm -r",
		},
		{ regex: /\bfind\s+[^\n]*-delete\b/i, label: "find -delete" },
		{ regex: /\bchmod\s+0{3,4}\b/i, label: "chmod 000" },
		{ regex: /\bchown\b[^\n]*\broot\b/i, label: "chown root" },
		{ regex: /\bdd\s+if=.*\s+of=\/dev\//i, label: "dd to device" },
		{ regex: /\bmkfs\./i, label: "mkfs" },
		{ regex: /\btruncate\s+-s\s+0\b/i, label: "truncate -s 0" },
	];

	for (const pattern of destructivePatterns) {
		if (pattern.regex.test(command)) {
			return { shouldGuard: true, trigger: pattern.label };
		}
	}

	return { shouldGuard: false, trigger: null };
}

export async function runGuardian(
	options: GuardianRunOptions = {},
): Promise<GuardianRunResult> {
	const target = options.target ?? "staged";
	const root = options.root ? resolve(options.root) : process.cwd();
	let scanRoot = root;
	let snapshotDir: string | null = null;
	const enablement = resolveEnablement(options.respectEnv ?? true);
	const startedAt = Date.now();

	if (!enablement.enabled) {
		const result: GuardianRunResult = {
			status: "skipped",
			exitCode: 0,
			startedAt,
			durationMs: Date.now() - startedAt,
			target,
			trigger: options.trigger,
			filesScanned: 0,
			summary: "Guardian disabled by configuration",
			skipReason: enablement.reason ?? "disabled",
			toolResults: [],
		};
		recordGuardianRun(result);
		return result;
	}

	const filesResult =
		target === "all" ? listTrackedFiles(root) : listStagedFiles(root);
	if (!filesResult.ok) {
		const result: GuardianRunResult = {
			status: "error",
			exitCode: filesResult.exitCode,
			startedAt,
			durationMs: Date.now() - startedAt,
			target,
			trigger: options.trigger,
			filesScanned: 0,
			summary: filesResult.error,
			toolResults: [],
		};
		recordGuardianRun(result);
		return result;
	}

	const files = filesResult.files;
	if (!files.length) {
		const result: GuardianRunResult = {
			status: "skipped",
			exitCode: 0,
			startedAt,
			durationMs: Date.now() - startedAt,
			target,
			trigger: options.trigger,
			filesScanned: 0,
			summary: "No files to scan",
			skipReason: "no files",
			toolResults: [],
		};
		recordGuardianRun(result);
		return result;
	}

	if (target === "staged") {
		snapshotDir = materializeStagedFiles(root, files);
		if (snapshotDir) {
			scanRoot = snapshotDir;
		}
	}

	const toolResults: GuardianToolResult[] = [];
	const semgrep = runSemgrep(files, scanRoot);
	toolResults.push(semgrep);

	let fallback: GuardianToolResult | null = null;
	const gitSecretsResult = runGitSecrets(files, scanRoot);
	if (!gitSecretsResult.skipped) {
		fallback = gitSecretsResult;
	} else {
		const truffleResult = runTrufflehog(files, scanRoot);
		if (!truffleResult.skipped) {
			fallback = truffleResult;
		} else {
			fallback = runHeuristicScan(files, scanRoot);
		}
	}
	if (fallback) {
		toolResults.push(fallback);
	}

	const status = pickOverallStatus(toolResults);
	const exitCode =
		status === "passed"
			? 0
			: (toolResults.find((tool) => !tool.skipped && tool.exitCode !== 0)
					?.exitCode ?? 1);

	const result: GuardianRunResult = {
		status,
		exitCode,
		startedAt,
		durationMs: Date.now() - startedAt,
		target,
		trigger: options.trigger,
		filesScanned: files.length,
		files: options.quiet ? undefined : files,
		summary: buildSummary(status, files, toolResults, target),
		toolResults,
	};

	recordGuardianRun(result);

	if (snapshotDir) {
		try {
			rmSync(snapshotDir, { recursive: true, force: true });
		} catch {
			// best effort cleanup
		}
	}
	return result;
}
