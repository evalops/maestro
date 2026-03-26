import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { WebServerContext } from "../app-context.js";
import { sendJson } from "../server-utils.js";

const packageJson = createRequire(import.meta.url)("../../../package.json") as {
	version?: string;
};

const VERSION = process.env.MAESTRO_VERSION ?? packageJson.version ?? "unknown";
const CLIENT_HEADERS = [
	"X-Composer-Client",
	"X-Composer-Client-Tools",
	"X-Composer-Approval-Mode",
	"X-Composer-Slim-Events",
];

export function handleBridgeStatus(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
): void {
	sendJson(
		res,
		200,
		{
			version: VERSION,
			serverTime: new Date().toISOString(),
			defaults: {
				approvalMode: context.defaultApprovalMode,
				provider: context.defaultProvider,
				modelId: context.defaultModelId,
			},
			clientTools: {
				enabled: true,
				clients: ["conductor", "vscode", "jetbrains"],
				headers: CLIENT_HEADERS,
			},
			approvalModes: ["auto", "prompt", "fail"],
		},
		context.corsHeaders,
		req,
	);
}
