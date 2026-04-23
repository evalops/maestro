import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHostedWorkspacePath } from "../../src/headless/workspace-root.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
	);
});

describe("hosted workspace root guard", () => {
	it("allows paths inside the hosted workspace root", async () => {
		const workspaceRoot = await createTempDir("maestro-workspace-root-");
		expect(
			resolveHostedWorkspacePath(workspaceRoot, {
				MAESTRO_HOSTED_RUNNER_MODE: "1",
				MAESTRO_WORKSPACE_ROOT: workspaceRoot,
			}),
		).toBe(realpathSync(workspaceRoot));
	});

	it("resolves relative paths against the hosted workspace root", async () => {
		const workspaceRoot = await createTempDir("maestro-workspace-root-");
		await mkdir(join(workspaceRoot, "src"));

		expect(
			resolveHostedWorkspacePath("src", {
				MAESTRO_HOSTED_RUNNER_MODE: "1",
				MAESTRO_WORKSPACE_ROOT: workspaceRoot,
			}),
		).toBe(realpathSync(join(workspaceRoot, "src")));
	});

	it("rejects paths outside the hosted workspace root", async () => {
		const workspaceRoot = await createTempDir("maestro-workspace-root-");
		const outsideRoot = await createTempDir("maestro-workspace-outside-");

		expect(() =>
			resolveHostedWorkspacePath(outsideRoot, {
				MAESTRO_HOSTED_RUNNER_MODE: "1",
				MAESTRO_WORKSPACE_ROOT: workspaceRoot,
			}),
		).toThrow(/outside hosted runner workspace root/);
	});
});
