import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApprovalMode } from "../../agent/action-approval.js";
import { readJsonBody, sendJson } from "../server-utils.js";

// Store approval mode preference (per-session or global)
// In a real implementation, this might be stored per-user or per-session
const approvalModeStore = new Map<string, ApprovalMode>();

export async function handleApprovals(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		// Get current approval mode preference
		// For now, return default - in production this would be per-user/session
		const url = new URL(
			req.url || "/api/approvals",
			`http://${req.headers.host}`,
		);
		const sessionId = url.searchParams.get("sessionId") || "default";
		const mode = approvalModeStore.get(sessionId) || "prompt";

		sendJson(
			res,
			200,
			{
				mode,
				availableModes: ["auto", "prompt", "fail"],
			},
			corsHeaders,
		);
		return;
	}

	if (req.method === "POST") {
		try {
			const data = await readJsonBody<{
				mode?: string;
				sessionId?: string;
			}>(req);

			const mode = data.mode;
			if (!mode || !["auto", "prompt", "fail"].includes(mode)) {
				sendJson(
					res,
					400,
					{ error: 'Mode must be one of "auto", "prompt", or "fail"' },
					corsHeaders,
				);
				return;
			}

			const sessionId = data.sessionId || "default";
			approvalModeStore.set(sessionId, mode as ApprovalMode);

			sendJson(
				res,
				200,
				{
					success: true,
					mode: mode as ApprovalMode,
					message: `Approval mode set to ${mode}`,
				},
				corsHeaders,
			);
		} catch (error) {
			if (error instanceof Error && "statusCode" in error) {
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
						error: "Failed to update approval mode",
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
