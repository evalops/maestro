import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWebRoot } from "../../src/server/web-root.js";

describe("resolveWebRoot", () => {
	it("uses built web assets when only the production image layout exists", () => {
		const root = mkdtempSync(join(tmpdir(), "maestro-web-root-"));
		try {
			const distRoot = join(root, "packages/web/dist");
			mkdirSync(distRoot, { recursive: true });
			writeFileSync(join(distRoot, "index.html"), "<html></html>");

			expect(resolveWebRoot({ baseDir: join(root, "dist"), env: {} })).toBe(
				distRoot,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("honors MAESTRO_WEB_ROOT when explicitly configured", () => {
		const configured = "/srv/maestro-web";
		expect(
			resolveWebRoot({
				baseDir: "/app/dist",
				env: { MAESTRO_WEB_ROOT: configured },
			}),
		).toBe(configured);
	});
});
