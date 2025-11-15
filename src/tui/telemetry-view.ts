import {
	badge,
	heading,
	labeledValue,
	muted,
	separator,
} from "../style/theme.js";
import {
	getTelemetryStatus,
	setTelemetryRuntimeOverride,
} from "../telemetry.js";
import type { TelemetryStatus } from "../telemetry.js";
import type { Container, TUI } from "../tui-lib/index.js";
import { Spacer, Text } from "../tui-lib/index.js";

interface TelemetryViewOptions {
	chatContainer: Container;
	ui: TUI;
	showInfo: (message: string) => void;
	showError: (message: string) => void;
	onStatusChanged: (status: TelemetryStatus) => void;
}

export class TelemetryView {
	constructor(private readonly options: TelemetryViewOptions) {}

	handleTelemetryCommand(input: string): void {
		const [, ...rest] = input.trim().split(/\s+/);
		const arg = rest.join(" ").trim().toLowerCase();
		if (!arg || arg === "status") {
			this.renderStatus(getTelemetryStatus());
			return;
		}
		if (arg === "on" || arg === "enable") {
			setTelemetryRuntimeOverride(true, "enabled via /telemetry");
			this.handleStatusChange("Telemetry enabled for this session.");
			return;
		}
		if (arg === "off" || arg === "disable") {
			setTelemetryRuntimeOverride(false, "disabled via /telemetry");
			this.handleStatusChange("Telemetry disabled for this session.");
			return;
		}
		if (arg === "reset" || arg === "default") {
			setTelemetryRuntimeOverride(null, undefined);
			this.handleStatusChange("Telemetry settings reset to environment.");
			return;
		}
		this.options.showError("Usage: /telemetry [status|on|off|reset]");
	}

	private handleStatusChange(message: string): void {
		const status = getTelemetryStatus();
		this.options.onStatusChanged(status);
		this.options.showInfo(message);
		this.renderStatus(status);
	}

	private renderStatus(status: TelemetryStatus): void {
		const rows: string[] = [];
		rows.push(heading("Telemetry status"));
		rows.push(
			[
				badge(
					"state",
					status.enabled ? "enabled" : "disabled",
					status.enabled ? "success" : "warn",
				),
				badge("reason", status.reason),
			].join(separator()),
		);
		const route = status.endpoint
			? `Endpoint ${status.endpoint}`
			: status.filePath
				? `File ${status.filePath}`
				: "";
		if (route) {
			rows.push(muted(route));
		}
		rows.push(labeledValue("Sample rate", status.sampleRate.toString()));
		if (status.flagValue !== undefined) {
			rows.push(labeledValue("Flag", status.flagValue));
		}
		if (status.runtimeOverride) {
			const detail = status.overrideReason
				? `${status.runtimeOverride} (${status.overrideReason})`
				: status.runtimeOverride;
			rows.push(labeledValue("Override", detail));
		}
		rows.push(muted("Use /telemetry on, /telemetry off, or /telemetry reset."));
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(rows.join("\n"), 1, 0));
		this.options.ui.requestRender();
	}
}
