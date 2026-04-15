import { Type } from "@sinclair/typebox";
import type { AgentTool } from "../agent/types.js";

const artifactsParamsSchema = Type.Object({
	command: Type.Union(
		[
			Type.Literal("create"),
			Type.Literal("update"),
			Type.Literal("rewrite"),
			Type.Literal("get"),
			Type.Literal("delete"),
			Type.Literal("logs"),
		],
		{ description: "Artifact operation to perform" },
	),
	filename: Type.String({
		description:
			"Artifact filename including extension (e.g. 'index.html', 'notes.md', 'data.json')",
	}),
	content: Type.Optional(Type.String({ description: "Full file content" })),
	old_str: Type.Optional(
		Type.String({ description: "String to replace (update only)" }),
	),
	new_str: Type.Optional(
		Type.String({ description: "Replacement string (update only)" }),
	),
});

export const artifactsClientTool: AgentTool<
	typeof artifactsParamsSchema,
	undefined
> = {
	name: "artifacts",
	label: "Artifacts",
	description: `Create and manage persistent session artifacts (HTML, Markdown, JSON, etc.).

Use this tool to:
- create: create a new artifact file
- update: replace a small section via old_str/new_str (preferred)
- rewrite: replace the entire file (last resort)
- get: retrieve a file
- delete: delete a file
- logs: fetch console logs for HTML artifacts (if available)

HTML artifacts runtime:
- You can call listArtifacts() and getArtifact(filename) from within an .html artifact to read other artifacts (e.g. load data.json).

Notes:
- Prefer update over rewrite to minimize tokens.
- HTML artifacts should be self-contained and use CDN imports if needed.`,
	parameters: artifactsParamsSchema,
	executionLocation: "client",
	// This should never run on the server: the backend transport will request
	// execution from the web client via clientToolService.
	execute: () => {
		throw new Error("artifacts tool must be executed on the client");
	},
};
