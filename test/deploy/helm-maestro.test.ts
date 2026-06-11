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

	helmIt("renders production security and disruption defaults", () => {
		const result = renderChart();

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('image: "ghcr.io/evalops/maestro:0.1.0"');
		expect(result.stdout).toContain("name: MAESTRO_CONTROL_HOST");
		expect(result.stdout).toContain('value: "0.0.0.0"');
		expect(result.stdout).toContain("stringData: {}");
		expect(result.stdout).toContain("kind: PodDisruptionBudget");
		expect(result.stdout).toMatch(/automountServiceAccountToken:\s+false/);
		expect(result.stdout).toMatch(/terminationGracePeriodSeconds:\s+45/);
		expect(result.stdout).toMatch(/runAsUser:\s+1001/);
		expect(result.stdout).toMatch(/runAsGroup:\s+1001/);
		expect(result.stdout).toMatch(/readOnlyRootFilesystem:\s+true/);
		expect(result.stdout).toContain("emptyDir:");
		expect(result.stdout).toMatch(/mountPath:\s+\/tmp/);
		expect(result.stdout).toContain("name: HOME");
		expect(result.stdout).toContain("name: XDG_CACHE_HOME");
		expect(result.stdout).toContain("startupProbe:");
		expect(result.stdout).toContain("preStop:");
		expect(result.stdout).toContain("/.well-known/evalops/remote-runner/drain");
		expect(result.stdout).toContain("kubernetes_prestop");
	});

	helmIt(
		"keeps offline template renders stable without an explicit API key",
		() => {
			const first = renderChart();
			const second = renderChart();

			expect(first.status).toBe(0);
			expect(second.status).toBe(0);
			expect(first.stdout).toBe(second.stdout);
			expect(first.stdout).not.toContain("MAESTRO_WEB_API_KEY:");
		},
	);

	helmIt(
		"renders explicit API keys and immutable digest image references",
		() => {
			const result = renderChart([
				"--set",
				"auth.apiKey=provided-key",
				"--set",
				"image.digest=sha256:0123456789abcdef",
			]);

			expect(result.status).toBe(0);
			expect(result.stdout).toContain('MAESTRO_WEB_API_KEY: "provided-key"');
			expect(result.stdout).toContain(
				'image: "ghcr.io/evalops/maestro@sha256:0123456789abcdef"',
			);
		},
	);

	helmIt("can render an HPA without a fixed deployment replica count", () => {
		const result = renderChart([
			"--set",
			"autoscaling.enabled=true",
			"--set",
			"headlessRuntime.routing.mode=sticky-session",
			"--set",
			"autoscaling.maxReplicas=4",
		]);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("kind: HorizontalPodAutoscaler");
		expect(result.stdout).toMatch(/maxReplicas:\s+4/);
		expect(result.stdout).not.toMatch(/replicas:\s+1/);
	});

	helmIt("rejects multi-replica process-local headless routing", () => {
		const result = renderChart(["--set", "replicaCount=2"]);

		expect(result.status).not.toBe(0);
		expect(`${result.stderr}\n${result.stdout}`).toContain(
			"replicaCount or autoscaling.maxReplicas > 1 requires headlessRuntime.routing.mode",
		);
	});

	helmIt(
		"rejects autoscaling above one replica without routed ownership",
		() => {
			const result = renderChart(["--set", "autoscaling.enabled=true"]);

			expect(result.status).not.toBe(0);
			expect(`${result.stderr}\n${result.stdout}`).toContain(
				"replicaCount or autoscaling.maxReplicas > 1 requires headlessRuntime.routing.mode",
			);
		},
	);

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
