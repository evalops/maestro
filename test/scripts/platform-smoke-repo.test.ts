import { describe, expect, it } from "vitest";
import { resolvePlatformRepo } from "../../scripts/platform-smoke-repo.js";

function existsOnly(paths: string[]) {
	const allowed = new Set(paths);
	return (path: string) => allowed.has(path);
}

describe("resolvePlatformRepo", () => {
	it("uses configured Platform repo paths when they contain go.mod", () => {
		expect(
			resolvePlatformRepo({
				env: { PLATFORM_REPO: "/tmp/evalops/platform" },
				exists: existsOnly(["/tmp/evalops/platform/go.mod"]),
			}),
		).toBe("/tmp/evalops/platform");
	});

	it("discovers a sibling platform checkout from a normal repos tree", () => {
		expect(
			resolvePlatformRepo({
				cwd: "/Users/alice/repos/maestro-internal",
				env: {},
				homeDir: "/Users/alice",
				exists: existsOnly(["/Users/alice/repos/platform/go.mod"]),
			}),
		).toBe("/Users/alice/repos/platform");
	});

	it("discovers ~/repos/platform from isolated worktrees", () => {
		expect(
			resolvePlatformRepo({
				cwd: "/Users/alice/.codex-worktrees/maestro-runtime-proof",
				env: {},
				homeDir: "/Users/alice",
				exists: existsOnly(["/Users/alice/repos/platform/go.mod"]),
			}),
		).toBe("/Users/alice/repos/platform");
	});

	it("fails clearly when no Platform checkout can be found", () => {
		expect(() =>
			resolvePlatformRepo({
				cwd: "/Users/alice/.codex-worktrees/maestro-runtime-proof",
				env: {},
				homeDir: "/Users/alice",
				exists: () => false,
			}),
		).toThrow(/Set MAESTRO_PLATFORM_REPO or PLATFORM_REPO/u);
	});
});
