import {
	applyArtifactsCommand,
	artifactContentsByFilename,
	createEmptyArtifactsState,
	reconstructArtifactsFromMessages,
} from "@evalops/contracts";
import { describe, expect, it } from "vitest";

describe("shared artifact command contracts", () => {
	it("returns stable model-facing error codes", () => {
		const state = createEmptyArtifactsState();

		const result = applyArtifactsCommand(state, {
			command: "publish" as never,
			filename: "report.txt",
		});

		expect(result).toMatchObject({
			code: "artifact.command_unknown",
			isError: true,
			state,
		});
		expect(result.output).toContain("[artifact.command_unknown]");
	});

	it("replays transcripts and reports skipped mutation diagnostics", () => {
		const diagnostics: Array<{ code: string; filename?: string }> = [];

		const state = reconstructArtifactsFromMessages(
			[
				{
					role: "assistant",
					content: "",
					tools: [
						{
							name: "artifacts",
							status: "completed",
							args: {
								command: "create",
								filename: "report.txt",
								content: "alpha",
							},
							result: { ok: true },
						},
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
								command: "update",
								filename: "report.txt",
								old_str: "alpha",
								new_str: "bravo",
							},
							result: { ok: true },
						},
					],
				},
			],
			{
				onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
			},
		);

		expect(artifactContentsByFilename(state)).toEqual(
			new Map([["report.txt", "bravo"]]),
		);
		expect(diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "artifact.filename_invalid",
					filename: "../secret.txt",
				}),
			]),
		);
	});

	it("keeps filename validation strict and code-addressable", () => {
		for (const filename of [
			"",
			"../secret.txt",
			"nested/report.txt",
			"nested\\report.txt",
			"line\nbreak.txt",
		]) {
			const result = applyArtifactsCommand(createEmptyArtifactsState(), {
				command: "create",
				filename,
				content: "hidden",
			});

			expect(result).toMatchObject({
				code:
					filename.length === 0
						? "artifact.filename_missing"
						: "artifact.filename_invalid",
				isError: true,
				mutated: false,
			});
		}
	});
});
