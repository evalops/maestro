import type { ToolCapabilitySummary } from "../agent/tool-capability-types.js";
import { emitBeacon } from "./beacon.js";

type McpBeaconTransport = "stdio" | "http" | "sse";

interface McpBeaconBase {
	serverName: string;
	transport: McpBeaconTransport;
	remoteHost?: string;
	clientVersion?: string;
}

export interface McpConnectionBeacon extends McpBeaconBase {
	toolCount: number;
	resourceCount: number;
	promptCount: number;
	isReconnect?: boolean;
	toolCapabilitySummary?: ToolCapabilitySummary;
}

export interface McpToolUsageBeacon extends McpBeaconBase {
	toolName: string;
}

export function emitMcpConnectionBeacon(
	beacon: McpConnectionBeacon,
): Promise<boolean> {
	return emitBeacon({
		feature: "mcp.connection",
		action: mcpTransportAction(beacon.transport, "Connected"),
		timestamp: Date.now() * 1000,
		source: {
			client: "cli",
			clientVersion: clientVersion(beacon.clientVersion),
			surface: "mcp",
		},
		parameters: {
			metadata: compactMetadata({
				serverName: beacon.serverName,
				transport: beacon.transport,
				remoteHost: beacon.remoteHost,
				toolCount: beacon.toolCount,
				resourceCount: beacon.resourceCount,
				promptCount: beacon.promptCount,
				reconnect: beacon.isReconnect === true,
				...compactCapabilityMetadata(beacon.toolCapabilitySummary),
			}),
		},
	});
}

export function emitMcpToolUsageBeacon(
	beacon: McpToolUsageBeacon,
): Promise<boolean> {
	return emitBeacon({
		feature: "mcp.toolUsage",
		action: mcpTransportAction(beacon.transport, "ToolCalled"),
		timestamp: Date.now() * 1000,
		source: {
			client: "cli",
			clientVersion: clientVersion(beacon.clientVersion),
			surface: "mcp",
		},
		parameters: {
			metadata: compactMetadata({
				serverName: beacon.serverName,
				transport: beacon.transport,
				remoteHost: beacon.remoteHost,
				toolName: beacon.toolName,
			}),
		},
	});
}

function mcpTransportAction(
	transport: McpBeaconTransport,
	suffix: "Connected" | "ToolCalled",
): string {
	return `${transport === "stdio" ? "local" : "remote"}${suffix}`;
}

function clientVersion(value: string | undefined): string {
	return value ?? process.env.MAESTRO_VERSION ?? "unknown";
}

function compactMetadata(
	metadata: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(metadata).filter(([, value]) => value !== undefined),
	);
}

function compactCapabilityMetadata(
	summary: ToolCapabilitySummary | undefined,
): Record<string, number> {
	if (!summary) {
		return {};
	}
	return {
		desktopToolCount: summary.byDomain.desktop,
		fileToolCount: summary.byDomain.file,
		desktopActionToolCount: summary.byToolLane.desktop_action,
		fileEditToolCount: summary.byToolLane.file_edit,
		highRiskToolCount: summary.byRiskClass.high,
		receiptBackedToolCount: summary.requiresReceipt,
		rawSecretPossibleToolCount: summary.rawSecretPossible,
	};
}
