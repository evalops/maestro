import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const chartRoot = join(process.cwd(), "deploy", "helm", "maestro");

describe("Maestro Helm chart", () => {
	it("keeps in-process headless runtime routing single-replica by default", async () => {
		const values = yaml.load(
			await readFile(join(chartRoot, "values.yaml"), "utf8"),
		) as {
			replicaCount?: number;
			headlessRuntimeRouting?: { mode?: string };
		};
		const helpers = await readFile(
			join(chartRoot, "templates", "_helpers.tpl"),
			"utf8",
		);
		const deployment = await readFile(
			join(chartRoot, "templates", "deployment.yaml"),
			"utf8",
		);

		expect(values.replicaCount).toBe(1);
		expect(values.headlessRuntimeRouting?.mode).toBe("inProcess");
		expect(helpers).toContain(
			'define "maestro.validateHeadlessRuntimeRouting"',
		);
		expect(deployment).toContain(
			'include "maestro.validateHeadlessRuntimeRouting" .',
		);
	});
});
