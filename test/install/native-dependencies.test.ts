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

	it("keeps Daytona out of the root public CLI install tree", () => {
		const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
			dependencies?: Record<string, string>;
		};

		expect(pkg.dependencies).not.toHaveProperty("@daytonaio/sdk");
	});

	it("uses the patched OpenTelemetry runtime line for public installs", () => {
		const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
			dependencies?: Record<string, string>;
		};

		expect(pkg.dependencies).toMatchObject({
			"@opentelemetry/auto-instrumentations-node": "^0.76.0",
			"@opentelemetry/resources": "^2.7.1",
			"@opentelemetry/sdk-node": "0.218.0",
			"@opentelemetry/semantic-conventions": "^1.41.1",
		});
	});
});
