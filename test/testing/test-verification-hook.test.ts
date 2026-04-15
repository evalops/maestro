import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AutoVerifyService,
	TestResult,
} from "../../src/testing/auto-verify.js";
import { createTestVerificationStateTracker } from "../../src/testing/test-verification-hook.js";

function createResult(overrides: Partial<TestResult> = {}): TestResult {
	return {
		success: true,
		totalTests: 4,
		passedTests: 4,
		failedTests: 0,
		skippedTests: 0,
		durationMs: 1200,
		failures: [
			{
				testName: "sample test",
				testFile: "test/sample.test.ts",
				errorMessage: "boom",
				stackTrace: "stack",
				lineNumber: 12,
			},
		],
		command: "bun test",
		output: "ok",
		...overrides,
	};
}

function createServiceStub() {
	let isRunning = false;
	let dirtyFiles: string[] = [];
	let onTestComplete: ((result: TestResult) => void) | undefined;

	return {
		service: {
			setOnTestComplete(callback?: (result: TestResult) => void): void {
				onTestComplete = callback;
			},
			getOnTestComplete(): ((result: TestResult) => void) | undefined {
				return onTestComplete;
			},
			isTestRunning(): boolean {
				return isRunning;
			},
			getDirtyFiles(): string[] {
				return [...dirtyFiles];
			},
		} as unknown as AutoVerifyService,
		emit(result: TestResult): void {
			onTestComplete?.(result);
		},
		setRunning(value: boolean): void {
			isRunning = value;
		},
		setDirtyFiles(files: string[]): void {
			dirtyFiles = [...files];
		},
	};
}

describe("createTestVerificationStateTracker", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("chains an existing completion callback and restores it on destroy", () => {
		const stub = createServiceStub();
		const firstResult = createResult();
		const secondResult = createResult({
			success: false,
			passedTests: 2,
			failedTests: 2,
			command: "bun test changed",
		});
		const originalCallback = vi.fn();
		stub.service.setOnTestComplete(originalCallback);
		const nowSpy = vi.spyOn(Date, "now");
		nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(2000);

		const tracker = createTestVerificationStateTracker(stub.service);

		stub.emit(firstResult);
		expect(originalCallback).toHaveBeenCalledTimes(1);
		expect(originalCallback).toHaveBeenCalledWith(firstResult);
		expect(tracker.getState()).toEqual({
			isRunning: false,
			pendingFiles: 0,
			lastResult: firstResult,
			lastRunTime: 1000,
		});

		tracker.destroy();
		stub.emit(secondResult);

		expect(originalCallback).toHaveBeenCalledTimes(2);
		expect(originalCallback).toHaveBeenLastCalledWith(secondResult);
		expect(tracker.getState()).toEqual({
			isRunning: false,
			pendingFiles: 0,
			lastResult: firstResult,
			lastRunTime: 1000,
		});
	});

	it("returns isolated state snapshots", () => {
		const stub = createServiceStub();
		stub.setRunning(true);
		stub.setDirtyFiles(["src/a.ts", "src/b.ts"]);
		const tracker = createTestVerificationStateTracker(stub.service);
		const result = createResult();

		vi.spyOn(Date, "now").mockReturnValue(1234);
		stub.emit(result);

		const state = tracker.getState();
		expect(state.pendingFiles).toBe(2);
		expect(state.isRunning).toBe(true);

		state.lastResult!.command = "mutated";
		state.lastResult!.failures[0]!.errorMessage = "mutated";
		state.lastResult!.failures.push({
			testName: "extra",
			errorMessage: "extra",
		});

		expect(tracker.getState()).toEqual({
			isRunning: true,
			pendingFiles: 2,
			lastResult: result,
			lastRunTime: 1234,
		});
	});

	it("does not clobber a newer completion callback on destroy", () => {
		const stub = createServiceStub();
		const originalCallback = vi.fn();
		const replacementCallback = vi.fn();
		stub.service.setOnTestComplete(originalCallback);

		const tracker = createTestVerificationStateTracker(stub.service);
		stub.service.setOnTestComplete(replacementCallback);

		tracker.destroy();
		stub.emit(createResult({ command: "bun test replacement" }));

		expect(replacementCallback).toHaveBeenCalledTimes(1);
		expect(originalCallback).not.toHaveBeenCalled();
		expect(stub.service.getOnTestComplete()).toBe(replacementCallback);
	});
});
