import { inspect } from "node:util";

export interface EvalSuiteSummary {
	total: number;
	passed: number;
	failed: number;
	passRate: number;
}

export interface EvalSuiteResult<TCase, TActual = unknown> {
	testCase: TCase;
	actual: TActual;
	pass: boolean;
	mismatch: string | null;
}

export function summarizeEvalResults<TCase, TActual>(
	results: Array<EvalSuiteResult<TCase, TActual>>,
): EvalSuiteSummary {
	const total = results.length;
	const passed = results.filter((result) => result.pass).length;
	const failed = total - passed;

	return {
		total,
		passed,
		failed,
		passRate: total > 0 ? passed / total : 0,
	};
}

export function printEvalSuiteReport<
	TCase extends { name: string },
	TActual = unknown,
>(
	suiteName: string,
	results: Array<EvalSuiteResult<TCase, TActual>>,
): EvalSuiteSummary {
	const summary = summarizeEvalResults(results);

	console.log(
		`[${suiteName}] ${summary.passed}/${summary.total} passed (${(
			summary.passRate * 100
		).toFixed(1)}%)`,
	);

	for (const result of results) {
		const status = result.pass ? "PASS" : "FAIL";
		console.log(`[${status}] ${result.testCase.name}`);
		if (!result.pass && result.mismatch) {
			console.log(`  ${result.mismatch}`);
		}
	}

	return summary;
}

export function createEvalResult<TCase, TActual>(
	testCase: TCase,
	actual: TActual,
	expected: unknown,
): EvalSuiteResult<TCase, TActual> {
	const mismatch = findSubsetMismatch(expected, actual);

	return {
		testCase,
		actual,
		pass: mismatch === null,
		mismatch,
	};
}

export function findSubsetMismatch(
	expected: unknown,
	actual: unknown,
	path = "result",
): string | null {
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual)) {
			return `${path} expected an array but received ${describeValue(actual)}`;
		}

		if (actual.length !== expected.length) {
			return `${path} expected ${expected.length} item(s) but received ${actual.length}`;
		}

		for (const [index, value] of expected.entries()) {
			const mismatch = findSubsetMismatch(value, actual[index], `${path}[${index}]`);
			if (mismatch) {
				return mismatch;
			}
		}

		return null;
	}

	if (isObject(expected)) {
		if (!isObject(actual)) {
			return `${path} expected an object but received ${describeValue(actual)}`;
		}

		for (const [key, value] of Object.entries(expected)) {
			const mismatch = findSubsetMismatch(
				value,
				actual[key],
				`${path}.${key}`,
			);
			if (mismatch) {
				return mismatch;
			}
		}

		return null;
	}

	if (Object.is(expected, actual)) {
		return null;
	}

	return `${path} expected ${describeValue(expected)} but received ${describeValue(actual)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
	return inspect(value, {
		depth: 6,
		breakLength: 120,
		maxArrayLength: 10,
		sorted: true,
	});
}
