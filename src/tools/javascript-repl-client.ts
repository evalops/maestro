import { Type } from "@sinclair/typebox";
import type { AgentTool } from "../agent/types.js";

const javascriptReplParamsSchema = Type.Object({
	code: Type.String({
		description:
			"JavaScript code to execute. It runs inside an async function, so you can use await.",
	}),
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				"Optional timeout (ms). If exceeded, the execution fails. Default: 10000.",
		}),
	),
});

export const javascriptReplClientTool: AgentTool<
	typeof javascriptReplParamsSchema,
	undefined
> = {
	name: "javascript_repl",
	label: "JavaScript REPL",
	description: `Execute JavaScript in a sandboxed browser runtime (client-side).

Notes:
- Code runs inside an async function, so top-level await is allowed.
- console.log/warn/error/info are captured and returned.

Artifacts interop (from inside the sandbox):
- listArtifacts() -> string[]
- getArtifact(filename) -> string | object (auto-parses *.json)
- createOrUpdateArtifact(filename, content) -> persist an artifact (JSON auto-stringified)
- deleteArtifact(filename) -> delete an artifact
- returnDownloadableFile(filename, content, mimeType?) -> prompt a browser download

Best practice:
- Use this tool for data processing (CSV/JSON transforms, quick scripts).
- Use the 'artifacts' tool to author user-facing HTML/MD files.`,
	parameters: javascriptReplParamsSchema,
	executionLocation: "client",
	execute: () => {
		throw new Error("javascript_repl tool must be executed on the client");
	},
};
