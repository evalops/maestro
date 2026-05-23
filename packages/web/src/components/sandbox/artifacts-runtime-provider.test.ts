import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactsRuntimeProvider } from "./artifacts-runtime-provider.js";

type ArtifactWindow = Window &
	typeof globalThis & {
		artifacts?: Record<string, string>;
		getArtifact?: (filename: string) => Promise<unknown>;
		listArtifacts?: () => Promise<string[]>;
		createOrUpdateArtifact?: (
			filename: string,
			content: unknown,
		) => Promise<void>;
		deleteArtifact?: (filename: string) => Promise<void>;
	};

describe("ArtifactsRuntimeProvider", () => {
	afterEach(() => {
		const w = window as ArtifactWindow;
		delete w.artifacts;
		delete w.getArtifact;
		delete w.listArtifacts;
		delete w.createOrUpdateArtifact;
		delete w.deleteArtifact;
	});

	it("parses offline JSON artifacts case-insensitively", async () => {
		const w = window as ArtifactWindow;
		w.artifacts = { "DATA.JSON": '{"ok":true}' };

		new ArtifactsRuntimeProvider(() => []).getRuntime()("sandbox-1");

		await expect(w.getArtifact?.("DATA.JSON")).resolves.toEqual({ ok: true });
	});

	it("responds with an error for unsupported artifact operations", async () => {
		const provider = new ArtifactsRuntimeProvider(() => []);
		const responses: unknown[] = [];

		await provider.handleMessage(
			{ type: "artifact-operation", action: "rename" },
			(response) => responses.push(response),
		);

		expect(responses).toEqual([
			{ success: false, error: expect.stringContaining("Unsupported") },
		]);
	});

	it("rejects createOrUpdate messages without a filename", async () => {
		const createOrUpdate = vi.fn();
		const provider = new ArtifactsRuntimeProvider(() => [], { createOrUpdate });
		const responses: unknown[] = [];

		await provider.handleMessage(
			{ type: "artifact-operation", action: "createOrUpdate", content: "body" },
			(response) => responses.push(response),
		);

		expect(createOrUpdate).not.toHaveBeenCalled();
		expect(responses).toEqual([
			{ success: false, error: expect.stringContaining("filename") },
		]);
	});

	it("rejects delete messages without a filename", async () => {
		const deleteArtifact = vi.fn();
		const provider = new ArtifactsRuntimeProvider(() => [], {
			delete: deleteArtifact,
		});
		const responses: unknown[] = [];

		await provider.handleMessage(
			{ type: "artifact-operation", action: "delete" },
			(response) => responses.push(response),
		);

		expect(deleteArtifact).not.toHaveBeenCalled();
		expect(responses).toEqual([
			{ success: false, error: expect.stringContaining("filename") },
		]);
	});
});
