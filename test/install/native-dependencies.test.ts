import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("native dependency install policy", () => {
	it("trusts tree-sitter native packages required by the CLI safety parser", () => {
		const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
			trustedDependencies?: string[];
		};

		expect(pkg.trustedDependencies).toEqual(
			expect.arrayContaining(["tree-sitter", "tree-sitter-bash"]),
		);
	});
});
