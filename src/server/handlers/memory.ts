import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import {
	type MemoryStore,
	addMemory,
	clearAllMemories,
	deleteMemory,
	deleteTopicMemories,
	ensureTeamMemoryEntrypoint,
	exportMemories,
	getRecentMemories,
	getStats,
	getTeamMemoryStatus,
	getTopicMemories,
	importMemories,
	listTopics,
	searchMemories,
} from "../../memory/index.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

export async function handleMemory(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		const url = new URL(
			req.url || "/api/memory",
			`http://${req.headers.host || "localhost"}`,
		);
		const action = url.searchParams.get("action") || "list";
		const topic = url.searchParams.get("topic");
		const query = url.searchParams.get("query");
		const limit = url.searchParams.get("limit");
		const sessionId = url.searchParams.get("sessionId") || undefined;

		try {
			if (action === "list") {
				if (topic) {
					const memories = getTopicMemories(topic, { sessionId });
					sendJson(res, 200, { topic, memories }, corsHeaders);
				} else {
					const topics = listTopics({ sessionId });
					sendJson(res, 200, { topics }, corsHeaders);
				}
			} else if (action === "search" && query) {
				const results = searchMemories(query, {
					sessionId,
					limit: limit ? Number.parseInt(limit, 10) : 10,
				});
				sendJson(res, 200, { query, results }, corsHeaders);
			} else if (action === "recent") {
				const memories = getRecentMemories(
					limit ? Number.parseInt(limit, 10) : 10,
					{ sessionId },
				);
				sendJson(res, 200, { memories }, corsHeaders);
			} else if (action === "stats") {
				const stats = getStats({ sessionId });
				sendJson(res, 200, { stats }, corsHeaders);
			} else if (action === "team") {
				const status = getTeamMemoryStatus(process.cwd());
				sendJson(
					res,
					200,
					{
						available: status !== null,
						status,
					},
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					400,
					{
						error: "Invalid action. Use list, search, recent, stats, or team.",
					},
					corsHeaders,
				);
			}
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	if (req.method === "POST") {
		try {
			const data = await readJsonBody<{
				action: string;
				topic?: string;
				content?: string;
				tags?: string[];
				sessionId?: string;
				id?: string;
				path?: string;
				force?: boolean;
			}>(req);
			const { action } = data;

			if (action === "save") {
				if (!data.topic || !data.content) {
					sendJson(
						res,
						400,
						{ error: "Topic and content are required" },
						corsHeaders,
					);
					return;
				}
				const entry = addMemory(data.topic, data.content, {
					tags: data.tags,
					sessionId: data.sessionId,
					cwd: process.cwd(),
				});
				sendJson(
					res,
					200,
					{
						success: true,
						message: `Memory saved to topic "${data.topic}"`,
						entry,
					},
					corsHeaders,
				);
			} else if (action === "delete") {
				if (!data.id && !data.topic) {
					sendJson(res, 400, { error: "ID or topic is required" }, corsHeaders);
					return;
				}
				if (data.id) {
					const deleted = deleteMemory(data.id);
					if (deleted) {
						sendJson(
							res,
							200,
							{ success: true, message: `Memory ${data.id} deleted` },
							corsHeaders,
						);
					} else {
						sendJson(
							res,
							404,
							{ error: `Memory ${data.id} not found` },
							corsHeaders,
						);
					}
				} else if (data.topic) {
					const count = deleteTopicMemories(data.topic);
					sendJson(
						res,
						200,
						{
							success: true,
							message: `Deleted ${count} memories from topic "${data.topic}"`,
							count,
						},
						corsHeaders,
					);
				}
			} else if (action === "export") {
				const store = exportMemories();
				const outputPath = data.path
					? resolve(process.cwd(), data.path)
					: resolve(process.cwd(), "maestro-memories.json");
				writeFileSync(outputPath, JSON.stringify(store, null, 2), "utf-8");
				sendJson(
					res,
					200,
					{
						success: true,
						message: `Exported ${store.entries.length} memories`,
						path: outputPath,
					},
					corsHeaders,
				);
			} else if (action === "import") {
				if (!data.path) {
					sendJson(res, 400, { error: "Path is required" }, corsHeaders);
					return;
				}
				const inputPath = resolve(process.cwd(), data.path);
				if (!existsSync(inputPath)) {
					sendJson(
						res,
						404,
						{ error: `File not found: ${inputPath}` },
						corsHeaders,
					);
					return;
				}
				const content = readFileSync(inputPath, "utf-8");
				let store: MemoryStore;
				try {
					store = JSON.parse(content) as MemoryStore;
				} catch {
					sendJson(
						res,
						400,
						{ error: `Invalid JSON in file: ${inputPath}` },
						corsHeaders,
					);
					return;
				}
				const result = importMemories(store);
				sendJson(
					res,
					200,
					{
						success: true,
						message: `Imported: ${result.added} added, ${result.updated} updated, ${result.skipped} skipped`,
						result,
					},
					corsHeaders,
				);
			} else if (action === "clear") {
				if (!data.force) {
					sendJson(
						res,
						400,
						{
							error:
								"This will delete ALL memories. Set force=true to confirm.",
						},
						corsHeaders,
					);
					return;
				}
				const count = clearAllMemories();
				sendJson(
					res,
					200,
					{
						success: true,
						message: `Cleared ${count} memories`,
						count,
					},
					corsHeaders,
				);
			} else if (action === "team-init") {
				const status = ensureTeamMemoryEntrypoint(process.cwd());
				if (!status) {
					sendJson(
						res,
						400,
						{ error: "Team memory is only available inside a git repository." },
						corsHeaders,
					);
					return;
				}
				sendJson(
					res,
					200,
					{
						success: true,
						message: `Team memory ready at ${status.entrypoint}`,
						status: getTeamMemoryStatus(process.cwd()) ?? {
							...status,
							exists: true,
							fileCount: 1,
							files: ["MEMORY.md"],
						},
					},
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					400,
					{
						error:
							"Invalid action. Use save, delete, export, import, clear, or team-init.",
					},
					corsHeaders,
				);
			}
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
}
