/**
 * OpenTelemetry command handler.
 *
 * Usage:
 *   /otel - Show OpenTelemetry status
 */

import { getOpenTelemetryStatus } from "../../opentelemetry.js";

export interface OtelCommandDeps {
	showInfo: (message: string) => void;
}

export function handleOtelCommand(deps: OtelCommandDeps): void {
	const status = getOpenTelemetryStatus();
	const lines = [
		`OpenTelemetry: ${status.enabled ? "enabled" : "disabled"} (${status.reason})`,
		`Service: ${status.serviceName}`,
		`SDK started: ${status.sdkStarted ? "yes" : "no"}`,
		`OTLP endpoint: ${status.otlpEndpoint ?? "none"}`,
		`Exporters: traces=${status.tracesExporter}, metrics=${status.metricsExporter}, logs=${status.logsExporter}`,
		`Auto-instrumentation: ${status.autoInstrumentation ? "enabled (http/undici/fs/db)" : "disabled"}`,
	];
	deps.showInfo(lines.join("\n"));
}
