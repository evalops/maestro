import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AutoVerifyService,
	type TestResult,
	buildTestCommand,
	createAutoVerifyService,
	detectTestRunner,
	findTestFilesForSource,
	formatTestResult,
	getAutoVerifyConfig,
	isTestFile,
	parseTestOutput,
	shouldTriggerTests,
} from "../../src/testing/auto-verify.js";

describe("Auto-Verify Service", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "composer-auto-verify-test-"));
		vi.resetModules();
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("getAutoVerifyConfig", () => {
		const originalEnv = process.env;

		beforeEach(() => {
			process.env = { ...originalEnv };
		});

		afterEach(() => {
			process.env = originalEnv;
		});

		it("returns default configuration", () => {
			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.COMPOSER_AUTO_TEST;
			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.COMPOSER_AUTO_TEST_DELAY;
			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.COMPOSER_AUTO_TEST_TIMEOUT;

			const config = getAutoVerifyConfig();

			expect(config.enabled).toBe(true);
			expect(config.debounceDelayMs).toBe(2000);
			expect(config.timeoutMs).toBe(60000);
			expect(config.cooldownMs).toBe(10000);
			expect(config.maxTestFiles).toBe(5);
		});

		it("respects COMPOSER_AUTO_TEST=false", () => {
			process.env.COMPOSER_AUTO_TEST = "false";

			const config = getAutoVerifyConfig();

			expect(config.enabled).toBe(false);
		});

		it("parses COMPOSER_AUTO_TEST_DELAY", () => {
			process.env.COMPOSER_AUTO_TEST_DELAY = "5000";

			const config = getAutoVerifyConfig();

			expect(config.debounceDelayMs).toBe(5000);
		});

		it("parses COMPOSER_AUTO_TEST_TIMEOUT", () => {
			process.env.COMPOSER_AUTO_TEST_TIMEOUT = "120000";

			const config = getAutoVerifyConfig();

			expect(config.timeoutMs).toBe(120000);
		});

		it("uses default for invalid numbers", () => {
			process.env.COMPOSER_AUTO_TEST_DELAY = "invalid";
			process.env.COMPOSER_AUTO_TEST_TIMEOUT = "also-invalid";

			const config = getAutoVerifyConfig();

			expect(config.debounceDelayMs).toBe(2000);
			expect(config.timeoutMs).toBe(60000);
		});

		it("uses custom command when provided", () => {
			process.env.COMPOSER_AUTO_TEST_COMMAND = "bun test";

			const config = getAutoVerifyConfig();

			expect(config.customCommand).toBe("bun test");
		});
	});

	describe("detectTestRunner", () => {
		it("detects vitest from dependencies", () => {
			const pkgPath = join(testDir, "package.json");
			writeFileSync(
				pkgPath,
				JSON.stringify({
					devDependencies: { vitest: "^1.0.0" },
				}),
			);

			const runner = detectTestRunner(testDir);

			expect(runner).toBe("vitest");
		});

		it("detects jest from dependencies", () => {
			const pkgPath = join(testDir, "package.json");
			writeFileSync(
				pkgPath,
				JSON.stringify({
					devDependencies: { jest: "^29.0.0" },
				}),
			);

			const runner = detectTestRunner(testDir);

			expect(runner).toBe("jest");
		});

		it("detects runner from test script", () => {
			const pkgPath = join(testDir, "package.json");
			writeFileSync(
				pkgPath,
				JSON.stringify({
					scripts: { test: "mocha test/**/*.js" },
				}),
			);

			const runner = detectTestRunner(testDir);

			expect(runner).toBe("mocha");
		});

		it("returns unknown when no package.json", () => {
			const runner = detectTestRunner(testDir);

			expect(runner).toBe("unknown");
		});

		it("prefers vitest over jest if both present", () => {
			const pkgPath = join(testDir, "package.json");
			writeFileSync(
				pkgPath,
				JSON.stringify({
					devDependencies: {
						vitest: "^1.0.0",
						jest: "^29.0.0",
					},
				}),
			);

			const runner = detectTestRunner(testDir);

			expect(runner).toBe("vitest");
		});
	});

	describe("buildTestCommand", () => {
		it("builds vitest command", () => {
			const command = buildTestCommand(
				"vitest",
				["test/foo.test.ts"],
				getAutoVerifyConfig(),
			);

			expect(command).toContain("npx vitest run");
			expect(command).toContain("test/foo.test.ts");
		});

		it("builds jest command", () => {
			const command = buildTestCommand(
				"jest",
				["test/bar.test.js"],
				getAutoVerifyConfig(),
			);

			expect(command).toContain("npx jest");
			expect(command).toContain("test/bar.test.js");
			expect(command).toContain("--json");
		});

		it("uses custom command when provided", () => {
			const config = { ...getAutoVerifyConfig(), customCommand: "bun test" };

			const command = buildTestCommand("vitest", ["test/foo.test.ts"], config);

			expect(command).toBe("bun test test/foo.test.ts");
		});
	});

	describe("findTestFilesForSource", () => {
		it("finds .test.ts files in same directory", () => {
			const sourceFile = join(testDir, "src/utils/helper.ts");
			const testFile = join(testDir, "src/utils/helper.test.ts");

			// Create files
			const srcDir = join(testDir, "src/utils");
			require("node:fs").mkdirSync(srcDir, { recursive: true });
			writeFileSync(sourceFile, "export const foo = 1;");
			writeFileSync(testFile, "test('foo', () => {});");

			const testFiles = findTestFilesForSource(sourceFile, testDir);

			expect(testFiles).toContain("src/utils/helper.test.ts");
		});

		it("finds .spec.ts files in same directory", () => {
			const sourceFile = join(testDir, "src/service.ts");
			const testFile = join(testDir, "src/service.spec.ts");

			// Create files
			const srcDir = join(testDir, "src");
			require("node:fs").mkdirSync(srcDir, { recursive: true });
			writeFileSync(sourceFile, "export const bar = 2;");
			writeFileSync(testFile, "test('bar', () => {});");

			const testFiles = findTestFilesForSource(sourceFile, testDir);

			expect(testFiles).toContain("src/service.spec.ts");
		});

		it("finds test files in test/ mirror directory", () => {
			const sourceFile = join(testDir, "src/lib/parser.ts");
			const testFile = join(testDir, "test/lib/parser.test.ts");

			// Create files
			require("node:fs").mkdirSync(join(testDir, "src/lib"), {
				recursive: true,
			});
			require("node:fs").mkdirSync(join(testDir, "test/lib"), {
				recursive: true,
			});
			writeFileSync(sourceFile, "export const parse = () => {};");
			writeFileSync(testFile, "test('parse', () => {});");

			const testFiles = findTestFilesForSource(sourceFile, testDir);

			expect(testFiles).toContain("test/lib/parser.test.ts");
		});

		it("returns empty array when no test files found", () => {
			const sourceFile = join(testDir, "src/no-tests.ts");

			require("node:fs").mkdirSync(join(testDir, "src"), { recursive: true });
			writeFileSync(sourceFile, "export const x = 1;");

			const testFiles = findTestFilesForSource(sourceFile, testDir);

			expect(testFiles).toEqual([]);
		});
	});

	describe("shouldTriggerTests", () => {
		it("returns true for .ts files", () => {
			const result = shouldTriggerTests("/src/file.ts", getAutoVerifyConfig());

			expect(result).toBe(true);
		});

		it("returns true for .tsx files", () => {
			const result = shouldTriggerTests(
				"/src/component.tsx",
				getAutoVerifyConfig(),
			);

			expect(result).toBe(true);
		});

		it("returns false for .md files", () => {
			const result = shouldTriggerTests("/README.md", getAutoVerifyConfig());

			expect(result).toBe(false);
		});

		it("returns false for nested .md files", () => {
			const result = shouldTriggerTests(
				"/docs/guide/README.md",
				getAutoVerifyConfig(),
			);

			expect(result).toBe(false);
		});

		it("returns false for .json files", () => {
			const result = shouldTriggerTests("/package.json", getAutoVerifyConfig());

			expect(result).toBe(false);
		});

		it("returns false for node_modules", () => {
			const result = shouldTriggerTests(
				"/node_modules/foo/index.ts",
				getAutoVerifyConfig(),
			);

			expect(result).toBe(false);
		});

		it("returns false for dist/", () => {
			const result = shouldTriggerTests(
				"/dist/bundle.js",
				getAutoVerifyConfig(),
			);

			expect(result).toBe(false);
		});

		it("returns false for .d.ts files", () => {
			const result = shouldTriggerTests(
				"/types/index.d.ts",
				getAutoVerifyConfig(),
			);

			expect(result).toBe(false);
		});
	});

	describe("isTestFile", () => {
		it("detects .test.ts files", () => {
			expect(isTestFile("/src/foo.test.ts")).toBe(true);
		});

		it("detects .spec.ts files", () => {
			expect(isTestFile("/src/foo.spec.ts")).toBe(true);
		});

		it("detects _test.ts files", () => {
			expect(isTestFile("/src/foo_test.ts")).toBe(true);
		});

		it("detects files in __tests__/", () => {
			expect(isTestFile("/src/__tests__/foo.ts")).toBe(true);
		});

		it("detects windows-style __tests__ paths", () => {
			expect(isTestFile("src\\__tests__\\foo.ts")).toBe(true);
		});

		it("detects files in test/", () => {
			expect(isTestFile("/test/integration/api.ts")).toBe(true);
		});

		it("returns false for regular source files", () => {
			expect(isTestFile("/src/utils/helper.ts")).toBe(false);
		});
	});

	describe("parseTestOutput", () => {
		it("parses generic pass output", () => {
			const output = "Tests: 10 passed, 0 failed";

			const result = parseTestOutput(output, "unknown");

			expect(result.passedTests).toBe(10);
			expect(result.failedTests).toBe(0);
		});

		it("parses generic fail output", () => {
			const output = "Tests: 8 passed, 2 failed";

			const result = parseTestOutput(output, "unknown");

			expect(result.passedTests).toBe(8);
			expect(result.failedTests).toBe(2);
		});

		it("detects FAIL markers as failures", () => {
			const output = "FAIL src/foo.test.ts\nSome test failed";

			const result = parseTestOutput(output, "unknown");

			expect(result.failures?.length).toBeGreaterThan(0);
		});
	});

	describe("formatTestResult", () => {
		it("formats successful result", () => {
			const result: TestResult = {
				success: true,
				totalTests: 10,
				passedTests: 10,
				failedTests: 0,
				skippedTests: 0,
				durationMs: 1234,
				failures: [],
				command: "npm test",
				output: "",
			};

			const formatted = formatTestResult(result);

			expect(formatted).toContain("✓ Tests passed");
			expect(formatted).toContain("10/10");
			expect(formatted).toContain("1234ms");
		});

		it("formats failed result with failures", () => {
			const result: TestResult = {
				success: false,
				totalTests: 10,
				passedTests: 8,
				failedTests: 2,
				skippedTests: 0,
				durationMs: 2000,
				failures: [
					{
						testName: "should work",
						testFile: "foo.test.ts",
						errorMessage: "Expected true but got false",
					},
				],
				command: "npm test",
				output: "",
			};

			const formatted = formatTestResult(result);

			expect(formatted).toContain("✗ Tests failed");
			expect(formatted).toContain("2/10");
			expect(formatted).toContain("should work");
			expect(formatted).toContain("foo.test.ts");
		});

		it("truncates long failure lists", () => {
			const result: TestResult = {
				success: false,
				totalTests: 20,
				passedTests: 10,
				failedTests: 10,
				skippedTests: 0,
				durationMs: 5000,
				failures: Array(10)
					.fill(null)
					.map((_, i) => ({
						testName: `test ${i + 1}`,
						errorMessage: `Error ${i + 1}`,
					})),
				command: "npm test",
				output: "",
			};

			const formatted = formatTestResult(result);

			expect(formatted).toContain("and 5 more failures");
		});
	});

	describe("AutoVerifyService", () => {
		it("creates service with detected runner", () => {
			const pkgPath = join(testDir, "package.json");
			writeFileSync(
				pkgPath,
				JSON.stringify({
					devDependencies: { vitest: "^1.0.0" },
				}),
			);

			const service = createAutoVerifyService(testDir);

			expect(service.getRunner()).toBe("vitest");
		});

		it("tracks dirty files", () => {
			const service = createAutoVerifyService(testDir);

			service.recordFileChange(join(testDir, "src/foo.ts"));
			service.recordFileChange(join(testDir, "src/bar.ts"));

			expect(service.getDirtyFiles()).toHaveLength(2);
		});

		it("clears dirty files", () => {
			const service = createAutoVerifyService(testDir);

			service.recordFileChange(join(testDir, "src/foo.ts"));
			service.clearDirtyFiles();

			expect(service.getDirtyFiles()).toHaveLength(0);
		});

		it("ignores non-code files", () => {
			const service = createAutoVerifyService(testDir);

			service.recordFileChange(join(testDir, "README.md"));
			service.recordFileChange(join(testDir, "package.json"));

			expect(service.getDirtyFiles()).toHaveLength(0);
		});

		it("reports not running initially", () => {
			const service = createAutoVerifyService(testDir);

			expect(service.isTestRunning()).toBe(false);
		});

		it("can be disabled via config", () => {
			const service = createAutoVerifyService(testDir, { enabled: false });

			// File changes should be ignored when disabled
			service.recordFileChange(join(testDir, "src/foo.ts"));

			expect(service.getDirtyFiles()).toHaveLength(0);
		});

		it("stops cleanly", () => {
			const service = createAutoVerifyService(testDir);

			service.recordFileChange(join(testDir, "src/foo.ts"));
			service.stop();

			expect(service.getDirtyFiles()).toHaveLength(0);
		});
	});
});
