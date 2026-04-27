#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import {
	MaestroBusEventType,
	closeMaestroEventBusTransport,
	publishMaestroCloudEventStrict,
	resolveMaestroEventBusConfig,
} from "../src/telemetry/maestro-event-bus.js";

const config = resolveMaestroEventBusConfig();
if (!config.natsUrl) {
	throw new Error(
		"Set MAESTRO_EVENT_BUS_URL or EVALOPS_NATS_URL before running the Maestro event bus smoke.",
	);
}

const now = new Date().toISOString();
const sessionId =
	process.env.MAESTRO_EVENT_BUS_SMOKE_SESSION_ID ??
	`maestro-event-bus-smoke-${Date.now()}`;
const eventId =
	process.env.MAESTRO_EVENT_BUS_SMOKE_EVENT_ID ??
	`maestro-event-bus-smoke-${randomUUID()}`;

try {
	await publishMaestroCloudEventStrict(
		MaestroBusEventType.SessionStarted,
		{
			correlation: {
				...config.defaultCorrelation,
				session_id: sessionId,
			},
			state: "MAESTRO_SESSION_STATE_STARTED",
			surface: config.defaultSurface,
			runtime_mode: config.defaultRuntimeMode,
			principal: config.defaultPrincipal,
			workspace_root: process.cwd(),
			started_at: now,
			metadata: {
				smoke: "event-bus",
				source: "scripts/smoke-maestro-event-bus.ts",
			},
		},
		{
			eventId,
			env: process.env,
			source: process.env.MAESTRO_EVENT_BUS_SOURCE ?? "maestro.smoke",
			time: now,
		},
	);
	console.log(
		`Published Maestro event bus smoke event ${eventId} to ${MaestroBusEventType.SessionStarted}`,
	);
} finally {
	await closeMaestroEventBusTransport();
}
