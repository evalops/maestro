import type { IncomingMessage, ServerResponse } from "node:http";
import { getCheckpointService } from "../../checkpoints/index.js";
import { getChangeTracker } from "../../undo/index.js";
import { sendJson } from "../server-utils.js";
import {
	type UndoRequestInput,
	UndoRequestSchema,
	parseAndValidateJson,
} from "../validation.js";

export async function handleUndo(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		// GET /api/undo?action=status|history
		const url = new URL(req.url || "/api/undo", `http://${req.headers.host}`);
		const action = url.searchParams.get("action") || "status";

		if (action === "status") {
			const tracker = getChangeTracker();
			const stats = tracker.getStats();
			const checkpointSvc = getCheckpointService();
			const canUndo = checkpointSvc?.canUndo() ?? false;

			sendJson(
				res,
				200,
				{
					totalChanges: stats.totalChanges,
					canUndo,
					checkpoints: tracker.getCheckpoints().map((cp) => ({
						name: cp.name,
						description: cp.description,
						changeCount: cp.changeCount,
						timestamp: cp.timestamp,
					})),
				},
				corsHeaders,
			);
			return;
		}

		if (action === "history") {
			const checkpointSvc = getCheckpointService();
			if (!checkpointSvc) {
				sendJson(res, 200, { history: [] }, corsHeaders);
				return;
			}
			const history = checkpointSvc.getHistory();
			sendJson(
				res,
				200,
				{
					history: history.map((h) => ({
						description: h.description,
						fileCount: h.fileCount,
						timestamp: h.timestamp,
					})),
				},
				corsHeaders,
			);
			return;
		}

		sendJson(res, 400, { error: "Invalid action" }, corsHeaders);
		return;
	}

	if (req.method === "POST") {
		try {
			const data = await parseAndValidateJson<UndoRequestInput>(
				req,
				UndoRequestSchema,
			);

			const action = data.action || "undo";

			if (action === "undo") {
				const tracker = getChangeTracker();
				const stats = tracker.getStats();
				const count = data.count ?? 1;

				if (stats.totalChanges === 0) {
					const checkpointSvc = getCheckpointService();
					if (checkpointSvc?.canUndo()) {
						if (data.preview) {
							const history = checkpointSvc.getHistory();
							const lastCheckpoint = history.at(-1);
							if (!lastCheckpoint) {
								sendJson(
									res,
									200,
									{ preview: { message: "No checkpoints available to undo." } },
									corsHeaders,
								);
							} else {
								sendJson(
									res,
									200,
									{
										preview: {
											message: `Would restore ${lastCheckpoint.fileCount} file${lastCheckpoint.fileCount === 1 ? "" : "s"} to state before "${lastCheckpoint.description}"`,
											fileCount: lastCheckpoint.fileCount,
											description: lastCheckpoint.description,
										},
									},
									corsHeaders,
								);
							}
						} else {
							const result = checkpointSvc.undo();
							if (result.success) {
								const restored = result.files?.length ?? 0;
								sendJson(
									res,
									200,
									{
										success: true,
										message: `Restored ${restored} file${restored === 1 ? "" : "s"} from last checkpoint.`,
										files: result.files,
									},
									corsHeaders,
								);
							} else {
								sendJson(res, 400, { error: result.message }, corsHeaders);
							}
						}
					} else {
						sendJson(
							res,
							200,
							{
								message:
									"No changes to undo. File changes are tracked during this session.",
							},
							corsHeaders,
						);
					}
					return;
				}

				if (data.preview) {
					const preview = tracker.previewUndo(count);
					sendJson(res, 200, { preview }, corsHeaders);
				} else {
					const result = tracker.undo(count, data.force);
					if (result.errors.length > 0 && result.undone === 0) {
						sendJson(
							res,
							400,
							{ error: result.errors.join("\n") },
							corsHeaders,
						);
					} else {
						sendJson(
							res,
							200,
							{
								success: true,
								undone: result.undone,
								errors: result.errors,
							},
							corsHeaders,
						);
					}
				}
				return;
			}

			if (action === "checkpoint") {
				const tracker = getChangeTracker();
				const subaction = data.name ? "save" : "list";

				if (subaction === "save") {
					if (!data.name) {
						sendJson(
							res,
							400,
							{ error: "name is required for checkpoint save" },
							corsHeaders,
						);
						return;
					}
					const checkpoint = tracker.createCheckpoint(
						data.name,
						data.description,
					);
					sendJson(
						res,
						200,
						{
							success: true,
							checkpoint: {
								name: checkpoint.name,
								changeCount: checkpoint.changeCount,
								timestamp: checkpoint.timestamp,
							},
						},
						corsHeaders,
					);
					return;
				}

				if (subaction === "list") {
					const checkpoints = tracker.getCheckpoints();
					sendJson(
						res,
						200,
						{
							checkpoints: checkpoints.map((cp) => ({
								name: cp.name,
								description: cp.description,
								changeCount: cp.changeCount,
								timestamp: cp.timestamp,
							})),
						},
						corsHeaders,
					);
					return;
				}
			}

			if (action === "restore") {
				if (!data.name) {
					sendJson(
						res,
						400,
						{ error: "name is required for checkpoint restore" },
						corsHeaders,
					);
					return;
				}
				const tracker = getChangeTracker();
				const result = tracker.restoreCheckpoint(
					data.name,
					data.force ?? false,
				);
				if (result.errors.length > 0 && result.undone === 0) {
					sendJson(res, 400, { error: result.errors.join("\n") }, corsHeaders);
				} else {
					sendJson(
						res,
						200,
						{
							success: true,
							undone: result.undone,
							errors: result.errors,
						},
						corsHeaders,
					);
				}
				return;
			}

			sendJson(res, 400, { error: "Invalid action" }, corsHeaders);
		} catch (error) {
			if (error instanceof Error && "statusCode" in error) {
				// ApiError from parseAndValidateJson
				sendJson(
					res,
					(error as { statusCode: number }).statusCode,
					{ error: error.message },
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					500,
					{
						error: "Failed to process undo request",
						details: error instanceof Error ? error.message : String(error),
					},
					corsHeaders,
				);
			}
		}
		return;
	}

	sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
}

export async function handleChanges(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method !== "GET") {
		sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
		return;
	}

	const url = new URL(req.url || "/api/changes", `http://${req.headers.host}`);
	const filter = url.searchParams.get("filter") || "all"; // all, files, tools

	const tracker = getChangeTracker();
	const stats = tracker.getStats();
	const changes = tracker.getChanges();

	let filteredChanges = changes;
	if (filter === "files") {
		filteredChanges = changes.filter(
			(c) => c.type === "modify" || c.type === "create" || c.type === "delete",
		);
	} else if (filter === "tools") {
		filteredChanges = changes.filter((c) => c.toolCallId);
	}

	sendJson(
		res,
		200,
		{
			stats: {
				totalChanges: stats.totalChanges,
				checkpoints: stats.checkpoints,
				byTool: stats.byTool,
				byType: stats.byType,
			},
			changes: filteredChanges.map((c) => ({
				path: c.path,
				type: c.type,
				toolCallId: c.toolCallId,
				timestamp: c.timestamp,
			})),
		},
		corsHeaders,
	);
}
