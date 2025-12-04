import { describe, expect, it } from "vitest";
import {
	extractDependencies,
	hasPackageInstall,
} from "../../src/utils/dependency-extractor.js";

describe("extractDependencies", () => {
	describe("npm commands", () => {
		it("extracts single package from npm install", () => {
			expect(extractDependencies("npm install lodash")).toEqual(["lodash"]);
		});

		it("extracts multiple packages from npm install", () => {
			expect(extractDependencies("npm install lodash express")).toEqual([
				"lodash",
				"express",
			]);
		});

		it("extracts from npm i shorthand", () => {
			expect(extractDependencies("npm i react")).toEqual(["react"]);
		});

		it("extracts from npm add", () => {
			expect(extractDependencies("npm add typescript")).toEqual(["typescript"]);
		});

		it("strips version from package@version", () => {
			expect(extractDependencies("npm install lodash@4.17.21")).toEqual([
				"lodash",
			]);
		});

		it("handles scoped packages", () => {
			expect(extractDependencies("npm install @types/node")).toEqual([
				"@types/node",
			]);
		});

		it("strips version from scoped packages", () => {
			expect(extractDependencies("npm install @types/node@18.0.0")).toEqual([
				"@types/node",
			]);
		});

		it("ignores flags before packages", () => {
			expect(extractDependencies("npm install --save-dev typescript")).toEqual([
				"typescript",
			]);
		});

		it("ignores flags with values", () => {
			expect(
				extractDependencies(
					"npm install --registry=https://npm.pkg.github.com lodash",
				),
			).toEqual(["lodash"]);
		});
	});

	describe("yarn commands", () => {
		it("extracts from yarn install", () => {
			expect(extractDependencies("yarn install lodash")).toEqual(["lodash"]);
		});

		it("extracts from yarn add", () => {
			expect(extractDependencies("yarn add react react-dom")).toEqual([
				"react",
				"react-dom",
			]);
		});

		it("handles yarn with flags", () => {
			expect(extractDependencies("yarn add -D @types/react")).toEqual([
				"@types/react",
			]);
		});
	});

	describe("pnpm commands", () => {
		it("extracts from pnpm install", () => {
			expect(extractDependencies("pnpm install zod")).toEqual(["zod"]);
		});

		it("extracts from pnpm add", () => {
			expect(extractDependencies("pnpm add vitest")).toEqual(["vitest"]);
		});

		it("extracts from pnpm i", () => {
			expect(extractDependencies("pnpm i eslint")).toEqual(["eslint"]);
		});
	});

	describe("bun commands", () => {
		it("extracts from bun add", () => {
			expect(extractDependencies("bun add hono")).toEqual(["hono"]);
		});

		it("extracts from bun install", () => {
			expect(extractDependencies("bun install elysia")).toEqual(["elysia"]);
		});

		it("handles bun with flags", () => {
			expect(extractDependencies("bun add --dev @types/bun")).toEqual([
				"@types/bun",
			]);
		});
	});

	describe("pip commands", () => {
		it("extracts from pip install", () => {
			expect(extractDependencies("pip install requests")).toEqual(["requests"]);
		});

		it("extracts from pip3 install", () => {
			expect(extractDependencies("pip3 install flask")).toEqual(["flask"]);
		});

		it("strips version with ==", () => {
			expect(extractDependencies("pip install requests==2.28.0")).toEqual([
				"requests",
			]);
		});

		it("strips version with >=", () => {
			expect(extractDependencies("pip install django>=4.0")).toEqual([
				"django",
			]);
		});

		it("handles multiple pip packages", () => {
			expect(extractDependencies("pip install requests flask django")).toEqual([
				"requests",
				"flask",
				"django",
			]);
		});

		it("ignores pip flags", () => {
			expect(extractDependencies("pip install -r requirements.txt")).toEqual([
				"requirements.txt",
			]);
		});
	});

	describe("special package specifiers", () => {
		it("extracts package name from git+ URLs (captures 'git' prefix)", () => {
			// The regex captures 'git' as it appears before the + character
			expect(
				extractDependencies("npm install git+https://github.com/user/repo.git"),
			).toEqual(["git"]);
		});

		it("preserves local paths starting with ./", () => {
			expect(extractDependencies("npm install ./local-package")).toEqual([
				"./local-package",
			]);
		});

		it("preserves parent paths starting with ../", () => {
			expect(extractDependencies("npm install ../sibling-package")).toEqual([
				"../sibling-package",
			]);
		});

		it("preserves absolute paths starting with /", () => {
			expect(extractDependencies("npm install /abs/path/pkg")).toEqual([
				"/abs/path/pkg",
			]);
		});
	});

	describe("multiple commands", () => {
		it("extracts from chained npm && pip commands", () => {
			expect(
				extractDependencies("npm install lodash && pip install requests"),
			).toEqual(["lodash", "requests"]);
		});

		it("extracts from semicolon-separated commands", () => {
			expect(extractDependencies("npm install lodash; yarn add react")).toEqual(
				["lodash", "react"],
			);
		});
	});

	describe("edge cases", () => {
		it("returns empty array for non-install commands", () => {
			expect(extractDependencies("npm run build")).toEqual([]);
		});

		it("returns empty array for empty string", () => {
			expect(extractDependencies("")).toEqual([]);
		});

		it("returns empty array for regular shell commands", () => {
			expect(extractDependencies("ls -la")).toEqual([]);
		});

		it("handles case-insensitive matching", () => {
			expect(extractDependencies("NPM INSTALL lodash")).toEqual(["lodash"]);
		});
	});
});

describe("hasPackageInstall", () => {
	it("returns true for npm install", () => {
		expect(hasPackageInstall("npm install lodash")).toBe(true);
	});

	it("returns true for yarn add", () => {
		expect(hasPackageInstall("yarn add react")).toBe(true);
	});

	it("returns true for pip install", () => {
		expect(hasPackageInstall("pip install requests")).toBe(true);
	});

	it("returns false for non-install commands", () => {
		expect(hasPackageInstall("npm run build")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(hasPackageInstall("")).toBe(false);
	});

	it("returns false for regular shell commands", () => {
		expect(hasPackageInstall("echo hello")).toBe(false);
	});
});
