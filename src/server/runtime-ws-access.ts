import type { IncomingMessage } from "node:http";

type RuntimeWebSocketAccessValidator = (
	req: IncomingMessage,
	sessionId: string,
) => boolean | Promise<boolean>;

interface RuntimeWebSocketUpgradeSocket {
	write(payload: string): unknown;
	destroy(): unknown;
}

interface RuntimeWebSocketSessionAuthorizationOptions {
	req: IncomingMessage;
	socket: RuntimeWebSocketUpgradeSocket;
	requestedSessionId: string | null;
	validateSessionAccess: RuntimeWebSocketAccessValidator;
	logAccessError?: (error: Error) => void;
}

function rejectUpgrade(
	socket: RuntimeWebSocketUpgradeSocket,
	statusLine: string,
): null {
	socket.write(`${statusLine}\r\n\r\n`);
	socket.destroy();
	return null;
}

export async function authorizeRuntimeWebSocketSession({
	req,
	socket,
	requestedSessionId,
	validateSessionAccess,
	logAccessError,
}: RuntimeWebSocketSessionAuthorizationOptions): Promise<
	string | null | undefined
> {
	if (!requestedSessionId) {
		return undefined;
	}
	try {
		if (await validateSessionAccess(req, requestedSessionId)) {
			return requestedSessionId;
		}
		return rejectUpgrade(socket, "HTTP/1.1 403 Forbidden");
	} catch (error) {
		logAccessError?.(error instanceof Error ? error : new Error(String(error)));
		return rejectUpgrade(socket, "HTTP/1.1 500 Internal Server Error");
	}
}
