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
import { Spacer, Text } from "../tui-lib/index.js";
import type { Container, TUI } from "../tui-lib/index.js";
import type { CommandExecutionContext } from "./commands/types.js";

interface TelemetryViewOptions {
	chatContainer: Container;
	ui: TUI;
	showInfo: (message: string) => void;
	showError: (message: string) => void;
	onStatusChanged: (status: TelemetryStatus) => void;
}

type TelemetryAction = "status" | "on" | "off" | "reset";

export class TelemetryView {
	constructor(private readonly options: TelemetryViewOptions) {}

	handleTelemetryCommand(
		context: CommandExecutionContext<{ action?: TelemetryAction }>,
	): void {
		const action =
			context.parsedArgs?.action ?? this.inferAction(context.argumentText);
		switch (action) {
			case "on":
				setTelemetryRuntimeOverride(true, "enabled via /telemetry");
				this.handleStatusChange("Telemetry enabled for this session.");
				return;
			case "off":
				setTelemetryRuntimeOverride(false, "disabled via /telemetry");
				this.handleStatusChange("Telemetry disabled for this session.");
				return;
			case "reset":
				setTelemetryRuntimeOverride(null, undefined);
				this.handleStatusChange("Telemetry settings reset to environment.");
				return;
			default:
				this.renderStatus(getTelemetryStatus());
		}
	}

	private inferAction(argumentText: string): TelemetryAction {
		const arg = argumentText.trim().toLowerCase();
		if (arg === "on" || arg === "enable") {
			return "on";
		}
		if (arg === "off" || arg === "disable") {
			return "off";
		}
		if (arg === "reset" || arg === "default") {
			return "reset";
		}
		return "status";
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
