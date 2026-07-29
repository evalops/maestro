import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkDocPaths, parseAllowlist } from "./check-doc-paths.mjs";

function withRepo(files, fn) {
	const root = mkdtempSync(join(tmpdir(), "doc-paths-"));
	try {
		for (const [relPath, contents] of Object.entries(files)) {
			const abs = join(root, relPath);
			mkdirSync(join(abs, ".."), { recursive: true });
			writeFileSync(abs, contents);
		}
		return fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("passes when every referenced path exists", () => {
	const failures = withRepo(
		{
			"docs/README.md": "See `packages/tui-rs/src/lib.rs` for the entrypoint.\n",
			"packages/tui-rs/src/lib.rs": "// real file\n",
		},
		(root) => checkDocPaths({ rootDir: root, allowlist: new Set() }),
	);
	assert.deepEqual(failures, []);
});

test("fails on a path inside an inline code span that does not exist", () => {
	const failures = withRepo(
		{
			"docs/README.md": "See `packages/does-not-exist/src/lib.rs` for the entrypoint.\n",
		},
		(root) => checkDocPaths({ rootDir: root, allowlist: new Set() }),
	);
	assert.equal(failures.length, 1);
	assert.match(failures[0], /packages\/does-not-exist\/src\/lib\.rs/);
});

test("fails on a path inside a fenced code block", () => {
	const failures = withRepo(
		{
			"docs/README.md": "```ts\n// src/agent/agent.ts:10\nconsole.log('hi');\n```\n",
		},
		(root) => checkDocPaths({ rootDir: root, allowlist: new Set() }),
	);
	assert.equal(failures.length, 1);
	assert.match(failures[0], /src\/agent\/agent\.ts/);
});

test("fails on a dangling relative markdown link target", () => {
	const failures = withRepo(
		{
			"docs/protocols/README.md":
				"See [the generated contract](../../packages/contracts/src/generated.ts).\n",
		},
		(root) => checkDocPaths({ rootDir: root, allowlist: new Set() }),
	);
	assert.equal(failures.length, 1);
	assert.match(failures[0], /packages\/contracts\/src\/generated\.ts/);
});

test("passes when a relative markdown link target resolves", () => {
	const failures = withRepo(
		{
			"docs/protocols/README.md":
				"See [the generated contract](../../packages/contracts/src/generated.ts).\n",
			"packages/contracts/src/generated.ts": "// generated\n",
		},
		(root) => checkDocPaths({ rootDir: root, allowlist: new Set() }),
	);
	assert.deepEqual(failures, []);
});

test("ignores prose path-like text outside of code spans", () => {
	const failures = withRepo(
		{
			"docs/README.md": "Search GitHub/docs/Stack Overflow for examples.\n",
		},
		(root) => checkDocPaths({ rootDir: root, allowlist: new Set() }),
	);
	assert.deepEqual(failures, []);
});

test("ignores paths embedded in external URLs", () => {
	const failures = withRepo(
		{
			"docs/README.md":
				"See `https://platform.openai.com/docs/guides/structured-outputs` and " +
				"[Kubernetes docs](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/).\n",
		},
		(root) => checkDocPaths({ rootDir: root, allowlist: new Set() }),
	);
	assert.deepEqual(failures, []);
});

test("ignores paths embedded in external URLs in JSON", () => {
	const failures = withRepo(
		{
			"docs/protocols/manifest.json": JSON.stringify({
				documentation: "https://example.com/docs/guides/missing",
			}),
		},
		(root) => checkDocPaths({ rootDir: root, allowlist: new Set() }),
	);
	assert.deepEqual(failures, []);
});

test("respects the allowlist for intentionally illustrative paths", () => {
	const failures = withRepo(
		{
			"docs/README.md": "Example: `packages/does-not-exist/src/lib.rs`\n",
		},
		(root) =>
			checkDocPaths({
				rootDir: root,
				allowlist: new Set(["docs/README.md\0packages/does-not-exist/src/lib.rs"]),
			}),
	);
	assert.deepEqual(failures, []);
});

test("does not apply one document's allowlist exemption to another", () => {
	const failures = withRepo(
		{
			"docs/historical.md": "Example: `packages/does-not-exist/src/lib.rs`\n",
			"docs/operational.md": "Use `packages/does-not-exist/src/lib.rs`.\n",
		},
		(root) =>
			checkDocPaths({
				rootDir: root,
				allowlist: new Set([
					"docs/historical.md\0packages/does-not-exist/src/lib.rs",
				]),
			}),
	);
	assert.deepEqual(failures, [
		"docs/operational.md: references missing path `packages/does-not-exist/src/lib.rs`",
	]);
});

test("rejects legacy bare-string allowlist entries", () => {
	assert.throws(
		() => parseAllowlist(["packages/example/src/lib.rs"], "allowlist.json"),
		/invalid entry/,
	);
});

test("requires a reason for every source-scoped allowlist entry", () => {
	assert.throws(
		() =>
			parseAllowlist(
				[{ source: "docs/historical.md", path: "packages/example/src/lib.rs" }],
				"allowlist.json",
			),
		/invalid entry/,
	);
});

test("rejects blank source and path values", () => {
	for (const entry of [
		{ source: "", path: "packages/example/src/lib.rs", reason: "historical" },
		{ source: "docs/historical.md", path: " ", reason: "historical" },
	]) {
		assert.throws(() => parseAllowlist([entry], "allowlist.json"), /invalid entry/);
	}
});

test("rejects extra allowlist entry keys", () => {
	assert.throws(
		() =>
			parseAllowlist(
				[
					{
						source: "docs/historical.md",
						path: "packages/example/src/lib.rs",
						reason: "historical",
						disabled: true,
					},
				],
				"allowlist.json",
			),
		/invalid entry/,
	);
});

test("rejects duplicate source and path pairs", () => {
	const entry = {
		source: "docs/historical.md",
		path: "packages/example/src/lib.rs",
		reason: "historical",
	};
	assert.throws(
		() => parseAllowlist([entry, entry], "allowlist.json"),
		/duplicate source\/path entry/,
	);
});

test("fails on a dangling path inside a JSON manifest", () => {
	const failures = withRepo(
		{
			"docs/protocols/manifest.json": JSON.stringify({
				checks: [{ path: "packages/does-not-exist/src/lib.rs" }],
			}),
		},
		(root) => checkDocPaths({ rootDir: root, allowlist: new Set() }),
	);
	assert.equal(failures.length, 1);
	assert.match(failures[0], /packages\/does-not-exist\/src\/lib\.rs/);
});

test("reports invalid JSON as a failure instead of throwing", () => {
	const failures = withRepo(
		{ "docs/protocols/manifest.json": "{ not valid json" },
		(root) => checkDocPaths({ rootDir: root, allowlist: new Set() }),
	);
	assert.equal(failures.length, 1);
	assert.match(failures[0], /invalid JSON/);
});
