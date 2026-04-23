/**
 * TDD tests to catch stale "composer" references in the codebase.
 * These tests enforce the Maestro rename is complete.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getGlobalInstallCommand,
	getPackageName,
} from "../../../src/package-metadata.js";

const ROOT = join(__dirname, "../../..");

function grepSource(pattern: string, include: string): string[] {
	try {
		const result = execSync(
			`grep -rn "${pattern}" --include="${include}" ${ROOT}/src/ ${ROOT}/packages/ 2>/dev/null | grep -v node_modules | grep -v dist | grep -v ".nx"`,
			{ encoding: "utf-8" },
		);
		return result
			.trim()
			.split("\n")
			.filter((l) => l.length > 0);
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
				const result = execSync(
					`grep -rn "composer_tui" ${ROOT}/packages/tui-rs/src/ ${ROOT}/packages/tui-rs/tests/ ${ROOT}/packages/tui-rs/benches/ 2>/dev/null | grep -v target/`,
					{ encoding: "utf-8" },
				);
				const lines = result
					.trim()
					.split("\n")
					.filter((l) => l.length > 0);
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
});
