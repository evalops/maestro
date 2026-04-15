/**
 * Testing utilities and automatic test verification.
 *
 * This module provides:
 * - AutoVerifyService for smart, debounced test execution
 * - Hook integration for automatic test runs after file changes
 * - TUI state tracking for test verification status
 *
 * @module testing
 */

// Core auto-verify service
export {
	AutoVerifyService,
	createAutoVerifyService,
	getGlobalAutoVerifyService,
	resetGlobalAutoVerifyService,
	getAutoVerifyConfig,
	detectTestRunner,
	buildTestCommand,
	findTestFilesForSource,
	shouldTriggerTests,
	isTestFile,
	parseTestOutput,
	formatTestResult,
	type TestRunner,
	type TestResult,
	type TestFailure,
	type AutoVerifyConfig,
} from "./auto-verify.js";

// Hook integration
export {
	registerTestVerificationHooks,
	createTestVerificationStateTracker,
	formatTestVerificationStatus,
	type TestVerificationHookOptions,
	type TestVerificationState,
} from "./test-verification-hook.js";
