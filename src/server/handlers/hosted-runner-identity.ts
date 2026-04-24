import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostedRunnerContext } from "../app-context.js";
import { sendJson } from "../server-utils.js";
import { checkHostedRunnerReadiness } from "./health.js";

export const HOSTED_RUNNER_IDENTITY_PATH =
	"/.well-known/evalops/remote-runner/identity";

export const HOSTED_RUNNER_IDENTITY_PROTOCOL_VERSION =
	"evalops.remote-runner.identity.v1";

export interface HostedRunnerIdentity {
	protocol_version: typeof HOSTED_RUNNER_IDENTITY_PROTOCOL_VERSION;
	runner_session_id: string;
	owner_instance_id: string;
	ready: boolean;
	draining: boolean;
	drain_status?: string;
	drain_manifest_path?: string;
	drained_at?: string;
}

export async function buildHostedRunnerIdentity(
	hostedRunner?: HostedRunnerContext,
): Promise<HostedRunnerIdentity | null> {
	if (!hostedRunner?.runnerSessionId || !hostedRunner.ownerInstanceId) {
		return null;
	}

	const readiness = await checkHostedRunnerReadiness(hostedRunner);
	const draining = readiness.status === "draining";

	return {
		protocol_version: HOSTED_RUNNER_IDENTITY_PROTOCOL_VERSION,
		runner_session_id: hostedRunner.runnerSessionId,
		owner_instance_id: hostedRunner.ownerInstanceId,
		ready: readiness.status === "ready",
		draining,
		...(hostedRunner.lastDrain?.status
			? { drain_status: hostedRunner.lastDrain.status }
			: {}),
		...(hostedRunner.lastDrain?.manifestPath
			? { drain_manifest_path: hostedRunner.lastDrain.manifestPath }
			: {}),
		...(hostedRunner.lastDrain?.drainedAt
			? { drained_at: hostedRunner.lastDrain.drainedAt }
			: {}),
	};
}

export async function handleHostedRunnerIdentity(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	hostedRunner?: HostedRunnerContext,
): Promise<void> {
	res.setHeader("Cache-Control", "no-store");
	const identity = await buildHostedRunnerIdentity(hostedRunner);
	if (!identity) {
		sendJson(
			res,
			404,
			{
				error: "hosted runner identity unavailable",
			},
			cors,
			req,
		);
		return;
	}

	sendJson(res, 200, identity, cors, req);
}
