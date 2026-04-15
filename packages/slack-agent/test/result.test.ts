import { describe, expect, it } from "vitest";
import {
	all,
	andThen,
	err,
	fromPromise,
	isErr,
	isOk,
	map,
	mapErr,
	ok,
	tap,
	tapErr,
	toPromise,
	tryCatch,
	tryCatchAsync,
	unwrap,
	unwrapOr,
} from "../src/utils/result.js";

describe("ok and err constructors", () => {
	it("creates successful result with ok()", () => {
		const result = ok(42);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(42);
		}
	});

	it("creates failed result with err()", () => {
		const result = err("something went wrong");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("something went wrong");
		}
	});

	it("works with complex types", () => {
		const success = ok({ name: "test", count: 5 });
		const failure = err(new Error("failed"));

		expect(success.ok).toBe(true);
		expect(failure.ok).toBe(false);
	});
});

describe("isOk and isErr type guards", () => {
	it("isOk returns true for successful results", () => {
		const result = ok(42);
		expect(isOk(result)).toBe(true);
		expect(isErr(result)).toBe(false);
	});

	it("isErr returns true for failed results", () => {
		const result = err("error");
		expect(isErr(result)).toBe(true);
		expect(isOk(result)).toBe(false);
	});
});

describe("unwrap", () => {
	it("returns value for successful result", () => {
		const result = ok(42);
		expect(unwrap(result)).toBe(42);
	});

	it("throws for failed result with Error", () => {
		const error = new Error("test error");
		const result = err(error);
		expect(() => unwrap(result)).toThrow(error);
	});

	it("throws wrapped error for non-Error", () => {
		const result = err("string error");
		expect(() => unwrap(result)).toThrow("string error");
	});
});

describe("unwrapOr", () => {
	it("returns value for successful result", () => {
		const result = ok(42);
		expect(unwrapOr(result, 0)).toBe(42);
	});

	it("returns default for failed result", () => {
		const result = err("error");
		expect(unwrapOr(result, 0)).toBe(0);
	});
});

describe("map", () => {
	it("transforms successful result", () => {
		const result = ok(5);
		const mapped = map(result, (x) => x * 2);

		expect(mapped.ok).toBe(true);
		if (mapped.ok) {
			expect(mapped.value).toBe(10);
		}
	});

	it("passes through failed result", () => {
		const result = err("error");
		const mapped = map(result, (x: number) => x * 2);

		expect(mapped.ok).toBe(false);
		if (!mapped.ok) {
			expect(mapped.error).toBe("error");
		}
	});
});

describe("mapErr", () => {
	it("transforms failed result error", () => {
		const result = err("error");
		const mapped = mapErr(result, (e) => `wrapped: ${e}`);

		expect(mapped.ok).toBe(false);
		if (!mapped.ok) {
			expect(mapped.error).toBe("wrapped: error");
		}
	});

	it("passes through successful result", () => {
		const result = ok(42);
		const mapped = mapErr(result, (e: string) => `wrapped: ${e}`);

		expect(mapped.ok).toBe(true);
		if (mapped.ok) {
			expect(mapped.value).toBe(42);
		}
	});
});

describe("andThen (flatMap)", () => {
	it("chains successful results", () => {
		const result = ok(5);
		const chained = andThen(result, (x) => ok(x * 2));

		expect(chained.ok).toBe(true);
		if (chained.ok) {
			expect(chained.value).toBe(10);
		}
	});

	it("short-circuits on first error", () => {
		const result = ok(5);
		const chained = andThen(result, () => err("failed"));

		expect(chained.ok).toBe(false);
		if (!chained.ok) {
			expect(chained.error).toBe("failed");
		}
	});

	it("passes through initial error", () => {
		const result = err("initial error");
		const chained = andThen(result, (x: number) => ok(x * 2));

		expect(chained.ok).toBe(false);
		if (!chained.ok) {
			expect(chained.error).toBe("initial error");
		}
	});
});

describe("tryCatch", () => {
	it("returns Ok for successful function", () => {
		const result = tryCatch(() => JSON.parse('{"key": "value"}'));

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({ key: "value" });
		}
	});

	it("returns Err for throwing function", () => {
		const result = tryCatch(() => JSON.parse("invalid json"));

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBeInstanceOf(Error);
		}
	});

	it("wraps non-Error throws", () => {
		const result = tryCatch(() => {
			throw "string error";
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBeInstanceOf(Error);
			expect(result.error.message).toBe("string error");
		}
	});
});

describe("tryCatchAsync", () => {
	it("returns Ok for successful async function", async () => {
		const result = await tryCatchAsync(async () => "success");

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe("success");
		}
	});

	it("returns Err for rejecting async function", async () => {
		const result = await tryCatchAsync(async () => {
			throw new Error("async error");
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toBe("async error");
		}
	});
});

describe("all", () => {
	it("combines successful results into array", () => {
		const results = [ok(1), ok(2), ok(3)];
		const combined = all(results);

		expect(combined.ok).toBe(true);
		if (combined.ok) {
			expect(combined.value).toEqual([1, 2, 3]);
		}
	});

	it("returns first error encountered", () => {
		const results = [ok(1), err("first error"), ok(3), err("second error")];
		const combined = all(results);

		expect(combined.ok).toBe(false);
		if (!combined.ok) {
			expect(combined.error).toBe("first error");
		}
	});

	it("returns Ok with empty array for empty input", () => {
		const combined = all([]);

		expect(combined.ok).toBe(true);
		if (combined.ok) {
			expect(combined.value).toEqual([]);
		}
	});
});

describe("tap and tapErr", () => {
	it("tap executes side effect on success", () => {
		let called = false;
		const result = ok(42);
		const tapped = tap(result, () => {
			called = true;
		});

		expect(called).toBe(true);
		expect(tapped).toBe(result);
	});

	it("tap does not execute on error", () => {
		let called = false;
		const result = err("error");
		tap(result, () => {
			called = true;
		});

		expect(called).toBe(false);
	});

	it("tapErr executes side effect on error", () => {
		let errorMsg = "";
		const result = err("test error");
		tapErr(result, (e) => {
			errorMsg = e;
		});

		expect(errorMsg).toBe("test error");
	});

	it("tapErr does not execute on success", () => {
		let called = false;
		const result = ok(42);
		tapErr(result, () => {
			called = true;
		});

		expect(called).toBe(false);
	});
});

describe("toPromise and fromPromise", () => {
	it("toPromise resolves for Ok", async () => {
		const result = ok(42);
		await expect(toPromise(result)).resolves.toBe(42);
	});

	it("toPromise rejects for Err", async () => {
		const error = new Error("test");
		const result = err(error);
		await expect(toPromise(result)).rejects.toBe(error);
	});

	it("fromPromise returns Ok for resolved promise", async () => {
		const result = await fromPromise(Promise.resolve(42));

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(42);
		}
	});

	it("fromPromise returns Err for rejected promise", async () => {
		const result = await fromPromise(Promise.reject(new Error("rejected")));

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toBe("rejected");
		}
	});
});
