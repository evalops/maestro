import type { StagedRolloutSurfaceTelemetry } from "../telemetry.js";

export type StagedRolloutSurfaceUsageEvent =
	StagedRolloutSurfaceTelemetry["event"];

export type StagedRolloutSurfaceUsageOptions = {
	surfaceId: string;
	surfaceType: StagedRolloutSurfaceTelemetry["surfaceType"];
	owner?: string;
	source?: string;
	metadata?: Record<string, unknown>;
};

export async function recordStagedRolloutSurfaceUsageLazy(
	event: StagedRolloutSurfaceUsageEvent,
	options: StagedRolloutSurfaceUsageOptions,
): Promise<void> {
	const { recordStagedRolloutSurfaceUsage } = await import("../telemetry.js");
	await recordStagedRolloutSurfaceUsage(event, options);
}
