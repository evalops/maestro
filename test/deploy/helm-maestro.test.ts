import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const chartPath = resolve(repoRoot, "deploy/helm/maestro");
const hasHelm =
	spawnSync("helm", ["version", "--short"], { encoding: "utf8" }).status === 0;
const helmIt = hasHelm ? it : it.skip;

function renderChart(args: string[] = []) {
	return spawnSync("helm", ["template", "maestro", chartPath, ...args], {
		cwd: repoRoot,
		encoding: "utf8",
	});
}

describe("maestro Helm chart", () => {
	helmIt(
		"renders one replica by default for process-local headless routing",
		() => {
			const result = renderChart();

			expect(result.status).toBe(0);
			expect(result.stdout).toMatch(/replicas:\s+1/);
		},
	);

	helmIt("rejects multi-replica process-local headless routing", () => {
		const result = renderChart(["--set", "replicaCount=2"]);

		expect(result.status).not.toBe(0);
		expect(`${result.stderr}\n${result.stdout}`).toContain(
			"replicaCount > 1 requires headlessRuntime.routing.mode",
		);
	});

	helmIt(
		"allows multi-replica deployments when sticky routing is declared",
		() => {
			const result = renderChart([
				"--set",
				"replicaCount=2",
				"--set",
				"headlessRuntime.routing.mode=sticky-session",
			]);

			expect(result.status).toBe(0);
			expect(result.stdout).toMatch(/replicas:\s+2/);
		},
	);
});
