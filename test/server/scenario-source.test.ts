import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	readScenarioJsonSource,
	scenarioSourceBaseDir,
	scenarioSourceLabel,
} from "../../src/agent/scenario-source.js";

let tempDir: string | undefined;
let server: Server | undefined;

async function serveJson(value: unknown): Promise<string> {
	server = createServer((_, response) => {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify(value));
	});
	await new Promise<void>((resolvePromise) => {
		server?.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}/scenario.json`;
}

describe("scenario source loader", () => {
	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolvePromise, reject) => {
				server?.close((error) => (error ? reject(error) : resolvePromise()));
			});
			server = undefined;
		}
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("reads local scenario JSON and resolves its base directory", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "maestro-scenario-source-"));
		const scenarioPath = join(tempDir, "scenario.json");
		writeFileSync(scenarioPath, JSON.stringify({ id: "local-scenario" }));

		await expect(readScenarioJsonSource(scenarioPath)).resolves.toEqual({
			id: "local-scenario",
		});
		expect(scenarioSourceBaseDir(scenarioPath)).toBe(dirname(scenarioPath));
	});

	it("reads HTTP scenario JSON for signed URL replay", async () => {
		const url = await serveJson({ id: "signed-url-scenario" });

		await expect(readScenarioJsonSource(url)).resolves.toEqual({
			id: "signed-url-scenario",
		});
		expect(scenarioSourceBaseDir(url)).toBe(process.cwd());
	});

	it("redacts signed URL query strings in source labels", () => {
		expect(
			scenarioSourceLabel(
				"https://storage.googleapis.com/bucket/scenario.json?X-Goog-Signature=secret",
			),
		).toBe("https://storage.googleapis.com/bucket/scenario.json");
	});

	it("redacts signed URL query strings from HTTP load failures", async () => {
		const source =
			"https://storage.googleapis.com/bucket/scenario.json?X-Goog-Signature=secret";

		await expect(
			readScenarioJsonSource(source, {
				fetch: async () =>
					new Response("forbidden", { status: 403, statusText: "Forbidden" }),
			}),
		).rejects.toThrow(
			"Failed to read scenario https://storage.googleapis.com/bucket/scenario.json: HTTP 403 Forbidden",
		);
	});

	it("reads GCS scenario JSON through gcloud storage cat", async () => {
		const calls: Array<{ file: string; args: string[] }> = [];

		await expect(
			readScenarioJsonSource("gs://bucket/path/to/scenario.json", {
				execFile: async (file, args) => {
					calls.push({ file, args });
					return {
						stdout: JSON.stringify({ id: "gcs-scenario" }),
						stderr: "",
					};
				},
			}),
		).resolves.toEqual({ id: "gcs-scenario" });

		expect(calls).toEqual([
			{
				file: "gcloud",
				args: ["storage", "cat", "gs://bucket/path/to/scenario.json"],
			},
		]);
		expect(scenarioSourceBaseDir("gs://bucket/path/to/scenario.json")).toBe(
			process.cwd(),
		);
	});

	it("rejects GCS bucket URIs without an object path", async () => {
		const execFile = vi.fn();

		await expect(
			readScenarioJsonSource("gs://bucket", {
				execFile,
			}),
		).rejects.toThrow(
			"GCS scenario source must include a bucket and object path: gs://bucket",
		);
		expect(execFile).not.toHaveBeenCalled();
	});
});
