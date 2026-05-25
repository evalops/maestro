import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isPackageImpactingPath,
	packageChangedSinceTag,
} from "../../scripts/release-impact-filter.mjs";

const fixtures: string[] = [];

function git(root: string, args: string[]) {
	return execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_DATE: "2026-05-25T00:00:00Z",
			GIT_COMMITTER_DATE: "2026-05-25T00:00:00Z",
		},
	});
}

function writeFixtureFile(root: string, path: string, contents: string) {
	const target = join(root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, contents);
}

function makeRepo() {
	const root = join(
		tmpdir(),
		`maestro-release-impact-${process.pid}-${Date.now()}-${fixtures.length}`,
	);
	fixtures.push(root);
	mkdirSync(root, { recursive: true });
	git(root, ["init"]);
	git(root, ["config", "user.name", "Maestro Tests"]);
	git(root, ["config", "user.email", "maestro-tests@example.com"]);
	return root;
}

function commit(root: string, message: string) {
	git(root, ["add", "."]);
	git(root, ["commit", "-m", message]);
	return git(root, ["rev-parse", "HEAD"]).trim();
}

const inlineRustTests = `pub fn cache_key(path: &str) -> String {
	format!("cache:{path}")
}

#[cfg(test)]
#[allow(clippy::float_cmp)]
mod tests {
	use super::*;

	#[test]
	fn includes_path() {
		assert_eq!(cache_key("fixture"), "cache:fixture");
	}
}
`;

const inlineRustTestsWithBlockComment = `pub fn cache_key(path: &str) -> String {
	format!("cache:{path}")
}

#[cfg(test)]
mod tests {
	use super::*;

	/*
	 * A block comment containing a closing brace should not end the test module: }
	 */
	#[test]
	fn includes_path() {
		assert_eq!(cache_key("fixture"), "cache:fixture");
	}
}
`;

const inlineRustTestsWithNestedBlockComment = `pub fn cache_key(path: &str) -> String {
	format!("cache:{path}")
}

#[cfg(test)]
mod tests {
	use super::*;

	/*
	 * Outer comment starts here.
	 * /* Nested comment with a closing brace: } */
	 * Still inside the outer comment with another brace: }
	 */
	#[test]
	fn includes_path() {
		assert_eq!(cache_key("fixture"), "cache:fixture");
	}
}
`;

const inlineRustTestsWithCharLiteral = `pub fn cache_key(path: &str) -> String {
	format!("cache:{path}")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn includes_path() {
		let closing_brace = '}';
		assert_eq!(closing_brace, '}');
		assert_eq!(cache_key("fixture"), "cache:fixture");
	}
}
`;

const inlineRustTestsWithRawString = `pub fn cache_key(path: &str) -> String {
	format!("cache:{path}")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn includes_path() {
		let raw = r#""}"#;
		assert_eq!(raw, "\\"}");
		assert_eq!(cache_key("fixture"), "cache:fixture");
	}
}
`;

const inlineRustTestsWithCommentSemicolon = `pub fn cache_key(path: &str) -> String {
	format!("cache:{path}")
}

#[cfg(test)]
mod tests { // a comment with a semicolon should not look like mod tests;
	use super::*;

	#[test]
	fn includes_path() {
		assert_eq!(cache_key("fixture"), "cache:fixture");
	}
}
`;

const extractedRustModule = `pub fn cache_key(path: &str) -> String {
	format!("cache:{path}")
}

#[cfg(test)]
#[allow(clippy::float_cmp)]
mod tests;
`;

const extractedRustModuleWithComments = `pub fn cache_key(path: &str) -> String {
	format!("cache:{path}")
}

#[cfg(test)]
// Keep this module beside the production code for rust-analyzer.
/// Extracted cache-key tests.
#[allow(clippy::float_cmp)]
mod tests;
`;

const unguardedRustModule = `pub fn cache_key(path: &str) -> String {
	format!("cache:{path}")
}

mod tests;
`;

const extractedRustTests = `use super::*;

#[test]
fn includes_path() {
	assert_eq!(cache_key("fixture"), "cache:fixture");
}
`;

describe("release impact filter", () => {
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("ignores Rust test-module extraction when package code is unchanged", () => {
		const root = makeRepo();
		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache.rs",
			inlineRustTests,
		);
		const tagTarget = commit(root, "initial package source");

		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache.rs",
			extractedRustModule,
		);
		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache/tests.rs",
			extractedRustTests,
		);
		commit(root, "extract rust tests");

		expect(packageChangedSinceTag({ cwd: root, tagTarget })).toBe(false);
	});

	it("ignores braces in block comments while stripping Rust test modules", () => {
		const root = makeRepo();
		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache.rs",
			inlineRustTestsWithBlockComment,
		);
		const tagTarget = commit(root, "initial package source");

		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache.rs",
			extractedRustModule,
		);
		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache/tests.rs",
			extractedRustTests,
		);
		commit(root, "extract rust tests");

		expect(packageChangedSinceTag({ cwd: root, tagTarget })).toBe(false);
	});

	it("ignores braces in nested block comments while stripping Rust test modules", () => {
		const root = makeRepo();
		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache.rs",
			inlineRustTestsWithNestedBlockComment,
		);
		const tagTarget = commit(root, "initial package source");

		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache.rs",
			extractedRustModule,
		);
		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache/tests.rs",
			extractedRustTests,
		);
		commit(root, "extract rust tests");

		expect(packageChangedSinceTag({ cwd: root, tagTarget })).toBe(false);
	});

	it("ignores braces in Rust char literals while stripping test modules", () => {
		const root = makeRepo();
		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache.rs",
			inlineRustTestsWithCharLiteral,
		);
		const tagTarget = commit(root, "initial package source");

		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache.rs",
			extractedRustModule,
		);
		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache/tests.rs",
			extractedRustTests,
		);
		commit(root, "extract rust tests");

		expect(packageChangedSinceTag({ cwd: root, tagTarget })).toBe(false);
	});

	it("ignores braces and embedded quotes in Rust raw strings", () => {
		const root = makeRepo();
		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache.rs",
			inlineRustTestsWithRawString,
		);
		const tagTarget = commit(root, "initial package source");

		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache.rs",
			extractedRustModule,
		);
		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache/tests.rs",
			extractedRustTests,
		);
		commit(root, "extract rust tests");

		expect(packageChangedSinceTag({ cwd: root, tagTarget })).toBe(false);
	});

	it("ignores semicolons in comments on inline Rust test module declarations", () => {
		const root = makeRepo();
		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache.rs",
			inlineRustTestsWithCommentSemicolon,
		);
		const tagTarget = commit(root, "initial package source");

		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache.rs",
			extractedRustModule,
		);
		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache/tests.rs",
			extractedRustTests,
		);
		commit(root, "extract rust tests");

		expect(packageChangedSinceTag({ cwd: root, tagTarget })).toBe(false);
	});

	it("treats tests.rs as package-impacting without a cfg(test) module declaration", () => {
		const root = makeRepo();
		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache.rs",
			unguardedRustModule,
		);
		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache/tests.rs",
			extractedRustTests,
		);
		const tagTarget = commit(root, "initial package source");

		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache/tests.rs",
			extractedRustTests.replace("cache:fixture", "cache:changed"),
		);
		commit(root, "change unguarded module implementation");

		expect(packageChangedSinceTag({ cwd: root, tagTarget })).toBe(true);
	});

	it("ignores comments between cfg(test) and extracted test module declarations", () => {
		const root = makeRepo();
		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache.rs",
			extractedRustModuleWithComments,
		);
		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache/tests.rs",
			extractedRustTests,
		);
		const tagTarget = commit(root, "initial package source");

		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache/tests.rs",
			extractedRustTests.replace("cache:fixture", "cache:still-test-only"),
		);
		commit(root, "change extracted tests");

		expect(packageChangedSinceTag({ cwd: root, tagTarget })).toBe(false);
	});

	it("still detects production Rust changes inside package workspaces", () => {
		const root = makeRepo();
		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache.rs",
			extractedRustModule,
		);
		const tagTarget = commit(root, "initial package source");

		writeFixtureFile(
			root,
			"packages/tui-rs/src/tools/cache.rs",
			extractedRustModule.replace("cache:{path}", "cache:v2:{path}"),
		);
		commit(root, "change package source");

		expect(packageChangedSinceTag({ cwd: root, tagTarget })).toBe(true);
	});

	it("does not make release guard helper edits require a package version bump", () => {
		const root = makeRepo();
		writeFixtureFile(
			root,
			"scripts/release-impact-filter.mjs",
			"export const version = 1;\n",
		);
		const tagTarget = commit(root, "initial release helper");

		writeFixtureFile(
			root,
			"scripts/release-impact-filter.mjs",
			"export const version = 2;\n",
		);
		commit(root, "change release helper");

		expect(isPackageImpactingPath("scripts/release-impact-filter.mjs")).toBe(
			false,
		);
		expect(packageChangedSinceTag({ cwd: root, tagTarget })).toBe(false);
	});

	it("keeps release-critical config and generated-contract paths package impacting", () => {
		expect(isPackageImpactingPath("package.json")).toBe(true);
		expect(isPackageImpactingPath("tsconfig.base.json")).toBe(true);
		expect(isPackageImpactingPath("scripts/codegen-utils.mjs")).toBe(true);
		expect(isPackageImpactingPath("proto/maestro/v1/service.proto")).toBe(true);
		expect(isPackageImpactingPath("types/protocol.ts")).toBe(true);
		expect(isPackageImpactingPath(".github/workflows/tag-release.yml")).toBe(
			false,
		);
	});
});
