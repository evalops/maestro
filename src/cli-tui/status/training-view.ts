import { Spacer, Text } from "@evalops/tui";
import type { Container, TUI } from "@evalops/tui";
import {
	badge,
	heading,
	labeledValue,
	muted,
	separator,
} from "../../style/theme.js";
import {
	type TrainingStatus,
	getTrainingStatus,
	optIntoTraining,
	optOutOfTraining,
	resetTrainingRuntimeOverride,
} from "../../training.js";
import type { CommandExecutionContext } from "../commands/types.js";

interface TrainingViewOptions {
	chatContainer: Container;
	ui: TUI;
	showInfo: (message: string) => void;
	showError: (message: string) => void;
	onStatusChanged: (status: TrainingStatus) => void;
}

type TrainingAction = "status" | "on" | "off" | "reset";

export class TrainingView {
	constructor(private readonly options: TrainingViewOptions) {}

	handleTrainingCommand(
		context: CommandExecutionContext<{ action?: TrainingAction }>,
	): void {
		const action =
			context.parsedArgs?.action ?? this.inferAction(context.argumentText);
		switch (action) {
			case "on":
				optIntoTraining("enabled via /training");
				this.handleStatusChange(
					"Training data may be used for provider training.",
				);
				return;
			case "off":
				optOutOfTraining("disabled via /training");
				this.handleStatusChange("Training opt-out enabled for this session.");
				return;
			case "reset":
				resetTrainingRuntimeOverride();
				this.handleStatusChange(
					"Training preference reset to provider defaults.",
				);
				return;
			default:
				this.renderStatus(getTrainingStatus());
		}
	}

	private inferAction(argumentText: string): TrainingAction {
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
		const status = getTrainingStatus();
		this.options.onStatusChanged(status);
		this.options.showInfo(message);
		this.renderStatus(status);
	}

	private renderStatus(status: TrainingStatus): void {
		const rows: string[] = [];
		const stateBadge =
			status.preference === "opted-out"
				? badge("state", "opted-out", "warn")
				: status.preference === "opted-in"
					? badge("state", "opted-in", "success")
					: badge("state", "provider", "info");
		const reasonBadge = badge("reason", status.reason);
		rows.push(heading("Training data"));
		rows.push([stateBadge, reasonBadge].join(separator()));
		if (status.flagValue) {
			rows.push(labeledValue("Flag", status.flagValue));
		}
		if (status.runtimeOverride) {
			const detail = status.overrideReason
				? `${status.runtimeOverride} (${status.overrideReason})`
				: status.runtimeOverride;
			rows.push(labeledValue("Override", detail));
		}
		rows.push(muted("Use /training on, /training off, or /training reset."));
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(rows.join("\n"), 1, 0));
		this.options.ui.requestRender();
	}
}
