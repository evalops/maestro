import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("Maestro Dockerfile", () => {
	it("copies database migration SQL files into the runtime image", () => {
		const dockerfile = readFileSync(resolve(repoRoot, "Dockerfile"), "utf8");

		expect(dockerfile).toContain(
			"COPY --from=builder /app/src/db/migrations ./dist/db/migrations",
		);
	});
});
