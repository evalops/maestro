import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("@evalops/ai TypeScript boundary", () => {
	it("includes painter image-provider dependencies", () => {
		const config = JSON.parse(
			readFileSync("packages/ai/tsconfig.build.json", "utf8"),
		) as { include?: string[] };

		expect(config.include).toContain(
			"../../src/services/image-providers/**/*.ts",
		);
	});
});
