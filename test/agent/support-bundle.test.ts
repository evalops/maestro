import { describe, expect, it } from "vitest";
import {
	SUPPORT_BUNDLE_VERSION,
	type SupportBundleBinaryInfo,
	type SupportBundleSourceFile,
	buildSupportBundle,
	bundleId,
	computeSha256,
	parseBundle,
	serializeBundle,
	verifyBundleIntegrity,
} from "../../src/agent/support-bundle.js";

function makeBinary(): SupportBundleBinaryInfo {
	return {
		version: "0.42.0",
		commitSha: "abc12345def67890abc12345def67890abc12345",
		bunVersion: "1.2.0",
		builtAt: "2026-06-15T18:00:00.000Z",
	};
}

function makeSourceFile(
	path: string,
	content: string,
): SupportBundleSourceFile {
	return {
		path,
		content,
		// UTF-8 byte length, not string length, to match what the embed
		// pipeline records.
		bytes: new TextEncoder().encode(content).byteLength,
		sha256: computeSha256(content),
	};
}

describe("agent/support-bundle", () => {
	describe("computeSha256", () => {
		it("matches the standard FIPS 180-4 test vectors", () => {
			expect(computeSha256("")).toBe(
				"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			);
			expect(computeSha256("abc")).toBe(
				"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
			);
			expect(computeSha256("The quick brown fox jumps over the lazy dog")).toBe(
				"d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
			);
		});

		it("handles longer strings spanning multiple SHA-256 blocks", () => {
			// 200-character input forces multiple 64-byte block iterations.
			const long = "x".repeat(200);
			expect(computeSha256(long)).toHaveLength(64);
			expect(computeSha256(long)).toBe(computeSha256(long));
		});
	});

	describe("buildSupportBundle", () => {
		it("returns a versioned bundle with the configured id format", () => {
			const bundle = buildSupportBundle({
				binary: makeBinary(),
				sourceFiles: [makeSourceFile("src/foo.ts", "export const x = 1;\n")],
				settings: { values: { theme: "dark" }, redactedKeys: ["api_key"] },
				logs: [
					{
						timestamp: "2026-06-15T18:00:00.000Z",
						level: "info",
						module: "boot",
						message: "started",
					},
				],
				generatedAt: "2026-06-15T18:00:00.000Z",
			});
			expect(bundle.version).toBe(SUPPORT_BUNDLE_VERSION);
			expect(bundle.id).toMatch(
				/^support-0\.42\.0-abc1234-2026-06-15T18-00-00-000Z$/,
			);
		});

		it("throws when a source file's recorded sha256 doesn't match content", () => {
			expect(() =>
				buildSupportBundle({
					binary: makeBinary(),
					sourceFiles: [
						{
							path: "src/foo.ts",
							content: "hello",
							bytes: 5,
							sha256: "0".repeat(64),
						},
					],
					settings: { values: {}, redactedKeys: [] },
					logs: [],
				}),
			).toThrow(/sha256 mismatch/);
		});

		it("throws when a source file's recorded bytes don't match the UTF-8 byte length", () => {
			expect(() =>
				buildSupportBundle({
					binary: makeBinary(),
					sourceFiles: [
						{
							path: "src/foo.ts",
							content: "hello",
							bytes: 99,
							sha256: computeSha256("hello"),
						},
					],
					settings: { values: {}, redactedKeys: [] },
					logs: [],
				}),
			).toThrow(/bytes 99 != UTF-8 byte length/);
		});

		it("accepts non-ASCII content whose UTF-8 byte length differs from string length", () => {
			// "héllo 世界 🚀" — UTF-8 is 17 bytes, UTF-16 length is 11 code units.
			const content = "héllo 世界 🚀";
			const bundle = buildSupportBundle({
				binary: makeBinary(),
				sourceFiles: [
					{
						path: "src/i18n.ts",
						content,
						bytes: new TextEncoder().encode(content).byteLength,
						sha256: computeSha256(content),
					},
				],
				settings: { values: {}, redactedKeys: [] },
				logs: [],
			});
			expect(bundle.sourceFiles[0]?.bytes).toBeGreaterThan(content.length);
		});

		it("throws when binary metadata is missing required fields", () => {
			expect(() =>
				buildSupportBundle({
					binary: { ...makeBinary(), commitSha: "" },
					sourceFiles: [],
					settings: { values: {}, redactedKeys: [] },
					logs: [],
				}),
			).toThrow(/binary.commitSha is required/);
		});

		it("throws when a log line carries an unknown level", () => {
			expect(() =>
				buildSupportBundle({
					binary: makeBinary(),
					sourceFiles: [],
					settings: { values: {}, redactedKeys: [] },
					logs: [
						{
							timestamp: "2026-06-15T18:00:00.000Z",
							level: "panic" as never,
							module: "boot",
							message: "x",
						},
					],
				}),
			).toThrow(/log.level "panic" is not a known level/);
		});
	});

	describe("verifyBundleIntegrity", () => {
		it("returns an empty list when every source file hash checks out", () => {
			const bundle = buildSupportBundle({
				binary: makeBinary(),
				sourceFiles: [
					makeSourceFile("src/a.ts", "a"),
					makeSourceFile("src/b.ts", "b"),
				],
				settings: { values: {}, redactedKeys: [] },
				logs: [],
			});
			expect(verifyBundleIntegrity(bundle)).toEqual([]);
		});

		it("flags every source file whose content was tampered with after build", () => {
			const bundle = buildSupportBundle({
				binary: makeBinary(),
				sourceFiles: [
					makeSourceFile("src/a.ts", "a"),
					makeSourceFile("src/b.ts", "b"),
				],
				settings: { values: {}, redactedKeys: [] },
				logs: [],
			});
			const tampered = {
				...bundle,
				sourceFiles: [
					{ ...bundle.sourceFiles[0]!, content: "tampered" },
					bundle.sourceFiles[1]!,
				],
			};
			expect(verifyBundleIntegrity(tampered)).toEqual(["src/a.ts"]);
		});

		it("flags a source file whose bytes metadata is wrong even when the sha256 is still valid", () => {
			const bundle = buildSupportBundle({
				binary: makeBinary(),
				sourceFiles: [makeSourceFile("src/a.ts", "abc")],
				settings: { values: {}, redactedKeys: [] },
				logs: [],
			});
			const tampered = {
				...bundle,
				sourceFiles: [{ ...bundle.sourceFiles[0]!, bytes: 999 }],
			};
			// Hash still matches; bytes is wrong. Before the fix the
			// verifier reported no mismatches and downstream consumers
			// would silently trust the wrong byte count.
			expect(verifyBundleIntegrity(tampered)).toEqual(["src/a.ts"]);
		});
	});

	describe("serializeBundle / parseBundle", () => {
		it("round-trips a bundle byte-for-byte", () => {
			const bundle = buildSupportBundle({
				binary: makeBinary(),
				sourceFiles: [
					makeSourceFile("src/b.ts", "b"),
					makeSourceFile("src/a.ts", "a"),
				],
				settings: {
					values: { theme: "dark", model: "claude-opus-4-7" },
					redactedKeys: ["api_key"],
				},
				logs: [
					{
						timestamp: "2026-06-15T18:00:00.000Z",
						level: "info",
						module: "boot",
						message: "started",
					},
				],
				generatedAt: "2026-06-15T18:00:00.000Z",
			});
			const text = serializeBundle(bundle);
			const parsed = parseBundle(text);
			expect(parsed.id).toBe(bundle.id);
			expect(parsed.sourceFiles.map((f) => f.path)).toEqual([
				"src/a.ts",
				"src/b.ts",
			]);
		});

		it("produces byte-identical output for the same input", () => {
			const bundle = buildSupportBundle({
				binary: makeBinary(),
				sourceFiles: [makeSourceFile("src/foo.ts", "x")],
				settings: { values: { a: "1", b: "2" }, redactedKeys: [] },
				logs: [],
				generatedAt: "2026-06-15T18:00:00.000Z",
			});
			expect(serializeBundle(bundle)).toBe(serializeBundle(bundle));
		});

		it("rejects parses with an unsupported version", () => {
			const bundle = buildSupportBundle({
				binary: makeBinary(),
				sourceFiles: [],
				settings: { values: {}, redactedKeys: [] },
				logs: [],
				generatedAt: "2026-06-15T18:00:00.000Z",
			});
			const text = serializeBundle({ ...bundle, version: 99 });
			expect(() => parseBundle(text)).toThrow(/unsupported version 99/);
		});

		it("rejects malformed JSON", () => {
			expect(() => parseBundle("not json {")).toThrow(/JSON parse failed/);
		});

		it("surfaces a null entry in sourceFiles as a validation error, not an uncaught TypeError", () => {
			const malformed = JSON.stringify({
				version: SUPPORT_BUNDLE_VERSION,
				id: "x",
				generatedAt: "2026-06-15T18:00:00.000Z",
				binary: makeBinary(),
				sourceFiles: [null],
				settings: { values: {}, redactedKeys: [] },
				logs: [],
			});
			expect(() => parseBundle(malformed)).toThrow(
				/sourceFile must be an object/,
			);
		});

		it("surfaces a null entry in logs as a validation error, not an uncaught TypeError", () => {
			const malformed = JSON.stringify({
				version: SUPPORT_BUNDLE_VERSION,
				id: "x",
				generatedAt: "2026-06-15T18:00:00.000Z",
				binary: makeBinary(),
				sourceFiles: [],
				settings: { values: {}, redactedKeys: [] },
				logs: [null],
			});
			expect(() => parseBundle(malformed)).toThrow(
				/log line must be an object/,
			);
		});

		it("rejects array-shaped binary / settings blocks even when string properties are attached", () => {
			// `binary: []` with attached string properties survives
			// per-field type-checks, but JSON.stringify drops non-index
			// properties on arrays — so the bundle would round-trip as an
			// empty `[]`. Validation must reject the shape up front.
			const arrayBinary = Object.assign([] as unknown[], {
				version: "1.0.0",
				commitSha: "abc12345def67890abc12345def67890abc12345",
				bunVersion: "1.2.0",
				builtAt: "2026-06-15T18:00:00.000Z",
			});
			const malformedBinary = JSON.stringify({
				version: SUPPORT_BUNDLE_VERSION,
				id: "x",
				generatedAt: "2026-06-15T18:00:00.000Z",
				binary: arrayBinary,
				sourceFiles: [],
				settings: { values: {}, redactedKeys: [] },
				logs: [],
			});
			expect(() => parseBundle(malformedBinary)).toThrow(
				/binary must be an object/,
			);

			const arraySettings = Object.assign([] as unknown[], {
				values: {},
				redactedKeys: [],
			});
			const malformedSettings = JSON.stringify({
				version: SUPPORT_BUNDLE_VERSION,
				id: "x",
				generatedAt: "2026-06-15T18:00:00.000Z",
				binary: {
					version: "1.0.0",
					commitSha: "abc12345def67890abc12345def67890abc12345",
					bunVersion: "1.2.0",
					builtAt: "2026-06-15T18:00:00.000Z",
				},
				sourceFiles: [],
				settings: arraySettings,
				logs: [],
			});
			expect(() => parseBundle(malformedSettings)).toThrow(
				/settings must be an object/,
			);
		});

		it("surfaces non-string binary fields as a validation error, not an uncaught TypeError", () => {
			// Pre-fix `assertBinaryValid` called `.trim()` on whatever
			// landed in each field, so a number / array / null produced an
			// uncaught TypeError instead of the expected
			// `support bundle: ...` message.
			const malformed = JSON.stringify({
				version: SUPPORT_BUNDLE_VERSION,
				id: "x",
				generatedAt: "2026-06-15T18:00:00.000Z",
				binary: {
					version: 42, // not a string
					commitSha: "abc12345def67890abc12345def67890abc12345",
					bunVersion: "1.2.0",
					builtAt: "2026-06-15T18:00:00.000Z",
				},
				sourceFiles: [],
				settings: { values: {}, redactedKeys: [] },
				logs: [],
			});
			expect(() => parseBundle(malformed)).toThrow(
				/binary\.version is required/,
			);
		});

		it("rejects sha256 values that aren't 64-char hex", () => {
			const bundle = buildSupportBundle({
				binary: makeBinary(),
				sourceFiles: [makeSourceFile("src/foo.ts", "x")],
				settings: { values: {}, redactedKeys: [] },
				logs: [],
				generatedAt: "2026-06-15T18:00:00.000Z",
			});
			const bad = {
				...bundle,
				sourceFiles: [{ ...bundle.sourceFiles[0]!, sha256: "not-hex" }],
			};
			const text = JSON.stringify(bad);
			expect(() => parseBundle(text)).toThrow(/sha256 must be a 64-char hex/);
		});

		it("rejects source files whose recorded sha256 does not match content", () => {
			const bundle = buildSupportBundle({
				binary: makeBinary(),
				sourceFiles: [makeSourceFile("src/foo.ts", "hello")],
				settings: { values: {}, redactedKeys: [] },
				logs: [],
				generatedAt: "2026-06-15T18:00:00.000Z",
			});
			const bad = {
				...bundle,
				sourceFiles: [{ ...bundle.sourceFiles[0]!, sha256: "0".repeat(64) }],
			};
			expect(() => parseBundle(JSON.stringify(bad))).toThrow(/sha256 mismatch/);
		});

		it("rejects source files whose recorded bytes do not match content", () => {
			const bundle = buildSupportBundle({
				binary: makeBinary(),
				sourceFiles: [makeSourceFile("src/foo.ts", "hello")],
				settings: { values: {}, redactedKeys: [] },
				logs: [],
				generatedAt: "2026-06-15T18:00:00.000Z",
			});
			const bad = {
				...bundle,
				sourceFiles: [{ ...bundle.sourceFiles[0]!, bytes: 999 }],
			};
			expect(() => parseBundle(JSON.stringify(bad))).toThrow(
				/bytes 999 != UTF-8 byte length 5/,
			);
		});

		it("rejects bundles whose id does not match bundleId(binary, generatedAt)", () => {
			// Tampered or copy-pasted id must not survive parse: it
			// would silently misrepresent which binary + generation
			// time the manifest belongs to.
			const bundle = buildSupportBundle({
				binary: makeBinary(),
				sourceFiles: [],
				settings: { values: {}, redactedKeys: [] },
				logs: [],
				generatedAt: "2026-06-15T18:00:00.000Z",
			});
			const tampered = { ...bundle, id: "support-tampered-id" };
			expect(() => parseBundle(JSON.stringify(tampered))).toThrow(
				/id "support-tampered-id" does not match expected/,
			);
		});
	});

	describe("bundleId", () => {
		it("is stable for the same binary + timestamp", () => {
			const t = "2026-06-15T18:00:00.000Z";
			const a = bundleId(makeBinary(), t);
			const b = bundleId(makeBinary(), t);
			expect(a).toBe(b);
		});

		it("differs across commits", () => {
			const t = "2026-06-15T18:00:00.000Z";
			const a = bundleId(makeBinary(), t);
			const b = bundleId(
				{
					...makeBinary(),
					commitSha: "0123456789abcdef0123456789abcdef01234567",
				},
				t,
			);
			expect(a).not.toBe(b);
		});

		it("strips colons + dots from the timestamp portion for filename safety", () => {
			const id = bundleId(makeBinary(), "2026-06-15T18:00:00.000Z");
			// The version itself may legitimately contain dots
			// ("0.42.0"); we only sanitize the timestamp portion.
			const timestampPart = id.slice(id.indexOf("2026"));
			expect(timestampPart).not.toContain(":");
			expect(timestampPart).not.toContain(".");
		});
	});
});
