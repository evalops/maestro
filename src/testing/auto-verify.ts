/**
 * Automatic Test Verification Service
 *
 * Intelligently runs tests after code changes to catch regressions early.
 * Designed to be helpful, not spammy - only runs when meaningful and scoped
 * to affected files.
 *
 * Environment variables:
 * - COMPOSER_AUTO_TEST: Enable/disable auto-testing (default: true)
 * - COMPOSER_AUTO_TEST_DELAY: Debounce delay in ms (default: 2000)
 * - COMPOSER_AUTO_TEST_TIMEOUT: Test timeout in ms (default: 60000)
 * - COMPOSER_AUTO_TEST_COMMAND: Custom test command (auto-detected if not set)
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { minimatch } from "minimatch";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("auto-verify");

const normalizeForMatch = (value: string): string => value.replace(/\\/g, "/");

/**
 * Test runner type detection.
 */
export type TestRunner =
	| "vitest"
	| "jest"
	| "mocha"
	| "ava"
	| "tap"
	| "custom"
	| "unknown";

/**
 * Result of a test run.
 */
export interface TestResult {
	/** Whether all tests passed */
	success: boolean;
	/** Total tests run */
	totalTests: number;
	/** Passed tests */
	passedTests: number;
	/** Failed tests */
	failedTests: number;
	/** Skipped tests */
	skippedTests: number;
	/** Duration in ms */
	durationMs: number;
	/** Failed test details */
	failures: TestFailure[];
	/** The command that was run */
	command: string;
	/** Raw output (truncated) */
	output: string;
}

/**
 * Details about a test failure.
 */
export interface TestFailure {
	/** Test name/description */
	testName: string;
	/** File containing the test */
	testFile?: string;
	/** Error message */
	errorMessage: string;
	/** Stack trace (if available) */
	stackTrace?: string;
	/** Line number of failure */
	line?: number;
}

/**
 * Configuration for auto-verification.
 */
export interface AutoVerifyConfig {
	/** Whether auto-testing is enabled */
	enabled: boolean;
	/** Debounce delay before running tests (ms) */
	debounceDelayMs: number;
	/** Test command timeout (ms) */
	timeoutMs: number;
	/** Custom test command (overrides auto-detection) */
	customCommand?: string;
	/** Patterns to ignore (won't trigger tests) */
	ignorePatterns: string[];
	/** Whether to run tests in watch mode detection */
	skipIfWatcherRunning: boolean;
	/** Minimum time between test runs (ms) */
	cooldownMs: number;
	/** Maximum number of test files to run at once */
	maxTestFiles: number;
}

const DEFAULT_CONFIG: AutoVerifyConfig = {
	enabled: true,
	debounceDelayMs: 2000,
	timeoutMs: 60000,
	ignorePatterns: [
		"*.md",
		"*.json",
		"*.lock",
		"*.log",
		".env*",
		"*.d.ts",
		"dist/**",
		"node_modules/**",
		"coverage/**",
	],
	skipIfWatcherRunning: true,
	cooldownMs: 10000,
	maxTestFiles: 5,
};

/**
 * Get auto-verify configuration from environment.
 */
export function getAutoVerifyConfig(): AutoVerifyConfig {
	const enabled = process.env.COMPOSER_AUTO_TEST !== "false";
	const debounceDelay = Number.parseInt(
		process.env.COMPOSER_AUTO_TEST_DELAY || "2000",
		10,
	);
	const timeout = Number.parseInt(
		process.env.COMPOSER_AUTO_TEST_TIMEOUT || "60000",
		10,
	);
	const customCommand = process.env.COMPOSER_AUTO_TEST_COMMAND;

	return {
		...DEFAULT_CONFIG,
		enabled,
		debounceDelayMs: Number.isNaN(debounceDelay)
			? DEFAULT_CONFIG.debounceDelayMs
			: debounceDelay,
		timeoutMs: Number.isNaN(timeout) ? DEFAULT_CONFIG.timeoutMs : timeout,
		customCommand,
	};
}

/**
 * Detect the test runner used in the project.
 */
export function detectTestRunner(cwd: string): TestRunner {
	const packageJsonPath = join(cwd, "package.json");
	if (!existsSync(packageJsonPath)) {
		return "unknown";
	}

	try {
		const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		const deps = {
			...pkg.dependencies,
			...pkg.devDependencies,
		};

		// Check for test runners in order of preference
		if (deps.vitest) return "vitest";
		if (deps.jest) return "jest";
		if (deps.mocha) return "mocha";
		if (deps.ava) return "ava";
		if (deps.tap) return "tap";

		// Check scripts for clues
		const testScript = pkg.scripts?.test || "";
		if (testScript.includes("vitest")) return "vitest";
		if (testScript.includes("jest")) return "jest";
		if (testScript.includes("mocha")) return "mocha";
		if (testScript.includes("ava")) return "ava";
		if (testScript.includes("tap")) return "tap";

		return "unknown";
	} catch {
		return "unknown";
	}
}

/**
 * Build the test command for a given runner and files.
 */
export function buildTestCommand(
	runner: TestRunner,
	testFiles: string[],
	config: AutoVerifyConfig,
): string {
	if (config.customCommand) {
		// If custom command, append test files
		return `${config.customCommand} ${testFiles.join(" ")}`;
	}

	const files = testFiles.join(" ");

	switch (runner) {
		case "vitest":
			return `npx vitest run ${files} --reporter=json --reporter=basic`;
		case "jest":
			return `npx jest ${files} --json --testLocationInResults`;
		case "mocha":
			return `npx mocha ${files} --reporter json`;
		case "ava":
			return `npx ava ${files} --tap`;
		case "tap":
			return `npx tap ${files}`;
		default:
			// Fallback to npm test with file hints
			return `npm test -- ${files}`;
	}
}

/**
 * Common test file patterns by convention.
 */
const TEST_FILE_PATTERNS = [
	// Same directory patterns
	(file: string) => file.replace(/\.([tj]sx?)$/, ".test.$1"),
	(file: string) => file.replace(/\.([tj]sx?)$/, ".spec.$1"),
	(file: string) => file.replace(/\.([tj]sx?)$/, "_test.$1"),

	// __tests__ directory pattern
	(file: string) => {
		const dir = dirname(file);
		const base = basename(file);
		return join(dir, "__tests__", base.replace(/\.([tj]sx?)$/, ".test.$1"));
	},

	// test/ mirror pattern (src/foo.ts -> test/foo.test.ts)
	(file: string) => {
		if (file.startsWith("src/")) {
			return file
				.replace(/^src\//, "test/")
				.replace(/\.([tj]sx?)$/, ".test.$1");
		}
		return null;
	},

	// tests/ mirror pattern
	(file: string) => {
		if (file.startsWith("src/")) {
			return file
				.replace(/^src\//, "tests/")
				.replace(/\.([tj]sx?)$/, ".test.$1");
		}
		return null;
	},
];

/**
 * Find test files for a given source file.
 */
export function findTestFilesForSource(
	sourceFile: string,
	cwd: string,
): string[] {
	const relativePath = relative(cwd, sourceFile);
	const testFiles: string[] = [];

	for (const pattern of TEST_FILE_PATTERNS) {
		const candidate = pattern(relativePath);
		if (candidate) {
			const fullPath = join(cwd, candidate);
			if (existsSync(fullPath)) {
				testFiles.push(candidate);
			}
		}
	}

	return testFiles;
}

/**
 * Check if a file should trigger test runs.
 */
export function shouldTriggerTests(
	filePath: string,
	config: AutoVerifyConfig,
): boolean {
	// Only trigger for code files
	const codeExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
	const ext = filePath.substring(filePath.lastIndexOf("."));
	if (!codeExtensions.includes(ext)) {
		return false;
	}

	// Quick check for common exclusion paths (works with any path format)
	const normalizedLower = normalizeForMatch(filePath).toLowerCase();
	if (
		normalizedLower.includes("/node_modules/") ||
		normalizedLower.includes("/dist/") ||
		normalizedLower.includes("/coverage/") ||
		normalizedLower.endsWith(".d.ts")
	) {
		return false;
	}

	// Get relative path for pattern matching
	const relativePath = isAbsolute(filePath)
		? relative(process.cwd(), filePath)
		: filePath;

	// Check ignore patterns
	for (const pattern of config.ignorePatterns) {
		if (matchGlob(relativePath, pattern)) {
			return false;
		}
	}

	return true;
}

/**
 * Simple glob matching (supports * and **).
 */
function matchGlob(path: string, pattern: string): boolean {
	const normalizedPath = normalizeForMatch(path);
	const normalizedPattern = normalizeForMatch(pattern);
	return minimatch(normalizedPath, normalizedPattern, {
		dot: true,
		matchBase: true,
		nobrace: true,
		noext: true,
		nocomment: true,
		nocase: process.platform === "win32",
	});
}

/**
 * Check if a test file changed (not source).
 */
export function isTestFile(filePath: string): boolean {
	const name = basename(filePath);
	const normalizedPath = normalizeForMatch(filePath);
	return (
		name.includes(".test.") ||
		name.includes(".spec.") ||
		name.includes("_test.") ||
		normalizedPath.includes("__tests__/") ||
		normalizedPath.includes("/test/") ||
		normalizedPath.includes("/tests/")
	);
}

/**
 * Parse test results from runner output.
 */
export function parseTestOutput(
	output: string,
	runner: TestRunner,
): Partial<TestResult> {
	try {
		switch (runner) {
			case "vitest":
				return parseVitestOutput(output);
			case "jest":
				return parseJestOutput(output);
			default:
				return parseGenericOutput(output);
		}
	} catch {
		return parseGenericOutput(output);
	}
}

/**
 * Parse Vitest JSON output.
 */
function parseVitestOutput(output: string): Partial<TestResult> {
	// Try to extract JSON from output
	const jsonMatch = output.match(/\{[\s\S]*"numTotalTests"[\s\S]*\}/);
	if (!jsonMatch) {
		return parseGenericOutput(output);
	}

	try {
		const json = JSON.parse(jsonMatch[0]);
		const failures: TestFailure[] = [];

		if (json.testResults) {
			for (const file of json.testResults) {
				for (const test of file.assertionResults || []) {
					if (test.status === "failed") {
						failures.push({
							testName: test.fullName || test.title,
							testFile: file.name,
							errorMessage: test.failureMessages?.join("\n") || "Test failed",
						});
					}
				}
			}
		}

		return {
			totalTests: json.numTotalTests || 0,
			passedTests: json.numPassedTests || 0,
			failedTests: json.numFailedTests || 0,
			skippedTests: json.numPendingTests || 0,
			failures,
		};
	} catch {
		return parseGenericOutput(output);
	}
}

/**
 * Parse Jest JSON output.
 */
function parseJestOutput(output: string): Partial<TestResult> {
	// Try to extract JSON from output
	const jsonMatch = output.match(/\{[\s\S]*"numTotalTests"[\s\S]*\}/);
	if (!jsonMatch) {
		return parseGenericOutput(output);
	}

	try {
		const json = JSON.parse(jsonMatch[0]);
		const failures: TestFailure[] = [];

		if (json.testResults) {
			for (const file of json.testResults) {
				for (const test of file.assertionResults || []) {
					if (test.status === "failed") {
						failures.push({
							testName: test.fullName || test.title,
							testFile: file.name,
							errorMessage: test.failureMessages?.join("\n") || "Test failed",
							line: test.location?.line,
						});
					}
				}
			}
		}

		return {
			totalTests: json.numTotalTests || 0,
			passedTests: json.numPassedTests || 0,
			failedTests: json.numFailedTests || 0,
			skippedTests: json.numPendingTests || 0,
			failures,
		};
	} catch {
		return parseGenericOutput(output);
	}
}

/**
 * Parse generic test output (heuristics).
 */
function parseGenericOutput(output: string): Partial<TestResult> {
	const failures: TestFailure[] = [];

	// Look for common failure patterns
	const failurePatterns = [
		/FAIL\s+(.+)/g,
		/✗\s+(.+)/g,
		/✖\s+(.+)/g,
		/Error:\s+(.+)/g,
		/AssertionError:\s+(.+)/g,
	];

	for (const pattern of failurePatterns) {
		let match = pattern.exec(output);
		while (match !== null) {
			const matchedText = match[1];
			if (matchedText) {
				failures.push({
					testName: matchedText.trim(),
					errorMessage: matchedText.trim(),
				});
			}
			match = pattern.exec(output);
		}
	}

	// Try to extract counts from common formats
	const passMatch = output.match(/(\d+)\s+pass(?:ed|ing)?/i);
	const failMatch = output.match(/(\d+)\s+fail(?:ed|ing)?/i);
	const skipMatch = output.match(/(\d+)\s+skip(?:ped)?/i);

	const passed = passMatch ? Number.parseInt(passMatch[1]!, 10) : 0;
	const failed = failMatch
		? Number.parseInt(failMatch[1]!, 10)
		: failures.length;
	const skipped = skipMatch ? Number.parseInt(skipMatch[1]!, 10) : 0;

	return {
		totalTests: passed + failed + skipped,
		passedTests: passed,
		failedTests: failed,
		skippedTests: skipped,
		failures,
	};
}

/**
 * Dirty file tracker for debouncing.
 */
interface DirtyFileTracker {
	files: Set<string>;
	lastModified: number;
	debounceTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Auto-verification service.
 */
export class AutoVerifyService {
	private config: AutoVerifyConfig;
	private cwd: string;
	private runner: TestRunner;
	private tracker: DirtyFileTracker;
	private lastTestRun = 0;
	private isRunning = false;
	private onTestComplete?: (result: TestResult) => void;

	constructor(cwd: string, config?: Partial<AutoVerifyConfig>) {
		this.config = { ...getAutoVerifyConfig(), ...config };
		this.cwd = cwd;
		this.runner = detectTestRunner(cwd);
		this.tracker = {
			files: new Set(),
			lastModified: 0,
			debounceTimer: null,
		};

		logger.info("AutoVerifyService initialized", {
			runner: this.runner,
			enabled: this.config.enabled,
		});
	}

	/**
	 * Set callback for test completion.
	 */
	setOnTestComplete(callback: (result: TestResult) => void): void {
		this.onTestComplete = callback;
	}

	/**
	 * Record a file change (from tool execution).
	 */
	recordFileChange(filePath: string): void {
		if (!this.config.enabled) return;
		if (!shouldTriggerTests(filePath, this.config)) return;

		this.tracker.files.add(filePath);
		this.tracker.lastModified = Date.now();

		logger.debug("File change recorded", { filePath });

		// Reset debounce timer
		if (this.tracker.debounceTimer) {
			clearTimeout(this.tracker.debounceTimer);
		}

		this.tracker.debounceTimer = setTimeout(() => {
			this.maybeRunTests();
		}, this.config.debounceDelayMs);
	}

	/**
	 * Check if we should run tests and do so if appropriate.
	 */
	private async maybeRunTests(): Promise<void> {
		// Skip if already running
		if (this.isRunning) {
			logger.debug("Skipping test run - already running");
			return;
		}

		// Skip if no dirty files
		if (this.tracker.files.size === 0) {
			logger.debug("Skipping test run - no dirty files");
			return;
		}

		// Skip if cooldown hasn't passed
		const timeSinceLastRun = Date.now() - this.lastTestRun;
		if (timeSinceLastRun < this.config.cooldownMs) {
			logger.debug("Skipping test run - cooldown active", {
				remaining: this.config.cooldownMs - timeSinceLastRun,
			});
			return;
		}

		// Find test files for dirty source files
		const testFiles = new Set<string>();
		for (const file of this.tracker.files) {
			if (isTestFile(file)) {
				// If the test file itself changed, run it directly
				testFiles.add(relative(this.cwd, file));
			} else {
				// Find associated test files
				const associated = findTestFilesForSource(file, this.cwd);
				for (const tf of associated) {
					testFiles.add(tf);
				}
			}
		}

		if (testFiles.size === 0) {
			logger.debug("No test files found for changed files");
			this.tracker.files.clear();
			return;
		}

		// Limit test files
		const filesToRun = Array.from(testFiles).slice(0, this.config.maxTestFiles);

		logger.info("Running tests", {
			testFiles: filesToRun,
			changedFiles: Array.from(this.tracker.files),
		});

		// Clear tracker before running
		this.tracker.files.clear();

		await this.runTests(filesToRun);
	}

	/**
	 * Force running tests for specific files.
	 */
	async runTests(testFiles: string[]): Promise<TestResult> {
		this.isRunning = true;
		this.lastTestRun = Date.now();
		const startTime = Date.now();

		const command = buildTestCommand(this.runner, testFiles, this.config);

		try {
			const { execSync } = await import("node:child_process");

			let output: string;
			let success: boolean;

			try {
				output = execSync(command, {
					cwd: this.cwd,
					timeout: this.config.timeoutMs,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
					maxBuffer: 10 * 1024 * 1024, // 10MB
				});
				success = true;
			} catch (error) {
				// Test failures cause non-zero exit
				const execError = error as { stdout?: string; stderr?: string };
				output = (execError.stdout || "") + (execError.stderr || "");
				success = false;
			}

			const durationMs = Date.now() - startTime;
			const parsed = parseTestOutput(output, this.runner);

			const result: TestResult = {
				success: success && (parsed.failedTests || 0) === 0,
				totalTests: parsed.totalTests || 0,
				passedTests: parsed.passedTests || 0,
				failedTests: parsed.failedTests || 0,
				skippedTests: parsed.skippedTests || 0,
				durationMs,
				failures: parsed.failures || [],
				command,
				output: output.slice(-5000), // Keep last 5KB
			};

			logger.info("Test run complete", {
				success: result.success,
				passed: result.passedTests,
				failed: result.failedTests,
				durationMs,
			});

			this.onTestComplete?.(result);
			return result;
		} catch (error) {
			const durationMs = Date.now() - startTime;
			const errorMessage =
				error instanceof Error ? error.message : String(error);

			const result: TestResult = {
				success: false,
				totalTests: 0,
				passedTests: 0,
				failedTests: 0,
				skippedTests: 0,
				durationMs,
				failures: [
					{
						testName: "Test execution",
						errorMessage: `Failed to run tests: ${errorMessage}`,
					},
				],
				command,
				output: errorMessage,
			};

			logger.error("Test run failed", undefined, {
				errorMessage,
				durationMs,
			});

			this.onTestComplete?.(result);
			return result;
		} finally {
			this.isRunning = false;
		}
	}

	/**
	 * Run all tests (not scoped).
	 */
	async runAllTests(): Promise<TestResult> {
		const command = this.config.customCommand || this.getDefaultTestCommand();
		this.isRunning = true;
		this.lastTestRun = Date.now();
		const startTime = Date.now();

		try {
			const { execSync } = await import("node:child_process");

			let output: string;
			let success: boolean;

			try {
				output = execSync(command, {
					cwd: this.cwd,
					timeout: this.config.timeoutMs * 3, // Longer timeout for full run
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
					maxBuffer: 50 * 1024 * 1024, // 50MB for full output
				});
				success = true;
			} catch (error) {
				const execError = error as { stdout?: string; stderr?: string };
				output = (execError.stdout || "") + (execError.stderr || "");
				success = false;
			}

			const durationMs = Date.now() - startTime;
			const parsed = parseTestOutput(output, this.runner);

			const result: TestResult = {
				success: success && (parsed.failedTests || 0) === 0,
				totalTests: parsed.totalTests || 0,
				passedTests: parsed.passedTests || 0,
				failedTests: parsed.failedTests || 0,
				skippedTests: parsed.skippedTests || 0,
				durationMs,
				failures: parsed.failures || [],
				command,
				output: output.slice(-10000), // Keep last 10KB
			};

			this.onTestComplete?.(result);
			return result;
		} catch (error) {
			const durationMs = Date.now() - startTime;
			const errorMessage =
				error instanceof Error ? error.message : String(error);

			const result: TestResult = {
				success: false,
				totalTests: 0,
				passedTests: 0,
				failedTests: 0,
				skippedTests: 0,
				durationMs,
				failures: [
					{
						testName: "Test execution",
						errorMessage: `Failed to run tests: ${errorMessage}`,
					},
				],
				command,
				output: errorMessage,
			};

			this.onTestComplete?.(result);
			return result;
		} finally {
			this.isRunning = false;
		}
	}

	/**
	 * Get the default test command based on detected runner.
	 */
	private getDefaultTestCommand(): string {
		switch (this.runner) {
			case "vitest":
				return "npx vitest run";
			case "jest":
				return "npx jest";
			case "mocha":
				return "npx mocha";
			case "ava":
				return "npx ava";
			case "tap":
				return "npx tap";
			default:
				return "npm test";
		}
	}

	/**
	 * Check if currently running tests.
	 */
	isTestRunning(): boolean {
		return this.isRunning;
	}

	/**
	 * Get the detected test runner.
	 */
	getRunner(): TestRunner {
		return this.runner;
	}

	/**
	 * Get configuration.
	 */
	getConfig(): AutoVerifyConfig {
		return { ...this.config };
	}

	/**
	 * Update configuration.
	 */
	setConfig(config: Partial<AutoVerifyConfig>): void {
		this.config = { ...this.config, ...config };
	}

	/**
	 * Get current dirty files.
	 */
	getDirtyFiles(): string[] {
		return Array.from(this.tracker.files);
	}

	/**
	 * Clear dirty files without running tests.
	 */
	clearDirtyFiles(): void {
		this.tracker.files.clear();
		if (this.tracker.debounceTimer) {
			clearTimeout(this.tracker.debounceTimer);
			this.tracker.debounceTimer = null;
		}
	}

	/**
	 * Stop the service.
	 */
	stop(): void {
		if (this.tracker.debounceTimer) {
			clearTimeout(this.tracker.debounceTimer);
			this.tracker.debounceTimer = null;
		}
		this.tracker.files.clear();
	}
}

/**
 * Create an auto-verify service.
 */
export function createAutoVerifyService(
	cwd: string,
	config?: Partial<AutoVerifyConfig>,
): AutoVerifyService {
	return new AutoVerifyService(cwd, config);
}

/**
 * Global shared auto-verify service instance.
 */
let globalAutoVerifyService: AutoVerifyService | null = null;

/**
 * Get or create the global auto-verify service.
 */
export function getGlobalAutoVerifyService(cwd?: string): AutoVerifyService {
	if (!globalAutoVerifyService) {
		globalAutoVerifyService = createAutoVerifyService(cwd || process.cwd());
	}
	return globalAutoVerifyService;
}

/**
 * Reset the global auto-verify service (for testing).
 */
export function resetGlobalAutoVerifyService(): void {
	if (globalAutoVerifyService) {
		globalAutoVerifyService.stop();
		globalAutoVerifyService = null;
	}
}

/**
 * Format test result for display.
 */
export function formatTestResult(result: TestResult): string {
	const lines: string[] = [];

	if (result.success) {
		lines.push(
			`✓ Tests passed: ${result.passedTests}/${result.totalTests} (${result.durationMs}ms)`,
		);
	} else {
		lines.push(
			`✗ Tests failed: ${result.failedTests}/${result.totalTests} (${result.durationMs}ms)`,
		);

		if (result.failures.length > 0) {
			lines.push("");
			lines.push("Failures:");
			for (const failure of result.failures.slice(0, 5)) {
				const location = failure.testFile
					? ` (${failure.testFile}${failure.line ? `:${failure.line}` : ""})`
					: "";
				lines.push(`  • ${failure.testName}${location}`);
				if (failure.errorMessage) {
					const msg = failure.errorMessage.split("\n")[0]?.slice(0, 100) ?? "";
					lines.push(`    ${msg}`);
				}
			}
			if (result.failures.length > 5) {
				lines.push(`  ... and ${result.failures.length - 5} more failures`);
			}
		}
	}

	return lines.join("\n");
}
