/**
 * Result Type - Explicit error handling without exceptions
 *
 * Provides a type-safe way to handle operations that can fail,
 * making error handling explicit in function signatures.
 *
 * @example
 * ```typescript
 * function parseJson(text: string): Result<object, string> {
 *   try {
 *     return ok(JSON.parse(text));
 *   } catch (e) {
 *     return err(`Invalid JSON: ${e.message}`);
 *   }
 * }
 *
 * const result = parseJson('{"key": "value"}');
 * if (result.ok) {
 *   console.log(result.value);
 * } else {
 *   console.error(result.error);
 * }
 * ```
 */

/**
 * A Result type representing either success (Ok) or failure (Err)
 */
export type Result<T, E = Error> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: E };

/**
 * Create a successful result
 */
export function ok<T>(value: T): Result<T, never> {
	return { ok: true, value };
}

/**
 * Create a failed result
 */
export function err<E>(error: E): Result<never, E> {
	return { ok: false, error };
}

/**
 * Check if a result is Ok
 */
export function isOk<T, E>(
	result: Result<T, E>,
): result is { ok: true; value: T } {
	return result.ok;
}

/**
 * Check if a result is Err
 */
export function isErr<T, E>(
	result: Result<T, E>,
): result is { ok: false; error: E } {
	return !result.ok;
}

/**
 * Unwrap a result, throwing if it's an error
 */
export function unwrap<T, E>(result: Result<T, E>): T {
	if (result.ok) {
		return result.value;
	}
	throw result.error instanceof Error
		? result.error
		: new Error(String(result.error));
}

/**
 * Unwrap a result with a default value
 */
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
	return result.ok ? result.value : defaultValue;
}

/**
 * Map the success value of a result
 */
export function map<T, U, E>(
	result: Result<T, E>,
	fn: (value: T) => U,
): Result<U, E> {
	if (result.ok) {
		return ok(fn(result.value));
	}
	return result;
}

/**
 * Map the error value of a result
 */
export function mapErr<T, E, F>(
	result: Result<T, E>,
	fn: (error: E) => F,
): Result<T, F> {
	if (!result.ok) {
		return err(fn(result.error));
	}
	return result;
}

/**
 * Chain results together (flatMap)
 */
export function andThen<T, U, E>(
	result: Result<T, E>,
	fn: (value: T) => Result<U, E>,
): Result<U, E> {
	if (result.ok) {
		return fn(result.value);
	}
	return result;
}

/**
 * Wrap a function that might throw into one that returns a Result
 */
export function tryCatch<T>(fn: () => T): Result<T, Error> {
	try {
		return ok(fn());
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
}

/**
 * Wrap an async function that might throw into one that returns a Result
 */
export async function tryCatchAsync<T>(
	fn: () => Promise<T>,
): Promise<Result<T, Error>> {
	try {
		return ok(await fn());
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
}

/**
 * Combine multiple results into a single result with an array of values.
 * Returns the first error encountered, or Ok with all values.
 */
export function all<T, E>(results: Result<T, E>[]): Result<T[], E> {
	const values: T[] = [];
	for (const result of results) {
		if (!result.ok) {
			return result;
		}
		values.push(result.value);
	}
	return ok(values);
}

/**
 * Execute a function for its side effects on success
 */
export function tap<T, E>(
	result: Result<T, E>,
	fn: (value: T) => void,
): Result<T, E> {
	if (result.ok) {
		fn(result.value);
	}
	return result;
}

/**
 * Execute a function for its side effects on error
 */
export function tapErr<T, E>(
	result: Result<T, E>,
	fn: (error: E) => void,
): Result<T, E> {
	if (!result.ok) {
		fn(result.error);
	}
	return result;
}

/**
 * Convert a Result to a Promise (rejects on Err)
 */
export function toPromise<T, E>(result: Result<T, E>): Promise<T> {
	if (result.ok) {
		return Promise.resolve(result.value);
	}
	return Promise.reject(result.error);
}

/**
 * Convert a Promise to a Result (catches rejections)
 */
export async function fromPromise<T>(
	promise: Promise<T>,
): Promise<Result<T, Error>> {
	return tryCatchAsync(() => promise);
}
