import { describe, expect, it } from "vitest";
import {
	applyArtifactsCommand,
	createEmptyArtifactsState,
	reconstructArtifactsFromMessages,
} from "./artifacts.js";

describe("artifact command state", () => {
	it("rejects unknown artifact commands without mutating state", () => {
		const state = createEmptyArtifactsState();

		const result = applyArtifactsCommand(state, {
			command: "publish" as never,
			filename: "report.txt",
			content: "hello",
		});

		expect(result).toMatchObject({
			state,
			isError: true,
			output: expect.stringContaining("unknown command"),
		});
		expect(state.byFilename.size).toBe(0);
	});

	it("rejects path traversal artifact filenames", () => {
		const state = createEmptyArtifactsState();

		const result = applyArtifactsCommand(state, {
			command: "create",
			filename: "../secret.txt",
			content: "nope",
		});

		expect(result.isError).toBe(true);
		expect(result.output).toContain("invalid filename");
		expect(result.state.byFilename.size).toBe(0);
	});

	it("rejects nested artifact filenames", () => {
		const state = createEmptyArtifactsState();

		const result = applyArtifactsCommand(state, {
			command: "create",
			filename: "reports/summary.txt",
			content: "nope",
		});

		expect(result.isError).toBe(true);
		expect(result.output).toContain("invalid filename");
		expect(result.state.byFilename.size).toBe(0);
	});

	it("rejects Windows-path artifact filenames", () => {
		const state = createEmptyArtifactsState();

		const result = applyArtifactsCommand(state, {
			command: "create",
			filename: "reports\\summary.txt",
			content: "nope",
		});

		expect(result.isError).toBe(true);
		expect(result.output).toContain("invalid filename");
		expect(result.state.byFilename.size).toBe(0);
	});

	it("rejects control-character artifact filenames", () => {
		const state = createEmptyArtifactsState();

		const result = applyArtifactsCommand(state, {
			command: "create",
			filename: "report\nsummary.txt",
			content: "nope",
		});

		expect(result.isError).toBe(true);
		expect(result.output).toContain("invalid filename");
		expect(result.state.byFilename.size).toBe(0);
	});

	it("rejects artifact updates with an empty old_str", () => {
		const created = applyArtifactsCommand(createEmptyArtifactsState(), {
			command: "create",
			filename: "report.txt",
			content: "alpha",
		});

		const result = applyArtifactsCommand(created.state, {
			command: "update",
			filename: "report.txt",
			old_str: "",
			new_str: "prefix",
		});

		expect(result.isError).toBe(true);
		expect(result.output).toContain("old_str");
		expect(result.state.byFilename.get("report.txt")?.content).toBe("alpha");
	});

	it("rejects log requests for missing artifacts", () => {
		const state = createEmptyArtifactsState();

		const result = applyArtifactsCommand(state, {
			command: "logs",
			filename: "missing.html",
		});

		expect(result).toMatchObject({
			state,
			isError: true,
			output: expect.stringContaining("not found"),
		});
	});

	it("does not reconstruct persisted unsafe artifact filenames", () => {
		const state = reconstructArtifactsFromMessages([
			{
				role: "assistant",
				content: "",
				tools: [
					{
						name: "artifacts",
						status: "completed",
						args: {
							command: "create",
							filename: "../secret.txt",
							content: "hidden",
						},
						result: { ok: true },
					},
					{
						name: "artifacts",
						status: "completed",
						args: {
							command: "create",
							filename: "report.txt",
							content: "visible",
						},
						result: { ok: true },
					},
				],
			},
		]);

		expect([...state.byFilename.keys()]).toEqual(["report.txt"]);
	});
});
