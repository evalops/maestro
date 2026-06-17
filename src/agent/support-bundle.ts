/**
 * Support bundle manifest
 *
 * In-the-field debugging is hard when a customer runs a pinned binary
 * the support engineer can't reproduce locally. The plan is to ship
 * release binaries with the original (Zstd-compressed) source embedded
 * — addressable by index — plus a `maestro support bundle` command
 * that emits a tarball of (a) the source the running binary actually
 * loaded, (b) the resolved settings, (c) recent log lines.
 *
 * This module owns the data shape only: what a support bundle
 * contains, how to validate one round-tripped through JSON, how to
 * verify the embedded source integrity. The Bun build configuration,
 * the binary-segment extractor, and the `support bundle` slash
 * command live in follow-up PRs.
 *
 * Why a typed manifest matters: support engineers paste these into
 * issues, customers email them around, and they get diffed across
 * deployments. The shape needs to be stable enough that tooling
 * (extractors, comparison scripts, the issue parser) can rely on it.
 */

/** Schema version (bumped on breaking layout changes). */
export const SUPPORT_BUNDLE_VERSION = 1;

/** Identity of the binary the bundle was emitted from. */
export interface SupportBundleBinaryInfo {
	/** Semver string from the release manifest. */
	version: string;
	/** Commit sha the release was cut from. */
	commitSha: string;
	/** Bun version the binary was compiled against. */
	bunVersion: string;
	/** ISO 8601 timestamp the binary was built. */
	builtAt: string;
}

/** One embedded source file inside the binary's source segment. */
export interface SupportBundleSourceFile {
	/** Repo-relative path. */
	path: string;
	/** Decompressed file content. */
	content: string;
	/** Length in bytes of the decompressed content. */
	bytes: number;
	/** Hex-encoded SHA-256 hash of the decompressed content. */
	sha256: string;
}

/**
 * Resolved-settings snapshot the bundle carries. Values that look like
 * secrets (api keys, oauth tokens) are redacted before the bundle is
 * written so customers can paste it into a public issue.
 */
export interface SupportBundleSettings {
	/** Map of setting key → resolved value (or `"<redacted>"`). */
	values: Record<string, string>;
	/** Setting keys whose values were redacted. */
	redactedKeys: string[];
}

/** One captured log line. */
export interface SupportBundleLogLine {
	/** ISO 8601 timestamp the line was emitted. */
	timestamp: string;
	/** Log level. */
	level: "debug" | "info" | "warn" | "error";
	/** Module / source the line came from. */
	module: string;
	/** Human-readable message. */
	message: string;
	/** Optional structured fields. */
	fields?: Record<string, unknown>;
}

/** Top-level bundle the support CLI emits. */
export interface SupportBundle {
	/** Schema version. */
	version: number;
	/** Content-addressed bundle id (see `bundleId`). */
	id: string;
	/** ISO 8601 timestamp the bundle was generated. */
	generatedAt: string;
	/** What binary the bundle came from. */
	binary: SupportBundleBinaryInfo;
	/** Source files extracted from the binary's __BUN segment. */
	sourceFiles: SupportBundleSourceFile[];
	/** Resolved settings (secrets redacted). */
	settings: SupportBundleSettings;
	/** Recent log lines the binary emitted before the bundle was triggered. */
	logs: SupportBundleLogLine[];
}

/**
 * Build a bundle from the constituent parts. Validates that each
 * source file's recorded `sha256` matches its content (the build
 * pipeline supplies pre-computed hashes; we re-check defensively so a
 * malformed input fails fast instead of producing a bundle the
 * verifier will later reject).
 */
export function buildSupportBundle(input: {
	binary: SupportBundleBinaryInfo;
	sourceFiles: SupportBundleSourceFile[];
	settings: SupportBundleSettings;
	logs: SupportBundleLogLine[];
	generatedAt?: string;
}): SupportBundle {
	assertBinaryValid(input.binary);
	assertSettingsValid(input.settings);
	for (const file of input.sourceFiles) {
		assertSourceFileValid(file);
		const expected = computeSha256(file.content);
		if (expected !== file.sha256) {
			throw new Error(
				`support bundle: source file "${file.path}" sha256 mismatch (input ${file.sha256}, computed ${expected})`,
			);
		}
	}
	for (const line of input.logs) {
		assertLogLineValid(line);
	}
	const generatedAt = input.generatedAt ?? new Date().toISOString();
	return {
		version: SUPPORT_BUNDLE_VERSION,
		id: bundleId(input.binary, generatedAt),
		generatedAt,
		binary: input.binary,
		sourceFiles: input.sourceFiles,
		settings: input.settings,
		logs: input.logs,
	};
}

/**
 * Verify every source file in `bundle` round-trips its embedded hash
 * AND that the recorded UTF-8 byte length matches the content.
 * Returns a list of mismatching paths (empty when the bundle is
 * intact). Callers use this when they unpack a bundle to confirm the
 * extracted source matches what was claimed. The byte-length check
 * matters because a serialized bundle can carry a valid sha256 for
 * the content while `bytes` is wrong; without this, downstream
 * consumers that trust `bytes` would silently disagree with the
 * actual file.
 */
export function verifyBundleIntegrity(bundle: SupportBundle): string[] {
	const mismatches: string[] = [];
	for (const file of bundle.sourceFiles) {
		const expectedSha = computeSha256(file.content);
		const expectedBytes = new TextEncoder().encode(file.content).byteLength;
		if (expectedSha !== file.sha256 || expectedBytes !== file.bytes) {
			mismatches.push(file.path);
		}
	}
	return mismatches;
}

/**
 * Bundle id: stable per binary + generation timestamp, so re-runs at
 * the same instant are detectable and bundles emitted across versions
 * never collide. Format:
 *
 *   `support-<version>-<sha7>-<timestamp>`
 */
export function bundleId(
	binary: SupportBundleBinaryInfo,
	generatedAt: string,
): string {
	const sha = binary.commitSha.slice(0, 7);
	const stamp = generatedAt.replace(/[:.]/g, "-");
	return `support-${binary.version}-${sha}-${stamp}`;
}

/**
 * Serialize a bundle to a JSON string suitable for tarball packaging
 * or pasting into an issue. Output is stable (sorted source files,
 * sorted setting keys) so two bundles built from identical inputs
 * produce byte-identical output.
 */
export function serializeBundle(bundle: SupportBundle): string {
	const sortedSources = [...bundle.sourceFiles].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
	const sortedSettingKeys = Object.keys(bundle.settings.values).sort();
	const sortedSettings: Record<string, string> = {};
	for (const key of sortedSettingKeys) {
		const v = bundle.settings.values[key];
		if (v !== undefined) sortedSettings[key] = v;
	}
	const sortedRedacted = [...bundle.settings.redactedKeys].sort();
	const canonical: SupportBundle = {
		...bundle,
		sourceFiles: sortedSources,
		settings: {
			values: sortedSettings,
			redactedKeys: sortedRedacted,
		},
	};
	return JSON.stringify(canonical, null, 2);
}

/** Parse a serialized bundle, validating the schema as it goes. */
export function parseBundle(text: string): SupportBundle {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(
			`support bundle: JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!parsed || typeof parsed !== "object") {
		throw new Error("support bundle: top-level value must be an object");
	}
	const obj = parsed as Record<string, unknown>;
	if (obj.version !== SUPPORT_BUNDLE_VERSION) {
		throw new Error(
			`support bundle: unsupported version ${String(obj.version)} (expected ${SUPPORT_BUNDLE_VERSION})`,
		);
	}
	if (typeof obj.id !== "string" || typeof obj.generatedAt !== "string") {
		throw new Error("support bundle: id and generatedAt must be strings");
	}
	if (!obj.binary || typeof obj.binary !== "object") {
		throw new Error("support bundle: binary block is required");
	}
	assertBinaryValid(obj.binary as SupportBundleBinaryInfo);
	if (!Array.isArray(obj.sourceFiles)) {
		throw new Error("support bundle: sourceFiles must be an array");
	}
	for (const file of obj.sourceFiles) {
		const sourceFile = file as SupportBundleSourceFile;
		assertSourceFileValid(sourceFile);
		const expectedSha = computeSha256(sourceFile.content);
		if (expectedSha !== sourceFile.sha256) {
			throw new Error(
				`support bundle: source file "${sourceFile.path}" sha256 mismatch (input ${sourceFile.sha256}, computed ${expectedSha})`,
			);
		}
	}
	if (!obj.settings || typeof obj.settings !== "object") {
		throw new Error("support bundle: settings block is required");
	}
	assertSettingsValid(obj.settings as SupportBundleSettings);
	if (!Array.isArray(obj.logs)) {
		throw new Error("support bundle: logs must be an array");
	}
	for (const line of obj.logs) {
		assertLogLineValid(line as SupportBundleLogLine);
	}
	// Verify id matches what buildSupportBundle would have stamped.
	// A tampered or copy-pasted id would otherwise survive parse and
	// silently misrepresent which binary + generation time the manifest
	// belongs to.
	const expectedId = bundleId(
		obj.binary as SupportBundleBinaryInfo,
		obj.generatedAt as string,
	);
	if (obj.id !== expectedId) {
		throw new Error(
			`support bundle: id "${obj.id}" does not match expected "${expectedId}" derived from binary + generatedAt`,
		);
	}
	return obj as unknown as SupportBundle;
}

function assertBinaryValid(b: SupportBundleBinaryInfo): void {
	// Reject arrays + nullish blocks before the field check so a parsed
	// payload with the binary slot delivered as `[]` (with attached
	// string properties) doesn't pass validation only to round-trip
	// through JSON.stringify as an empty `[]`.
	if (!b || typeof b !== "object" || Array.isArray(b)) {
		throw new Error("support bundle: binary must be an object");
	}
	// Type-check before `.trim()` so a parsed bundle with a number /
	// array / null in a binary field surfaces as a
	// `support bundle: ...` validation error rather than an uncaught
	// TypeError from the trim call itself.
	for (const key of [
		["version", b.version],
		["commitSha", b.commitSha],
		["bunVersion", b.bunVersion],
		["builtAt", b.builtAt],
	] as const) {
		const [field, value] = key;
		if (typeof value !== "string" || !value.trim()) {
			throw new Error(`support bundle: binary.${field} is required`);
		}
	}
}

function assertSourceFileValid(f: SupportBundleSourceFile): void {
	if (!f || typeof f !== "object" || Array.isArray(f)) {
		throw new Error("support bundle: sourceFile must be an object");
	}
	if (typeof f.path !== "string" || !f.path) {
		throw new Error("support bundle: sourceFile.path is required");
	}
	if (typeof f.content !== "string") {
		throw new Error(
			`support bundle: sourceFile "${f.path}" content must be a string`,
		);
	}
	if (
		typeof f.bytes !== "number" ||
		!Number.isInteger(f.bytes) ||
		f.bytes < 0
	) {
		throw new Error(
			`support bundle: sourceFile "${f.path}" bytes must be a non-negative integer`,
		);
	}
	if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) {
		throw new Error(
			`support bundle: sourceFile "${f.path}" sha256 must be a 64-char hex string`,
		);
	}
	const utf8Bytes = new TextEncoder().encode(f.content).byteLength;
	if (f.bytes !== utf8Bytes) {
		throw new Error(
			`support bundle: source file "${f.path}" bytes ${f.bytes} != UTF-8 byte length ${utf8Bytes}`,
		);
	}
}

function assertSettingsValid(s: SupportBundleSettings): void {
	if (!s || typeof s !== "object" || Array.isArray(s)) {
		throw new Error("support bundle: settings must be an object");
	}
	if (!s.values || typeof s.values !== "object" || Array.isArray(s.values)) {
		throw new Error("support bundle: settings.values must be an object");
	}
	for (const [key, value] of Object.entries(s.values)) {
		if (typeof value !== "string") {
			throw new Error(
				`support bundle: settings.values["${key}"] must be a string`,
			);
		}
	}
	if (!Array.isArray(s.redactedKeys)) {
		throw new Error("support bundle: settings.redactedKeys must be an array");
	}
	for (const key of s.redactedKeys) {
		if (typeof key !== "string") {
			throw new Error("support bundle: redactedKeys entries must be strings");
		}
	}
}

function assertLogLineValid(line: SupportBundleLogLine): void {
	if (!line || typeof line !== "object" || Array.isArray(line)) {
		throw new Error("support bundle: log line must be an object");
	}
	if (typeof line.timestamp !== "string" || !line.timestamp) {
		throw new Error("support bundle: log.timestamp is required");
	}
	if (
		line.level !== "debug" &&
		line.level !== "info" &&
		line.level !== "warn" &&
		line.level !== "error"
	) {
		throw new Error(
			`support bundle: log.level "${String(line.level)}" is not a known level`,
		);
	}
	if (typeof line.module !== "string" || !line.module.trim()) {
		throw new Error("support bundle: log.module is required");
	}
	if (typeof line.message !== "string") {
		throw new Error("support bundle: log.message must be a string");
	}
}

/**
 * SHA-256 over a UTF-8 string, returned as hex. Pure JS implementation
 * so the module stays portable (no Node `crypto` dependency in this
 * primitive). Output matches Node's `crypto.createHash('sha256')`.
 */
export function computeSha256(input: string): string {
	const bytes = new TextEncoder().encode(input);
	return sha256Hex(bytes);
}

// ---------------------------------------------------------------------------
// Pure JS SHA-256 (FIPS 180-4 §6.2). Kept small + branch-light so the bundle
// primitive can run in any JS environment without pulling in `node:crypto`.

const K: readonly number[] = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
	0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: number, n: number): number {
	return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function sha256Hex(input: Uint8Array): string {
	const padded = padMessage(input);
	const H = [
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
		0x1f83d9ab, 0x5be0cd19,
	];
	const W = new Uint32Array(64);
	for (let i = 0; i < padded.length; i += 64) {
		for (let t = 0; t < 16; t += 1) {
			W[t] =
				((padded[i + t * 4] ?? 0) << 24) |
				((padded[i + t * 4 + 1] ?? 0) << 16) |
				((padded[i + t * 4 + 2] ?? 0) << 8) |
				(padded[i + t * 4 + 3] ?? 0);
			W[t] = W[t]! >>> 0;
		}
		for (let t = 16; t < 64; t += 1) {
			const wt15 = W[t - 15]!;
			const wt2 = W[t - 2]!;
			const s0 = rotr(wt15, 7) ^ rotr(wt15, 18) ^ (wt15 >>> 3);
			const s1 = rotr(wt2, 17) ^ rotr(wt2, 19) ^ (wt2 >>> 10);
			W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) >>> 0;
		}
		let a = H[0]!;
		let b = H[1]!;
		let c = H[2]!;
		let d = H[3]!;
		let e = H[4]!;
		let f = H[5]!;
		let g = H[6]!;
		let h = H[7]!;
		for (let t = 0; t < 64; t += 1) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const temp1 = (h + S1 + ch + K[t]! + W[t]!) >>> 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (S0 + maj) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}
		H[0] = (H[0]! + a) >>> 0;
		H[1] = (H[1]! + b) >>> 0;
		H[2] = (H[2]! + c) >>> 0;
		H[3] = (H[3]! + d) >>> 0;
		H[4] = (H[4]! + e) >>> 0;
		H[5] = (H[5]! + f) >>> 0;
		H[6] = (H[6]! + g) >>> 0;
		H[7] = (H[7]! + h) >>> 0;
	}
	return H.map((x) => x.toString(16).padStart(8, "0")).join("");
}

function padMessage(input: Uint8Array): Uint8Array {
	const bitLength = BigInt(input.length) * 8n;
	// We need (L + 1 + padLen) ≡ 56 (mod 64). JS `%` returns negative
	// remainders for negative operands; normalize with `((x % 64) + 64) % 64`.
	const padLen = (((56 - (input.length + 1)) % 64) + 64) % 64;
	const total = input.length + 1 + padLen + 8;
	const out = new Uint8Array(total);
	out.set(input, 0);
	out[input.length] = 0x80;
	const view = new DataView(out.buffer);
	view.setBigUint64(total - 8, bitLength, false);
	return out;
}
