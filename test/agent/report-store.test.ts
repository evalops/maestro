import { describe, expect, it } from "vitest";
import {
	REPORT_RECORD_VERSION,
	createInMemoryReportStore,
	makeReportRecord,
} from "../../src/agent/report-store.js";

describe("agent/report-store", () => {
	describe("makeReportRecord", () => {
		it("stamps the envelope version, defaults tags to [], generatedAt to now", () => {
			const record = makeReportRecord({
				id: "r-1",
				kind: "readiness",
				payload: { score: 0.8 },
			});
			expect(record.version).toBe(REPORT_RECORD_VERSION);
			expect(record.tags).toEqual([]);
			expect(() => new Date(record.generatedAt).toISOString()).not.toThrow();
		});

		it("accepts an explicit generatedAt, window, and tags", () => {
			const record = makeReportRecord({
				id: "r-2",
				kind: "effectiveness",
				payload: 1,
				generatedAt: "2026-06-15T18:00:00.000Z",
				window: {
					start: "2026-06-01T00:00:00.000Z",
					end: "2026-06-15T00:00:00.000Z",
				},
				tags: ["acme/web", "monthly"],
			});
			expect(record.generatedAt).toBe("2026-06-15T18:00:00.000Z");
			expect(record.tags).toEqual(["acme/web", "monthly"]);
			expect(record.window?.start).toBe("2026-06-01T00:00:00.000Z");
		});

		it("dedupes + trims + rejects blank tags", () => {
			const record = makeReportRecord({
				id: "r-3",
				kind: "x",
				payload: null,
				tags: ["a", "  a  ", "b"],
			});
			expect(record.tags).toEqual(["a", "b"]);
			expect(() =>
				makeReportRecord({ id: "r-4", kind: "x", payload: null, tags: [""] }),
			).toThrow(/empty tag is not allowed/);
		});

		it("throws on blank id / kind and invalid window", () => {
			expect(() =>
				makeReportRecord({ id: "  ", kind: "x", payload: 1 }),
			).toThrow(/id is required/);
			expect(() =>
				makeReportRecord({ id: "r", kind: " ", payload: 1 }),
			).toThrow(/kind is required/);
			expect(() =>
				makeReportRecord({
					id: "r",
					kind: "x",
					payload: 1,
					window: { start: "2026-06-15", end: "2026-06-01" },
				}),
			).toThrow(/start "2026-06-15" must be <= end/);
		});
	});

	describe("createInMemoryReportStore", () => {
		it("writes + reads back records by id", () => {
			const store = createInMemoryReportStore<{ score: number }>();
			const record = makeReportRecord({
				id: "r-1",
				kind: "readiness",
				payload: { score: 0.7 },
			});
			store.write(record);
			expect(store.has("r-1")).toBe(true);
			expect(store.get("r-1")?.payload.score).toBe(0.7);
			expect(store.get("nope")).toBeUndefined();
			expect(store.size()).toBe(1);
		});

		it("rejects writing the same id twice (append-only)", () => {
			const store = createInMemoryReportStore();
			const r = makeReportRecord({ id: "r-1", kind: "x", payload: 1 });
			store.write(r);
			expect(() => store.write(r)).toThrow(/record id "r-1" already exists/);
		});

		it("hands records out by value so the caller can't mutate the store", () => {
			const store = createInMemoryReportStore<{ tag: string }>();
			store.write(
				makeReportRecord({ id: "r-1", kind: "x", payload: { tag: "orig" } }),
			);
			const got = store.get("r-1");
			if (got) got.payload.tag = "tampered";
			expect(store.get("r-1")?.payload.tag).toBe("orig");
		});

		it("lists records sorted by generatedAt descending", () => {
			const store = createInMemoryReportStore();
			store.write(
				makeReportRecord({
					id: "older",
					kind: "x",
					payload: 1,
					generatedAt: "2026-06-01T00:00:00.000Z",
				}),
			);
			store.write(
				makeReportRecord({
					id: "newer",
					kind: "x",
					payload: 2,
					generatedAt: "2026-06-10T00:00:00.000Z",
				}),
			);
			store.write(
				makeReportRecord({
					id: "newest",
					kind: "x",
					payload: 3,
					generatedAt: "2026-06-15T00:00:00.000Z",
				}),
			);
			expect(store.list().map((r) => r.id)).toEqual([
				"newest",
				"newer",
				"older",
			]);
		});

		it("preserves insertion order when generatedAt timestamps are equal", () => {
			const store = createInMemoryReportStore();
			store.write(
				makeReportRecord({
					id: "first",
					kind: "x",
					payload: 1,
					generatedAt: "2026-06-15T00:00:00.000Z",
				}),
			);
			store.write(
				makeReportRecord({
					id: "second",
					kind: "x",
					payload: 2,
					generatedAt: "2026-06-15T00:00:00.000Z",
				}),
			);
			expect(store.list().map((r) => r.id)).toEqual(["first", "second"]);
		});

		it("filters by kind", () => {
			const store = createInMemoryReportStore();
			store.write(
				makeReportRecord({ id: "r-1", kind: "readiness", payload: 1 }),
			);
			store.write(
				makeReportRecord({ id: "r-2", kind: "effectiveness", payload: 2 }),
			);
			expect(store.list({ kind: "readiness" }).map((r) => r.id)).toEqual([
				"r-1",
			]);
		});

		it("filters by tags (must match every requested tag)", () => {
			const store = createInMemoryReportStore();
			store.write(
				makeReportRecord({
					id: "r-1",
					kind: "x",
					payload: 1,
					tags: ["a", "b"],
				}),
			);
			store.write(
				makeReportRecord({
					id: "r-2",
					kind: "x",
					payload: 2,
					tags: ["a"],
				}),
			);
			expect(store.list({ tags: ["a", "b"] }).map((r) => r.id)).toEqual([
				"r-1",
			]);
			expect(
				store
					.list({ tags: ["a"] })
					.map((r) => r.id)
					.sort(),
			).toEqual(["r-1", "r-2"]);
		});

		it("normalizes query tags before filtering", () => {
			const store = createInMemoryReportStore();
			const tags = ["  acme  ", " monthly "];
			store.write(
				makeReportRecord({
					id: "r-1",
					kind: "x",
					payload: 1,
					tags,
				}),
			);
			expect(store.list({ tags }).map((r) => r.id)).toEqual(["r-1"]);
		});

		it("filters by generatedWithin (half-open interval)", () => {
			const store = createInMemoryReportStore();
			store.write(
				makeReportRecord({
					id: "before",
					kind: "x",
					payload: 1,
					generatedAt: "2026-05-30T00:00:00.000Z",
				}),
			);
			store.write(
				makeReportRecord({
					id: "in-window",
					kind: "x",
					payload: 2,
					generatedAt: "2026-06-05T00:00:00.000Z",
				}),
			);
			store.write(
				makeReportRecord({
					id: "boundary",
					kind: "x",
					payload: 3,
					generatedAt: "2026-06-15T00:00:00.000Z",
				}),
			);
			const window = {
				start: "2026-06-01T00:00:00.000Z",
				end: "2026-06-15T00:00:00.000Z",
			};
			// `boundary` falls on the exclusive end and is excluded.
			expect(store.list({ generatedWithin: window }).map((r) => r.id)).toEqual([
				"in-window",
			]);
		});

		it("combines kind + tags + generatedWithin filters", () => {
			const store = createInMemoryReportStore();
			store.write(
				makeReportRecord({
					id: "match",
					kind: "readiness",
					payload: 1,
					tags: ["acme"],
					generatedAt: "2026-06-05T00:00:00.000Z",
				}),
			);
			store.write(
				makeReportRecord({
					id: "wrong-kind",
					kind: "effectiveness",
					payload: 2,
					tags: ["acme"],
					generatedAt: "2026-06-05T00:00:00.000Z",
				}),
			);
			store.write(
				makeReportRecord({
					id: "missing-tag",
					kind: "readiness",
					payload: 3,
					tags: ["other"],
					generatedAt: "2026-06-05T00:00:00.000Z",
				}),
			);
			store.write(
				makeReportRecord({
					id: "wrong-window",
					kind: "readiness",
					payload: 4,
					tags: ["acme"],
					generatedAt: "2026-05-01T00:00:00.000Z",
				}),
			);
			const found = store.list({
				kind: "readiness",
				tags: ["acme"],
				generatedWithin: {
					start: "2026-06-01T00:00:00.000Z",
					end: "2026-07-01T00:00:00.000Z",
				},
			});
			expect(found.map((r) => r.id)).toEqual(["match"]);
		});

		it("trims padded `kind` so list({ kind: 'x' }) still matches", () => {
			const store = createInMemoryReportStore();
			store.write(
				makeReportRecord({ id: "r-1", kind: "  readiness  ", payload: 1 }),
			);
			expect(store.list({ kind: "readiness" }).map((r) => r.id)).toEqual([
				"r-1",
			]);
		});

		it("excludes records with missing generatedAt from window-filtered results", () => {
			const store = createInMemoryReportStore();
			const record = makeReportRecord({
				id: "r-1",
				kind: "x",
				payload: 1,
				generatedAt: "2026-06-10T00:00:00.000Z",
			});
			// Synthesize a malformed record by bypassing the
			// constructor so the window guard has something to reject.
			// Real callers shouldn't hit this — the test exists so the
			// documented behavior is upheld for code that builds
			// records from raw JSON / disk replay.
			store.write({
				...record,
				generatedAt: undefined as unknown as string,
			});
			const found = store.list({
				generatedWithin: {
					start: "2026-06-01T00:00:00.000Z",
					end: "2026-06-15T00:00:00.000Z",
				},
			});
			expect(found).toEqual([]);
		});

		it("size() reflects the number of stored records", () => {
			const store = createInMemoryReportStore();
			expect(store.size()).toBe(0);
			store.write(makeReportRecord({ id: "a", kind: "x", payload: 1 }));
			store.write(makeReportRecord({ id: "b", kind: "x", payload: 2 }));
			expect(store.size()).toBe(2);
		});
	});
});
