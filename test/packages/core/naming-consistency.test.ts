/**
 * TDD tests to catch stale "composer" references in the codebase.
 * These tests enforce the Maestro rename is complete.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getGlobalInstallCommand,
	getPackageName,
} from "../../../src/package-metadata.js";

const ROOT = join(__dirname, "../../..");
const PRODUCT_COPY_EXTENSIONS = new Set([
	".css",
	".html",
	".json",
	".js",
	".kt",
	".lua",
	".md",
	".mjs",
	".nix",
	".rs",
	".sh",
	".svg",
	".ts",
	".tsx",
	".toml",
	".xml",
	".yaml",
	".yml",
]);
const PRODUCT_COPY_ROOTS = [
	".github",
	"README.md",
	"CHANGELOG.md",
	"docs",
	"evals",
	"examples",
	"flake.nix",
	"packages",
	"scripts",
	"src",
	"test",
	"todo.md",
];
const PRODUCT_COPY_IGNORED_DIRS = new Set([
	".git",
	".nx",
	"coverage",
	"dist",
	"node_modules",
	"target",
]);

function productCopyRelativePath(path: string): string {
	return path.slice(ROOT.length + 1).replaceAll("\\", "/");
}

function walkProductCopyFiles(path: string): string[] {
	const relativePath = productCopyRelativePath(path);
	const name = basename(path);
	if (PRODUCT_COPY_IGNORED_DIRS.has(name)) {
		return [];
	}
	const stat = statSync(path);
	if (stat.isDirectory()) {
		return readdirSync(path).flatMap((entry) =>
			walkProductCopyFiles(join(path, entry)),
		);
	}
	if (!stat.isFile()) {
		return [];
	}
	if (
		!PRODUCT_COPY_EXTENSIONS.has(
			name.includes(".") ? name.slice(name.lastIndexOf(".")) : "",
		)
	) {
		return [];
	}
	if (relativePath.endsWith(".snap")) {
		return [];
	}
	return [path];
}

function isAllowedComposerProductCopyLine(relativePath: string, line: string) {
	if (!/\bComposer\b/.test(line)) {
		return true;
	}
	if (
		line.includes("@evalops/composer") ||
		line.includes("composer.evalops.ai") ||
		line.includes(".composer") ||
		line.includes("X-Composer-") ||
		line.includes("x-composer-") ||
		line.includes("composer-") ||
		line.includes("composer_") ||
		line.includes("<composer-") ||
		line.includes("/composer")
	) {
		return true;
	}
	if (
		line.includes("legacy Composer") ||
		line.includes("stale Composer") ||
		line.includes("not.toContain") ||
		line.includes("not.toEqual") ||
		line.includes("assert_ne!") ||
		line.includes("assert!(!") ||
		line.includes('!tip.contains("Composer")') ||
		line.includes("Composer control plane login code") ||
		line.includes('Composer "Focus Mode"')
	) {
		return true;
	}
	if (/Composer[A-Z_a-z0-9]/.test(line) || /[A-Z_a-z0-9]Composer/.test(line)) {
		return true;
	}
	if (/\bComposer\.[A-Za-z]/.test(line)) {
		return true;
	}
	if (relativePath === "test/packages/core/naming-consistency.test.ts") {
		return true;
	}
	if (
		relativePath.startsWith("src/composers/") ||
		relativePath.startsWith("test/composers/") ||
		relativePath === "src/cli-tui/commands/composer-handlers.ts" ||
		relativePath === "src/server/handlers/composer.ts"
	) {
		return true;
	}
	return false;
}

function grepSource(pattern: string, include: string): string[] {
	try {
		const result = execFileSync(
			"grep",
			[
				"-rn",
				pattern,
				`--include=${include}`,
				join(ROOT, "src"),
				join(ROOT, "packages"),
			],
			{ encoding: "utf-8" },
		);
		return result
			.trim()
			.split("\n")
			.filter((l) => {
				const normalized = l.replaceAll("\\", "/");
				return (
					normalized.length > 0 &&
					!normalized.includes("node_modules") &&
					!normalized.includes("/dist/") &&
					!normalized.includes("/.nx/")
				);
			});
	} catch {
		return []; // grep returns exit code 1 when no matches
	}
}

describe("Naming Consistency", () => {
	describe("no COMPOSER_ env vars in source", () => {
		it("TypeScript source has no COMPOSER_ env vars", () => {
			const hits = grepSource("COMPOSER_", "*.ts").filter(
				(line) =>
					!line.includes("composer.json") && // npm/PHP config file reference
					!line.includes("ComposerError") && // TypeScript type name
					!line.includes("ComposerState") &&
					!line.includes("composers/") && // domain concept directory
					!line.includes("composerManager") &&
					!line.includes("isComposerError") &&
					!line.includes("//") && // comments about migration
					!line.includes("test"),
			);
			if (hits.length > 0) {
				console.log("Found COMPOSER_ env vars:", hits.slice(0, 5));
			}
			expect(hits.length).toBe(0);
		});
	});

	describe("no .composer/ paths in source", () => {
		it("TypeScript source uses .maestro/ not .composer/", () => {
			const hits = grepSource("\\.composer/", "*.ts").filter(
				(line) =>
					!line.includes("node_modules") &&
					!line.includes("composers/") && // domain concept
					!line.includes("test") &&
					!line.includes("__snapshots__"),
			);
			if (hits.length > 0) {
				console.log("Found .composer/ paths:", hits.slice(0, 5));
			}
			expect(hits.length).toBe(0);
		});
	});

	describe("package.json names", () => {
		it("root package metadata stays aligned with the published package name", () => {
			const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
			expect(pkg.name).toMatch(/^@[^/]+\/maestro$/);
			expect(pkg.name).toBe(getPackageName());
			expect(getGlobalInstallCommand("npm")).toContain(pkg.name);
		});

		it("web package is @evalops/maestro-web", () => {
			const pkg = JSON.parse(
				readFileSync(join(ROOT, "packages/web/package.json"), "utf-8"),
			);
			expect(pkg.name).toBe("@evalops/maestro-web");
		});

		it("core package is @evalops/maestro-core", () => {
			const pkg = JSON.parse(
				readFileSync(join(ROOT, "packages/core/package.json"), "utf-8"),
			);
			expect(pkg.name).toBe("@evalops/maestro-core");
		});

		it("CLI binary is maestro", () => {
			const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
			expect(pkg.bin).toHaveProperty("maestro");
			expect(pkg.bin).not.toHaveProperty("composer");
		});
	});

	describe("no composer telemetry attributes", () => {
		it("telemetry uses maestro.* not composer.* attributes", () => {
			const hits = grepSource('"composer\\.', "*.ts").filter(
				(line) =>
					!line.includes("composers/") &&
					!line.includes("composer.json") &&
					!line.includes("ComposerError") &&
					!line.includes("packages/vscode-extension/") &&
					!line.includes("test"),
			);
			if (hits.length > 0) {
				console.log("Found composer.* telemetry:", hits.slice(0, 5));
			}
			expect(hits.length).toBe(0);
		});
	});

	describe("Rust crate name", () => {
		it("Cargo.toml uses maestro-tui", () => {
			const cargo = readFileSync(
				join(ROOT, "packages/tui-rs/Cargo.toml"),
				"utf-8",
			);
			expect(cargo).toContain('name = "maestro-tui"');
			expect(cargo).not.toContain('name = "composer-tui"');
		});

		it("no composer_tui imports in Rust source", () => {
			try {
				const result = execFileSync(
					"grep",
					[
						"-rn",
						"composer_tui",
						join(ROOT, "packages/tui-rs/src"),
						join(ROOT, "packages/tui-rs/tests"),
						join(ROOT, "packages/tui-rs/benches"),
					],
					{ encoding: "utf-8" },
				);
				const lines = result
					.trim()
					.split("\n")
					.filter((l) => l.length > 0 && !l.includes("/target/"));
				if (lines.length > 0) {
					console.log("Found composer_tui:", lines.slice(0, 5));
				}
				expect(lines.length).toBe(0);
			} catch {
				// grep exit 1 = no matches = good
			}
		});
	});

	describe("config directory", () => {
		it("MAESTRO_HOME defaults use .maestro", () => {
			const constants = readFileSync(
				join(ROOT, "src/config/constants.ts"),
				"utf-8",
			);
			expect(constants).toContain(".maestro");
		});
	});

	describe("product-facing branding", () => {
		it("does not use Composer as a product name", () => {
			const files = PRODUCT_COPY_ROOTS.flatMap((root) =>
				walkProductCopyFiles(join(ROOT, root)),
			);
			const hits = files.flatMap((file) => {
				const relativePath = productCopyRelativePath(file);
				return readFileSync(file, "utf-8")
					.split("\n")
					.flatMap((line, index) =>
						isAllowedComposerProductCopyLine(relativePath, line)
							? []
							: `${relativePath}:${index + 1}: ${line.trim()}`,
					);
			});
			if (hits.length > 0) {
				console.log("Found stale Composer product copy:", hits.slice(0, 20));
			}
			expect(hits.length).toBe(0);
		});
	});
});
